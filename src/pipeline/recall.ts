/**
 * 召回流程编排（DESIGN.md §10.1 / §8.2 / §8.3）。
 *
 * 顺序：多路召回（向量 + FTS5 + 作用域内全部 + 近期）→ 合并去重
 *      → 作用域硬过滤 → 压到 MAX_CANDIDATES → J7 重排 → 阈值过滤
 *      → J8 注入决策 → 按 token 预算截断 → 组装注入块
 *
 * 三条不能违反的约束：
 *
 *  1. 多路召回的目标是把候选**压到 20 条以内**，不是召回越多越好。实测（§4.1）：
 *     20 条时相关 0.85/0.70、无关 0.03/0.02，区分度最好；68 条时最该命中的只给 0.51，
 *     排名会糊。JEV 是高精度过滤器，不是大海捞针器。
 *  2. 已注入过的 id 在调 JEV **之前**就从候选池删掉（§8.3）—— 不重复判断，不重复付费。
 *  3. 失败姿态是 fail-degraded（§6.1）：J7 挂了退回关键词排序并放行（少召回可以，
 *     一条不召回不行）；J8 挂了由 adapter 判成 skip，本会话就不注入。而且降级不能
 *     表现成「没有记忆」（§6.2）—— status 和 detail 必须原样传出去。
 */

import type { MemoryNode, SessionInfo, TokenBudget } from "../core/types.ts";
import type { JevAdapter } from "../jev/adapter.ts";
import { MAX_CANDIDATES } from "../jev/adapter.ts";
import type { JudgeMeta } from "../jev/types.ts";
import { DEFAULT_RELEVANCE_THRESHOLD } from "../jev/types.ts";
import { embed } from "../embed/encoder.ts";
import {
  addTrace, listInScope, markAccessed, recordRecall, searchByKeyword, searchByVector, type OpenedDb,
} from "../storage/db.ts";
import { buildInjectionBlock, fitBudget } from "./inject.ts";

/** J7 之后的相关性阈值。每个引擎的分数尺度不同，所以实际用的是 adapter.relevanceThreshold。 */
export const RELEVANCE_THRESHOLD = DEFAULT_RELEVANCE_THRESHOLD;

/** 每一路各取多少条再合并，合并后再压到 MAX_CANDIDATES。 */
const PER_SOURCE_LIMIT = 50;

/**
 * 短于这个长度就不值得花一次召回（"继续"、"好"）。
 *
 * 为什么不是 §10.4 写的 15：真跑 pi 时一条 8 个字的问句（「提交要按什么拆？」）
 * 被挡住，整段会话一条记忆都没搭上 —— 而 §10.4 的第一条规则是「首轮直接走完整召回」，
 * 长度只能用来挡「没有内容」的输入（那些还有 NOISE 正则告着），不能把短问句也一起挡掉。
 */
const MIN_PROMPT = 6;

export type Source = "vector" | "keyword" | "scope";

/** 候选池的一项：同一个 id 被多路召回时合并到一条。 */
interface Candidate {
  memory: MemoryNode;
  sources: Set<Source>;
  /** 向量余弦，没走到这一路就是 0。只用来排序，不当阈值（§13.2）。 */
  vectorSim: number;
}

export interface RecallDeps {
  projectDb: OpenedDb;
  globalDb: OpenedDb;
  adapter: JevAdapter;
  session: SessionInfo;
  /**
   * 不给预算 = 不做 J8 注入决策、不组装注入块（`memory_search` 工具走这条）。
   * 工具的职责是「把命中摆出来给人看」，注入才是「主动塞进上下文」。
   */
  budget?: TokenBudget;
  /** 候选上限，默认 MAX_CANDIDATES。 */
  limit?: number;
}

export interface Recalled {
  memory: MemoryNode;
  /** J7 的相关性，0–1。 */
  relevance: number;
  /** 综合排序分，权重见 §10.2，偏向 JEV 判断。 */
  score: number;
}

export interface RecallResult {
  /** 过了阈值的候选，按 score 降序。`memory_search` 的输出。 */
  candidates: Recalled[];
  /** J8 决定注入、且已按预算截断的。 */
  injected: Recalled[];
  /** J7 与 J8 里最差的三态。ok < degraded < unavailable（§6.2 降级必须可见）。 */
  status: JudgeMeta["status"];
  detail?: string;
  /** 组装好的注入块，injected 为空时是空串。 */
  block: string;
}

