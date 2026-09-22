/**
 * 生命周期（DESIGN.md §9，J9–J13）。
 *
 * 纯后台，不阻塞任何东西（§6.1 fail-silent：这一层出错就跳过本轮，不抛给会话）。
 * 没有定时任务 —— pi 扩展没有 scheduler，所以挂在 session_start 上跑一次，且有上限。
 *
 * 实现范围（Phase 2 第一片上）：
 *   J10 衰减  纯公式，不调引擎（§9.2 明确说了）
 *   J9  巩固  访问频繁 + 分数高 → 提 importance（规则的兜底口径：访问次数）
 *   J12 遗忘  只归档，**不删除**。删是不可逆的，本地版让用户自己用 /memory forget
 *   J13 复活  新会话的提问命中归档记忆的主题时放回 active
 *
 * 还没做：J11 合并（需要引擎级的语义判断；J3 的 supersedes 已经覆盖了最常见的情形）。
 * 这里不做「近似查重」，理由见 DESIGN §8.5：bigram 覆盖率会误伤相似词不同项目的记忆。
 *
 * 阈值和 λ 是**可调的标定值**，不是真理：真实使用里长什么样，得看衰减曲线跑一段时间。
 */

import type { MemoryNode, MemoryType } from "../core/types.ts";
import type { OpenedDb } from "../storage/db.ts";
import { addTrace, listByStates, updateLifecycle } from "../storage/db.ts";
import { bigrams } from "../jev/rule.ts";

/** 每种记忆的衰减参数。λ = 每天的自然衰减率，半衰期 = ln2/λ。 */
export const DECAY: Record<MemoryType, { lambda: number; weight: number }> = {
  fact: { lambda: 0.005, weight: 1.0 },        // 半衰期约 139 天
  preference: { lambda: 0.005, weight: 1.0 },
  procedure: { lambda: 0.01, weight: 0.8 },    // 约 69 天
  relation: { lambda: 0.01, weight: 0.8 },
  event: { lambda: 0.02, weight: 0.7 },        // 约 35 天
  emotion: { lambda: 0.1, weight: 0.3 },       // 约 7 天
};

/** active → cold 的分界线。 */
export const COLD_BELOW = 0.2;
/** cold → archived 的分界线，再加「太久没用」。 */
export const ARCHIVE_BELOW = 0.05;
export const ARCHIVE_AFTER_DAYS = 90;
/** 高重要性的记忆不过滤（§11）：宁可多留一条，也别把用户明确在意的事藏起来。 */
export const KEEP_IMPORTANCE = 0.85;

export interface LifecycleOptions {
  now?: number;
  /** 一次最多处理多少条（§9.3：避免拖慢启动）。 */
  maxRows?: number;
}

export interface LifecycleSummary {
  scanned: number;
  promoted: number;
  decayed: number;
  archived: number;
  errors: string[];
}

/** J10：§9.2 的公式，纯算术。 */
export function decayScore(m: Pick<MemoryNode, "type" | "importance" | "accessCount" | "createdAt" | "lastAccessed">, now: number): number {
  const last = m.lastAccessed ?? m.createdAt;
  const days = Math.max(0, (now - last) / 86400000);
  const p = DECAY[m.type] ?? DECAY.event;
  return m.importance * Math.exp(-p.lambda * days) * (1 + Math.log(1 + m.accessCount)) * p.weight;
}

const daysSince = (m: MemoryNode, now: number) => (now - (m.lastAccessed ?? m.createdAt)) / 86400000;

/**
 * 会话开始时跑一次的懒生命周期。返回摘要；**不抛异常**（fail-silent，§6.1），
 * 出错就记在 errors 里，调用方想展示就展示。
 */
