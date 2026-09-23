/**
 * J15 轻量反馈的「事后核对」：这一轮注入的记忆，到底有没有被用上（DESIGN.md §4 / §7.1）。
 *
 * 为什么这个信号值钱：没有它，召回阈值、注入上限、J8 的松紧全是拍脑袋 —— 库里攒了
 * 几百条「注入了什么」，却不知道哪次真起了作用，就没法调。
 *
 * 为什么用「原文片段复用」而不是让引擎判：判一次要一次 API 调用，而这件事每轮都要做。
 * 引擎判「模型有没有用上这条记忆」的正确率也未必比字符串比对高多少。所以这里只认
 * 明确信号：回复里出现了该记忆的**连续 4 个以上二字组**（约 5 个字以上的原样片段）。
 *
 * 这必然漏掉「模型换了个说法」的情况 —— 所以它只当**下限**用：cited 标记的是确凿用上的，
 * 没标的只说明「没找到确凿证据」，不等于没用上。字段名保持 cited_ids，含义写在这里。
 */


import { longestSharedRun } from "../jev/rule.ts";
import type { JevAdapter } from "../jev/adapter.ts";
import type { MemoryNode } from "../core/types.ts";
import { addTrace, getMemory, latestRecallWithInjection, updateRecallOutcome, type OpenedDb } from "../storage/db.ts";

/** 连续命中的二字组个数下限。4 个 ≈ 5 个字以上的原样片段（规则档与兜底用同一口径）。 */
export const MIN_CITED_RUN = 4;

export { longestSharedRun };

export interface FeedbackOutcome {
  recalled: number;
  injected: number;
  cited: string[];
  /** 谁判的：引擎（准）还是字符串比对（下限，引擎不可用时的兜底）。 */
  by: "engine" | "heuristic" | "none";
  /** cited / injected，注入 0 条时是 null（没发生的事不该给分）。 */
  effectScore: number | null;
}

/**
 * 把「这一轮助手说了什么」对上「上一轮注入过什么」。
 * 找不到带注入的召回记录就直接返回空 —— 大多数轮次本来就没注入过。
 */
export async function closeFeedbackLoop(
  o: OpenedDb,
  sessionId: string,
  reply: string,
  adapter?: JevAdapter,
): Promise<FeedbackOutcome> {
  const empty: FeedbackOutcome = { recalled: 0, injected: 0, cited: [], by: "none", effectScore: null };
  // 没有回复就不做核对：空字符串跟谁都对不上，拿它去覆盖上一轮的核对结果等于报假账。
  // （真 pi 里 agent_end 总有助手消息，但重试/中断的轮次可能没有。）
  if (!reply.trim()) return empty;
  const log = latestRecallWithInjection(o, sessionId);
  if (!log) return empty;

  const injectedIds = JSON.parse(String(log.injected_ids)) as string[];
  const recalled = (JSON.parse(String(log.recalled_ids)) as string[]).length;
  const memories = injectedIds.map((id) => getMemory(o, id)).filter((m): m is MemoryNode => Boolean(m));

  // 有引擎就问引擎（准），没有或引擎不可用就退回字符串比对（下限）——
  // 两者必须能分开，所以 trace 里记下是谁判的（§6.2 的同一道理）。
  let cited: string[] = [];
  let by: FeedbackOutcome["by"] = "heuristic";
  let note = "";
  if (adapter && memories.length) {
    try {
      const j = await adapter.judgeCitations(reply, memories);
      if (j.meta.status === "ok") {
        cited = memories.filter((m) => j.cited.has(m.id)).map((m) => m.id);
        by = "engine";
      } else {
        note = `（引擎 ${j.meta.status}: ${j.meta.detail ?? ""}）`;
      }
    } catch (e) {
      note = `（引擎抛错: ${(e as Error).message.slice(0, 60)}）`;
    }
  }
  if (by === "heuristic") {
    cited = memories.filter((m) => longestSharedRun(m.content, reply) >= MIN_CITED_RUN).map((m) => m.id);
  }

  const effectScore = injectedIds.length === 0 ? null : cited.length / injectedIds.length;
  updateRecallOutcome(o, String(log.id), cited, effectScore);
  addTrace(o, {
    stage: "feedback", gate: "J15", action: "cite",
    reason: `${by === "engine" ? "引擎判定" : "字符串比对"}：注入 ${injectedIds.length} 条，确凿用上 ${cited.length} 条${note}`,
    status: by === "engine" ? "ok" : "degraded", confidence: effectScore,
  });
  return { recalled, injected: injectedIds.length, cited, by, effectScore };
}