/**
 * §10.4 轻量预判：只负责「要不要花这次钱」，判断本身是 JEV 的活。
 *
 * 这里只留最确定的一条规则（输入太短）。另外两条（首轮必查、上一轮刚注入过）
 * 由调用方用 InjectionState 判断，不需要在这里重复。
 *
 * 跳过 ≠ 本会话不再注入：跳过时不打「已注入」标记，下一轮话够长还会查。
 */
export function worthRecalling(prompt: string): { ok: boolean; reason?: string } {
  if (prompt.replace(/\s+/g, "").length < MIN_PROMPT) {
    return { ok: false, reason: `输入太短（<${MIN_PROMPT} 个非空白字符）` };
  }
  return { ok: true };
}

/** sqlite-vec 的 vec0 默认是 L2 距离；向量已归一化，余弦 = 1 - d²/2。只用来排序。 */
function similarity(dist: number): number {
  return Math.max(0, 1 - (dist * dist) / 2);
}

function remember(pool: Map<string, Candidate>, m: MemoryNode, source: Source, vectorSim = 0): void {
  const hit = pool.get(m.id);
  if (hit) {
    hit.sources.add(source);
    if (vectorSim > hit.vectorSim) hit.vectorSim = vectorSim;
    return;
  }
  pool.set(m.id, { memory: m, sources: new Set([source]), vectorSim });
}

async function gather(query: string, deps: RecallDeps): Promise<Map<string, Candidate>> {
  const pool = new Map<string, Candidate>();

  // 向量那一路只生成候选。实测命中与无关的余弦间隔只有 0.046（§13.2），
  // 靠它自己定阈值不可靠，排名交给 J7。
  try {
    const qv = await embed(query);
    for (const [m, dist] of searchByVector(deps.projectDb, qv, PER_SOURCE_LIMIT)) {
      remember(pool, m, "vector", similarity(dist));
    }
    for (const [m, dist] of searchByVector(deps.globalDb, qv, PER_SOURCE_LIMIT)) {
      remember(pool, m, "vector", similarity(dist));
    }
  } catch {
    // 向量层可缺：编码器加载不了就少一路语义候选，其他路照跑。原则 2：向量层可重建。
  }

  for (const m of searchByKeyword(deps.projectDb, query, PER_SOURCE_LIMIT)) remember(pool, m, "keyword");
  for (const m of searchByKeyword(deps.globalDb, query, PER_SOURCE_LIMIT)) remember(pool, m, "keyword");

  // 作用域内全部 + 近期：listInScope 就是 ORDER BY created_at DESC，
  // 所以「树遍历」和「时间过滤」是同一趟查询，不重复扫库（§10.1 的两路）。
  // session 作用域单独取一次，因为它的 scope_id 是会话而不是项目。
  for (const m of listInScope(deps.projectDb, "project", deps.session.projectId, PER_SOURCE_LIMIT)) remember(pool, m, "scope");
  for (const m of listInScope(deps.projectDb, "session", deps.session.sessionId, PER_SOURCE_LIMIT)) remember(pool, m, "scope");
  for (const m of listInScope(deps.globalDb, "global", null, PER_SOURCE_LIMIT)) remember(pool, m, "scope");

  return pool;
}

/**
 * 作用域门禁（§11.2 / §11.3）。JEV 是建议，这行才是门禁：
 * 向量和关键词那两路直接把整个库捞出来了，没经过 listInScope，所以必须在这里
 * 统一挡一次。上一轮会话的 session 作用域记忆也不该进这次会话（§3.3）。
 */
function inScope(m: MemoryNode, session: SessionInfo): boolean {
  // listInScope 已经在 SQL 里挡了状态，向量和关键词那两路没有，所以这里补上：
  // 归档/已删除/被取代的记忆不该再被召回（§9.1）。
  if (m.state !== "active" && m.state !== "cold") return false;
  if (m.scope === "global") return true;
  if (m.scope === "project") return m.scopeId === session.projectId;
  return m.scopeId === session.sessionId;
}

/** 30 天没动过，时近性降到 0.5。 */
function recency(m: MemoryNode, now: number): number {
  const days = (now - (m.lastAccessed ?? m.createdAt)) / 86400000;
  return 1 / (1 + days / 30);
}

/**
 * 交给 J7 之前用来压候选的廉价分（§10.2 去掉 JEV 那一项，因为还没判）。
 * 关键词命中是 0/1，权重不能大：它只说明字面对上了，不代表语义相关。
 */
function preScore(c: Candidate, now: number): number {
  return 0.4 * c.vectorSim
    + 0.2 * (c.sources.has("keyword") ? 1 : 0)
    + 0.2 * c.memory.importance
    + 0.2 * recency(c.memory, now);
}