export function runLifecycle(o: OpenedDb, opts: LifecycleOptions = {}): LifecycleSummary {
  const now = opts.now ?? Date.now();
  const maxRows = opts.maxRows ?? 200;
  const summary: LifecycleSummary = { scanned: 0, promoted: 0, decayed: 0, archived: 0, errors: [] };

  let rows: MemoryNode[];
  try {
    rows = listByStates(o, ["active", "cold"], maxRows);
  } catch (e) {
    summary.errors.push(`读取失败：${(e as Error).message}`);
    return summary;
  }

  for (const m of rows) {
    try {
      summary.scanned++;
      const score = decayScore(m, now);
      let state = m.state;
      let importance = m.importance;

      // J9 巩固：不只算分，访问够多就把它抬成长期记忆（§9.3「访问频繁 + 高分 → 晋升」）。
      if (m.accessCount >= 3 && score >= 0.8 && importance < 1) {
        importance = Math.min(1, importance + 0.1);
        summary.promoted++;
        addTrace(o, {
          memoryId: m.id, stage: "lifecycle", gate: "J9", action: "promote",
          reason: `访问 ${m.accessCount} 次，importance ${m.importance.toFixed(2)} → ${importance.toFixed(2)}`,
          status: "ok", confidence: importance,
        });
      }

      // J10 + J12：先降温，够冷再归档。高重要性的永远不归档（§11）。
      if (score < COLD_BELOW) {
        state = "cold";
        if (score < ARCHIVE_BELOW && daysSince(m, now) > ARCHIVE_AFTER_DAYS && importance < KEEP_IMPORTANCE) {
          state = "archived";
        }
      } else if (m.state === "cold") {
        state = "active";   // 又用上了：缓存过但最近碰到
      }

      if (state === m.state && importance === m.importance) continue;
      updateLifecycle(o, m.id, { decayScore: score, state, importance });
      summary.decayed++;
      if (state === "archived") {
        summary.archived++;
        addTrace(o, {
          memoryId: m.id, stage: "lifecycle", gate: "J12", action: "archive",
          reason: `${daysSince(m, now).toFixed(0)} 天没用到，衰减到 ${score.toFixed(3)}`,
          status: "ok", confidence: score,
        });
      }
    } catch (e) {
      // 单条失败不影响其他条：这一层纯后台，不该因为一条坏数据停摆。
      summary.errors.push(`处理 ${m.id} 失败：${(e as Error).message}`);
    }
  }
  return summary;
}

export interface ResurrectionSummary {
  resurrected: number;
  ids: string[];
}

/**
 * J13 复活：新会话的提问命中归档记忆的主题就放回 active。
 *
 * 阈值故意松（命中 query 三成以上的二字组，且至少 2 个）—— 复活的代价只是多一条
 * 候选，J7 会把它筛掉；反过来，把一条用户其实还需要的老记忆永久埋掉，代价大得多。
 */
export function resurrectFor(o: OpenedDb, query: string, opts: LifecycleOptions & { limit?: number } = {}): ResurrectionSummary {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 3;
  const out: ResurrectionSummary = { resurrected: 0, ids: [] };
  const q = bigrams(query);
  if (q.size < 2) return out;

  let rows: MemoryNode[];
  try {
    rows = listByStates(o, ["archived"], opts.maxRows ?? 200);
  } catch (e) {
    out.ids.push(`读取失败：${(e as Error).message}`);
    return out;
  }

  const scored = rows
    .map((m) => {
      const hit = bigrams(m.content + " " + (m.summary ?? ""));
      let shared = 0;
      for (const g of q) if (hit.has(g)) shared++;
      return { m, shared, coverage: shared / q.size };
    })
    .filter((s) => s.shared >= 2 && s.coverage >= 0.3)
    .sort((a, b) => b.coverage - a.coverage)
    .slice(0, limit);

  for (const { m, coverage } of scored) {
    try {
      updateLifecycle(o, m.id, { decayScore: decayScore(m, now), state: "active" });
      o.db.prepare(`UPDATE memories SET last_accessed = ? WHERE id = ?`).run(now, m.id);
      addTrace(o, {
        memoryId: m.id, stage: "lifecycle", gate: "J13", action: "resurrect",
        reason: `新会话话题命中（覆盖 ${(coverage * 100).toFixed(0)}%），放回 active`,
        status: "ok", confidence: coverage,
      });
      out.resurrected++;
      out.ids.push(m.id);
    } catch (e) {
      out.ids.push(`复活 ${m.id} 失败：${(e as Error).message}`);
    }
  }
  return out;
}
