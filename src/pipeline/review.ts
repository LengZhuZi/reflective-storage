/**
 * 待确认队列（DESIGN.md §6 的「0.5 以下交给用户确认」+ §9.3 的合并）。
 *
 * 判断引擎说「这两条像是同一件事」或者「这两条可能冲突」，但**不确定**的时候，
 * 正确动作不是替用户拍，也不是装作没看见 —— 是问。§6 的表把 <0.5 那一档写成
 * 「交给用户确认」：引擎判不了就让用户判，代价只是多问一句，收益是不让污染记忆沉淀。
 *
 * 两条来源：
 *   merge    两条措辞不同但看着是同一件事（§9.1 的合并，J11）
 *   conflict 引擎给的取代/冲突关系置信度低于阈值（§6 的 <0.5 档）
 *
 * 为什么近似查重在这里可以松：它只是**提议**，不动任何数据。之前否掉近似自动查重
 * 的理由是「相似词不同项目」会误合并、丢真记忆（丢记忆 > 存噪声）；但提议错了
 * 用户一票否决，代价为零。同一个判据，自动执行是错的，当建议是对的。
 *
 * 没有 UI 的场景（print 模式）不弹窗：留在队列里，/memory review 随时能过一遍。
 */

import type { MemoryNode } from "../core/types.ts";
import {
  addRelation, addTrace, enqueueReview, getMemory, insertMemory, pendingReviews, resolveReview,
  setState, type ReviewRow,
} from "../storage/db.ts";
import { longestSharedRun } from "./feedback.ts";

export type ReviewKind = "merge" | "conflict" | "topic" | "scope";