/** §10.2 混合排序。0.6 给 JEV：它是唯一真的看过 query 的那一项。 */
function finalScore(relevance: number, c: Candidate, now: number): number {
  return 0.6 * relevance
    + 0.15 * c.vectorSim
    + 0.15 * c.memory.importance
    + 0.1 * recency(c.memory, now);
}

const STATUS_RANK = { ok: 0, degraded: 1, unavailable: 2 } as const;

function worst(a: JudgeMeta["status"], b: JudgeMeta["status"]): JudgeMeta["status"] {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

export async function recallFlow(query: string, deps: RecallDeps): Promise<RecallResult> {
  const result = await runRecall(query, deps);
  // J15 轻量反馈：只记事实（召回了什么、注入了什么），不推断效果 ——
  // cited / user_feedback 在 Phase 1 编不出来，留空比编一个强（§7.1）。
  recordRecall(deps.projectDb, {
    sessionId: deps.session.sessionId,
    query,
    recalledIds: result.candidates.map((r) => r.memory.id),
    injectedIds: result.injected.map((r) => r.memory.id),
  });
  return result;
}

async function runRecall(query: string, deps: RecallDeps): Promise<RecallResult> {
  const now = Date.now();
  const limit = deps.limit ?? MAX_CANDIDATES;
  const pool = await gather(query, deps);

  // 已注入过的先删：这些 id 不重复判断也不重复付费（§8.3）
  for (const id of deps.session.injectedIds) pool.delete(id);

  const candidates = [...pool.values()]
    .filter((c) => inScope(c.memory, deps.session))
    .sort((a, b) => preScore(b, now) - preScore(a, now))
    .slice(0, limit);

  if (candidates.length === 0) {
    return { candidates: [], injected: [], status: "ok", detail: "库里没有命中" };
  }

  const j7 = await deps.adapter.judgeRelevance(query, candidates.map((c) => c.memory));
  const scored = candidates
    .map((c) => {
      const relevance = j7.relevance.get(c.memory.id) ?? 0;
      return { memory: c.memory, relevance, score: finalScore(relevance, c, now) };
    })
    .sort((a, b) => b.score - a.score);

  // 阈值只在 J7 正常时生效。降级时规则分本来就偏低，卡阈值等于把 fail-degraded
  // 变成 fail-closed；召回该「少召几条」，不是「一条都不召」（§6.1）。
  // 阈值取自引擎自己：JEV 的 0.7 搬到规则引擎或本地小模型上会把候选全卡光。
  const threshold = deps.adapter.relevanceThreshold ?? DEFAULT_RELEVANCE_THRESHOLD;
  const passed = j7.meta.status === "ok"
    ? scored.filter((r) => r.relevance >= threshold)
    : scored;

  addTrace(deps.projectDb, {
    stage: "recall", gate: "J7", action: passed.length ? "keep" : "skip",
    reason: `合并去重 ${pool.size} → 候选 ${candidates.length} → 过阈值 ${passed.length}`,
    status: j7.meta.status, fallbackUsed: j7.meta.fallbackUsed, latencyMs: j7.meta.latencyMs,
  });

  if (!deps.budget) {
    return { candidates: passed, injected: [], status: j7.meta.status, detail: j7.meta.detail, block: "" };
  }

  const j8 = await deps.adapter.judgeInjection(query, passed.map((r) => r.memory), deps.budget);
  const picked = fitBudget(
    passed.filter((r) => j8.decisions.get(r.memory.id) === "inject"),
    deps.budget.maxTokens,
  );

  addTrace(deps.projectDb, {
    stage: "recall", gate: "J8", action: picked.length ? "inject" : "skip",
    reason: `J8 选中 ${[...j8.decisions.values()].filter((d) => d === "inject").length} → 预算内 ${picked.length} 条`,
    status: j8.meta.status, fallbackUsed: j8.meta.fallbackUsed, latencyMs: j8.meta.latencyMs,
  });

  if (picked.length > 0) {
    // 真正用上了才算访问：衰减（§9.2）看的就是这个。global 记忆存在另一个库里。
    markAccessed(deps.projectDb, picked.filter((r) => r.memory.scope !== "global").map((r) => r.memory.id));
    markAccessed(deps.globalDb, picked.filter((r) => r.memory.scope === "global").map((r) => r.memory.id));
  }

  return {
    candidates: passed,
    injected: picked,
    status: worst(j7.meta.status, j8.meta.status),
    detail: j7.meta.detail ?? j8.meta.detail,
    block: buildInjectionBlock(picked.map((r) => r.memory)),
  };
}