/** 用户可选的处置。保留两条是最安全的默认。 */
export const RESOLUTIONS = ["keep_both", "keep_new", "keep_old"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export const RESOLUTION_LABELS: Record<Resolution, string> = {
  keep_both: "保留两条（并存）",
  keep_new: "用新的取代旧的",
  keep_old: "保留旧的，把新的标为已取代",
};

export function labelToResolution(label: string): Resolution {
  const hit = (Object.entries(RESOLUTION_LABELS) as Array<[Resolution, string]>).find(([, l]) => l === label);
  return hit ? hit[0] : "keep_both";
}

/** 作用域放宽时给用户的两个选项（J14b：不确定就问用户，本地版不走 LLM 复核）。 */
export const SCOPE_KEEP = "保持项目级（更窄）";
export const SCOPE_WIDEN = "放宽到全局（以后哪个项目都能用）";

/**
 * J14b 的 0.5–0.8 那一档：引擎说 global 但不够确信，我们已经按更窄（project）存了。
 *
 * 收窄是安全方向，但代价是「本该跟着用户走的偏好被锁进一个项目」——
 * 问一句就能纠正，所以问。**不静默收窄**：用户看不见的判断等于没做（§6.2）。
 */
export function queueScopeWidening(o: OpenedDb, memory: MemoryNode, engineChoice: string): ReviewItem[] {
  if (memory.scope !== "project" || engineChoice !== "global") return [];
  const options = [SCOPE_KEEP, SCOPE_WIDEN];
  const question = `引擎觉得这条该是全局的（不够确信），我先按项目级存了：\n${clip(memory.content, 80)}\n要放宽到全局吗？`;
  const id = enqueueReview(o, { kind: "scope", memoryId: memory.id, otherId: null, question, options });
  return id ? [{ id, kind: "scope", memoryId: memory.id, otherId: null, question, options }] : [];
}

/**
 * 放宽到全局：**跨库**，所以是「在全局库重写一条 + 把原来那条标成已取代」，
 * 不是原地改 scope —— 原地改成 global 只会让它在本项目可见、别的项目看不见。
 */
export function widenScopeToGlobal(projectDb: OpenedDb, globalDb: OpenedDb, memoryId: string): string {
  const m = getMemory(projectDb, memoryId);
  if (!m) return "那条记忆已经不在了";
  const moved = insertMemory(globalDb, {
    content: m.content, type: m.type, scope: "global", scopeId: null,
    importance: m.importance, summary: m.summary, topic: m.topic, source: m.source,
  });
  setState(projectDb, m.id, "superseded");
  addTrace(globalDb, { memoryId: moved.id, stage: "governance", gate: "J14b", action: "widen", reason: "用户确认放宽到全局" });
  addTrace(projectDb, { memoryId: m.id, stage: "governance", gate: "J14b", action: "superseded", reason: `已复制到全局库（${moved.id}）` });
  return `已放宽到全局库（新 id ${moved.id.slice(0, 8)}）`;
}

/** 看同一件事的判据：连续 6 个以上二字组（≈7 字以上原样片段）。只用来提议。 */
export const SAME_THING_RUN = 6;

export interface ReviewItem {
  id: string;
  kind: ReviewKind;
  memoryId: string;
  otherId: string | null;
  question: string;
  options: string[];
}

const clip = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * 写入落库之后判断要不要排队问用户。
 * `relation` / `relationConfidence` 来自 J3，`candidates` 是同一次给 J3 的候选（含 global）。
 */
export function queueAfterWrite(
  o: OpenedDb,
  memory: MemoryNode,
  candidates: readonly MemoryNode[],
  relation: { choice: string; confidence: number },
): ReviewItem[] {
  const out: ReviewItem[] = [];
  const options = Object.values(RESOLUTION_LABELS);

  // §6：低置信度的取代/冲突关系交用户确认
  if ((relation.choice === "supersedes" || relation.choice === "contradicts") && relation.confidence < 0.5) {
    const other = candidates.find((c) => c.id !== memory.id) ?? null;
    const id = enqueueReview(o, {
      kind: "conflict",
      memoryId: memory.id,
      otherId: other?.id ?? null,
      question: `引擎不太确定（${relation.confidence.toFixed(2)}）新记的这条和已有的是不是冲突，怎么处理？`,
      options,
    });
    if (id) out.push({ id, kind: "conflict", memoryId: memory.id, otherId: other?.id ?? null, question: "", options });
  }

  // J11：看着就是同一件事 → 提议合并（只提议，不动数据）。
  // 只挑最像的那一个：一次问五个「要不要合并」比不问更烦，而且选谁都一样。
  const best = candidates
    .filter((c) => c.id !== memory.id)
    .map((c) => ({ c, run: longestSharedRun(memory.content, c.content) }))
    .filter((x) => x.run >= SAME_THING_RUN)
    .sort((a, b) => b.run - a.run)[0];
  if (best) {
    const question = `这两条看起来是同一件事：\n  A（刚记的）${clip(memory.content)}\n  B（已有的）${clip(best.c.content)}\n要合并吗？`;
    const id = enqueueReview(o, { kind: "merge", memoryId: memory.id, otherId: best.c.id, question, options });
    if (id) out.push({ id, kind: "merge", memoryId: memory.id, otherId: best.c.id, question, options });
  }
  return out;
}

/**
 * J4 的起名环节：引擎在**已有主题**里挑不出合适的（topic=null）时，问用户要不要起一个。
 *
 * 为什么是用户起名而不是引擎生成：给记忆起名是**生成文本**，§15 原则 1 明确不让引擎干。
 * 而主题树的价值只在「同一个人会反复用到同一批主题」时才成立 —— 用户起的名字天然稳定，
 * 引擎每次生成的名字会碎成一地同义词（"数据迁移"/"数据库迁移"/"DB 迁移"）。
 *
 * 只在够重要的记忆上问（importance 偏低的多半是一次性事件，不值得占用户一次输入）。
 */
export const TOPIC_ASK_IMPORTANCE = 0.7;

export function queueTopicNaming(o: OpenedDb, memory: MemoryNode, existingTopics: readonly string[]): ReviewItem[] {
  if (memory.topic) return [];
  if (memory.importance < TOPIC_ASK_IMPORTANCE) return [];
  const options = [...existingTopics.slice(0, 6), "先不起主题"];
  const question = `要不要给这条记忆起个主题？（方便以后按主题找回）\n${clip(memory.content, 80)}`;
  const id = enqueueReview(o, { kind: "topic", memoryId: memory.id, otherId: null, question, options });
  return id ? [{ id, kind: "topic", memoryId: memory.id, otherId: null, question, options }] : [];
}

export function pendingItems(o: OpenedDb, limit = 20): ReviewRow[] {
  return pendingReviews(o, limit);
}

/** 记下裁决并执行。两条都只改状态 + 记关系，不硬删 —— 反悔还有救。 */
export function applyResolution(o: OpenedDb, item: ReviewRow, resolution: Resolution): string {
  const memoryId = String(item.memory_id);
  const otherId = item.other_id == null ? null : String(item.other_id);

  if (resolution === "keep_new" && otherId) {
    setState(o, otherId, "superseded");
    addRelation(o, memoryId, otherId, "supersedes", 1);
  } else if (resolution === "keep_old" && otherId) {
    setState(o, memoryId, "superseded");
    addRelation(o, otherId, memoryId, "supersedes", 1);
  }
  resolveReview(o, String(item.id), resolution);

  if (resolution === "keep_both") return "并存：两条都留着";
  return resolution === "keep_new" ? "用新的取代了旧的" : "保留了旧的，新的标为已取代";
}
