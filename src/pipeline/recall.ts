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
import { DEFAULT_RECALL_WEIGHTS, type RecallWeights } from "../config.ts";
import type { JevAdapter } from "../jev/adapter.ts";
import { MAX_CANDIDATES } from "../jev/adapter.ts";
import type { JudgeMeta } from "../jev/types.ts";
import { DEFAULT_RELEVANCE_THRESHOLD } from "../jev/types.ts";
import { embed } from "../embed/encoder.ts";
import {
  addTrace, allTreePaths, distinctTopics, listInScope, markAccessed, memoriesByTopic, recordRecall,
  searchByKeyword, searchByVector, type OpenedDb,
} from "../storage/db.ts";
import { pathCandidates } from "./tree.ts";
import { bigramCoverage, bigrams } from "../jev/rule.ts";
import { buildInjectionBlock, fitBudget } from "./inject.ts";

/** J7 之后的相关性阈值。每个引擎的分数尺度不同，所以实际用的是 adapter.relevanceThreshold。 */
export const RELEVANCE_THRESHOLD = DEFAULT_RELEVANCE_THRESHOLD;

/** 每一路各取多少条再合并，合并后再压到 MAX_CANDIDATES。可用 recall.perSourceLimit 调。 */
const PER_SOURCE_LIMIT = 50;

/**
 * 压到 20 条时的**每路保底名额**。
 *
 * 为什么不能只按一个分数排序取前 20：库里同主题、措辞几乎一样的记忆（改口、转述、不同时间的
 * 同一条约定）会挤成一坨，它们的向量分数只差零点几；一个扁平的 preScore 排序会让这一坨互相
 * 挤，把**真正该被看见的那条**（比如刚记的、或字面对得上的）挤到 20 名之外 —— J7 根本没机会
 * 看到它。所以先给每一路保底名额，再用 preScore 补满：宁可牺牲一点排序纯度，也不让某一路
 * 整体消失。
 */
const QUOTA: ReadonlyArray<[Source, number]> = [["vector", 8], ["topic", 5], ["cross", 4], ["path", 3], ["keyword", 3]];

/**
 * 短于这个长度就不值得花一次召回（"继续"、"好"）。
 *
 * 为什么不是 §10.4 写的 15：真跑 pi 时一条 8 个字的问句（「提交要按什么拆？」）
 * 被挡住，整段会话一条记忆都没搭上 —— 而 §10.4 的第一条规则是「首轮直接走完整召回」，
 * 长度只能用来挡「没有内容」的输入（那些还有 NOISE 正则告着），不能把短问句也一起挡掉。
 */
const MIN_PROMPT = 6;

export type Source = "vector" | "keyword" | "scope" | "topic" | "path" | "cross";

/** 候选池的一项：同一个 id 被多路召回时合并到一条。 */
interface Candidate {
  memory: MemoryNode;
  sources: Set<Source>;
  /** 向量余弦，没走到这一路就是 0。只用来排序，不当阈值（§13.2）。 */
  vectorSim: number;
}

/** 上层路由的结果：要不要去别的项目找、限不限主题。 */
export interface RouteHint {
  projectId?: string;
  topic?: string;
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
  /** §10.2 的混合排序权重。不给就用默认（偏向 JEV 判断）。 */
  weights?: RecallWeights;
  /** 每一路召回各取多少条（默认 50）。 */
  perSourceLimit?: number;
  /**
   * 上层路由（§10.6）。给了就在 gather 之前问一次引擎「这次提到哪个别的项目/主题」，
   * 命中的那层去捞候选（跨项目 = 第七路）。不给 = 只按老办法（本地主题匹配）。
   */
  route?: {
    enabled: boolean;
    /** 别的项目：id + 一句话线索（注册表里的主题/最近标题）。 */
    projects: Array<{ id: string; hint: string }>;
    topics: string[];
  };
  /** 按 id 打开别的项目库（调用方负责缓存与关闭）。跨项目引用/写入都走它。 */
  openForeign?: (projectId: string) => OpenedDb | null;
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

/**
 * 提问里提到这个主题了吗。纯查表，不是语义判断：
 *   - 主题名本身出现在提问里（「认证那套」）；
 *   - 或者提问的二字组有一大半落在主题名里（「提交流程怎么走」对上主题「提交流程」）。
 * 命中就多捞一路候选，命中错了也不致命 —— J7 会筛。
 */
export function mentionsTopic(query: string, topic: string): boolean {
  if (!topic) return false;
  if (query.includes(topic)) return true;
  const t = bigrams(topic);
  if (t.size === 0) return false;
  const q = bigrams(query);
  let hit = 0;
  for (const g of q) if (t.has(g)) hit++;
  return hit / t.size >= 0.5;
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

/** 候选生成只需要这两个库和当前会话。 */
export interface CandidateDeps {
  projectDb: OpenedDb;
  globalDb: OpenedDb;
  session: SessionInfo;
  limit?: number;
  perSourceLimit?: number;
  openForeign?: (projectId: string) => OpenedDb | null;
}

async function gather(query: string, deps: CandidateDeps, route: RouteHint = {}): Promise<Map<string, Candidate>> {
  const pool = new Map<string, Candidate>();
  const per = deps.perSourceLimit ?? PER_SOURCE_LIMIT;

  // 向量那一路只生成候选。实测命中与无关的余弦间隔只有 0.046（§13.2），
  // 靠它自己定阈值不可靠，排名交给 J7。
  try {
    const qv = await embed(query);
    for (const [m, dist] of searchByVector(deps.projectDb, qv, per)) {
      remember(pool, m, "vector", similarity(dist));
    }
    for (const [m, dist] of searchByVector(deps.globalDb, qv, per)) {
      remember(pool, m, "vector", similarity(dist));
    }
  } catch {
    // 向量层可缺：编码器加载不了就少一路语义候选，其他路照跑。原则 2：向量层可重建。
  }

  for (const m of searchByKeyword(deps.projectDb, query, per)) remember(pool, m, "keyword");
  for (const m of searchByKeyword(deps.globalDb, query, per)) remember(pool, m, "keyword");

  // 同主题那一路上：**只有当提问里出现了某个已知主题的名字**（或它的二字组基本覆盖了
  // 提问）才走。这不是语义判断，是查表 —— 判断谁是相关的仍然是 J7 的活，
  // 这里只负责多捞一批候选（候选生成宁可多捞，排名才交给引擎）。
  try {
    const topics = [...distinctTopics(deps.projectDb), ...distinctTopics(deps.globalDb)];
    const hitTopics = topics.filter((t) => mentionsTopic(query, t)).slice(0, 3);
    for (const t of hitTopics) {
      for (const m of memoriesByTopic(deps.projectDb, t, per)) remember(pool, m, "topic");
      for (const m of memoriesByTopic(deps.globalDb, t, per)) remember(pool, m, "topic");
    }
  } catch {
    // 主题那一路只是加分项：查不到就少一路候选，不影响其他路
  }

  // 上层路由命中的主题（JEV 判的，比本地二字组匹配准）
  if (route.topic) {
    for (const m of memoriesByTopic(deps.projectDb, route.topic, per)) remember(pool, m, "topic");
    for (const m of memoriesByTopic(deps.globalDb, route.topic, per)) remember(pool, m, "topic");
  }

  // 跨项目那一路（第七路）：只有在**引擎判定这次提问是关于那个项目**时才会打开它的库。
  // 打开别人的库是「门禁」层面的事，所以这里的触发条件必须是显式的语义判断，
  // 不能靠本地字符串猜。候选回来之后还要过 J14a 的适用性判断（见 judgeRelevance）。
  if (route.projectId && deps.openForeign) {
    try {
      const foreign = deps.openForeign(route.projectId);
      if (foreign) for (const m of listInScope(foreign, "project", route.projectId, per)) remember(pool, m, "cross");
    } catch {
      // 打不开就当没有这一路
    }
  }

  // 路径那一路（第六路）：提问里出现文件路径（`login.ts`、`src/backend/auth`）时，
  // 把该子树下的记忆捞进来。只认「像路径的东西」，中文自然语言不会误触发，所以不需要引擎判。
  try {
    for (const m of pathCandidates(deps.projectDb, query, allTreePaths(deps.projectDb), per)) remember(pool, m, "path");
    for (const m of pathCandidates(deps.globalDb, query, allTreePaths(deps.globalDb), per)) remember(pool, m, "path");
  } catch {
    // 路径这一路只是加分项：查不到就少一路候选
  }

  // 作用域内全部 + 近期：listInScope 就是 ORDER BY created_at DESC，
  // 所以「树遍历」和「时间过滤」是同一趟查询，不重复扫库（§10.1 的两路）。
  // session 作用域单独取一次，因为它的 scope_id 是会话而不是项目。
  for (const m of listInScope(deps.projectDb, "project", deps.session.projectId, per)) remember(pool, m, "scope");
  for (const m of listInScope(deps.projectDb, "session", deps.session.sessionId, per)) remember(pool, m, "scope");
  for (const m of listInScope(deps.globalDb, "global", null, per)) remember(pool, m, "scope");

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
function preScore(c: Candidate, now: number, query: string): number {
  const lexical = bigramCoverage(query, c.memory.content + " " + (c.memory.summary ?? ""));
  return 0.3 * c.vectorSim
    + 0.25 * lexical                            // 字面对得上：一堆近似记忆里唯一能分开它们的本地信号
    + 0.1 * (c.sources.has("keyword") ? 1 : 0)
    + 0.15 * (c.sources.has("topic") || c.sources.has("path") ? 1 : 0)   // 主题/路径命中：确定性的分组
    + 0.1 * (c.sources.has("cross") ? 1 : 0)                             // 跨项目命中：引擎明确说了才可能有
    + 0.15 * c.memory.importance
    + 0.05 * recency(c.memory, now);
}

/**
 * §10.2 混合排序。默认权重把最大的一项给 JEV relevance —— 它是唯一真的看过 query 的
 * 那一项。权重可配（DESIGN §10.2 说的「权重可配置，默认偏向 JEV 判断」）。
 */
function finalScore(relevance: number, c: Candidate, now: number, w: RecallWeights): number {
  return w.relevance * relevance
    + w.vector * c.vectorSim
    + w.topic * (c.sources.has("topic") ? 1 : 0)
    + w.importance * c.memory.importance
    + w.recency * recency(c.memory, now);
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

/**
 * 合并后的排序 + 门禁 + 压到 limit 条。召回和写入两条路共用同一套口径。
 * `query` 只用于算字面覆盖（粗筛里唯一对中文有效的本地信号）。
 */
function rank(pool: Map<string, Candidate>, session: SessionInfo, limit: number, now: number, query: string): Candidate[] {
  // 门禁：默认只放当前作用域的。**例外**是「跨项目」那一路 —— 它的前提是引擎明确说了
  // 「这次问的是那个项目」（§10.6），放进来之后还要过 J14a 的适用性判断，最后才可能注入。
  const all = [...pool.values()].filter((c) => inScope(c.memory, session) || c.sources.has("cross"));
  const score = (c: Candidate) => preScore(c, now, query);
  const seen = new Set<string>();
  const picked: Candidate[] = [];
  // 先按路保底（每路内部按 preScore 排），再按 preScore 补满。
  for (const [source, quota] of QUOTA) {
    const lane = all.filter((c) => c.sources.has(source)).sort((a, b) => score(b) - score(a));
    for (const c of lane.slice(0, quota)) {
      if (seen.has(c.memory.id)) continue;
      seen.add(c.memory.id);
      picked.push(c);
    }
  }
  for (const c of [...all].sort((a, b) => score(b) - score(a))) {
    if (picked.length >= limit) break;
    if (seen.has(c.memory.id)) continue;
    seen.add(c.memory.id);
    picked.push(c);
  }
  return picked.sort((a, b) => score(b) - score(a)).slice(0, limit);
}

/**
 * 候选生成：多路召回 → 合并去重 → 作用域门禁 → 压到 limit 条。
 *
 * 写入路径也用它 —— J3 要的是「跟这条内容最相关的旧记忆」，而不是「最近入库的 20 条」。
 * 用「最近 20 条」有两个后果：一条 200 条之前的矛盾记忆永远进不了候选（冲突检测失灵），
 * 而且每次写入都无脑把那 20 条塞进 state 白花 token。另外这里会把 global 库也拉进来 ——
 * 原来候选只查项目库，global 记忆从来没参与过冲突判断。
 */
export async function recallCandidates(query: string, deps: CandidateDeps): Promise<MemoryNode[]> {
  const pool = await gather(query, deps);
  return rank(pool, deps.session, deps.limit ?? MAX_CANDIDATES, Date.now(), query).map((c) => c.memory);
}

async function runRecall(query: string, deps: RecallDeps): Promise<RecallResult> {
  const now = Date.now();
  const limit = deps.limit ?? MAX_CANDIDATES;

  // 上层路由（§10.6）：一次调用里同时问「提到哪个别的项目」「是哪个主题」。
  // 只有它说了才去开别人的库、才按主题捞 —— 这两件事都算「门禁」层面，不能本地猜。
  const route: RouteHint = {};
  if (deps.route?.enabled) {
    try {
      const j = await deps.adapter.judgeRoute(query, {
        projects: deps.route.projects,
        topics: deps.route.topics,
        currentProject: deps.session.projectId,
      });
      route.projectId = [...j.projects][0];
      route.topic = [...j.topics][0];
      addTrace(deps.projectDb, {
        stage: "recall", gate: "J5-route", action: route.projectId || route.topic ? "keep" : "skip",
        reason: `项目=${route.projectId ?? "当前"} 主题=${route.topic ?? "不限"}`,
        status: j.meta.status, fallbackUsed: j.meta.fallbackUsed, latencyMs: j.meta.latencyMs,
      });
    } catch {
      // 路由失败就当没路由（保守：只在当前项目、不限主题）
    }
  }

  const pool = await gather(query, deps, route);

  // 已注入过的先删：这些 id 不重复判断也不重复付费（§8.3）
  for (const id of deps.session.injectedIds) pool.delete(id);

  const candidates = rank(pool, deps.session, limit, now, query);

  if (candidates.length === 0) {
    return { candidates: [], injected: [], status: "ok", detail: "库里没有命中" };
  }

  const j7 = await deps.adapter.judgeRelevance(query, candidates.map((c) => c.memory), {
    projectId: deps.session.projectId,
  });
  // J14a：被边界判断挡下的直接剔除（不是低分 —— 低分在降级时会被阈值放行，见 types.ts）。
  const blocked = j7.blocked ?? new Set<string>();
  if (blocked.size) {
    addTrace(deps.projectDb, {
      stage: "governance", gate: "J14a", action: "block",
      reason: `${blocked.size} 条 global 记忆判定为不适用于当前项目（${deps.session.projectId}）`,
      status: j7.meta.status,
    });
  }
  const scored = candidates
    .filter((c) => !blocked.has(c.memory.id))
    .map((c) => {
      const relevance = j7.relevance.get(c.memory.id) ?? 0;
      return { memory: c.memory, relevance, score: finalScore(relevance, c, now, deps.weights ?? DEFAULT_RECALL_WEIGHTS) };
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
    reason: `合并去重 ${pool.size} → 候选 ${candidates.length}${blocked.size ? `（J14a 挡下 ${blocked.size}）` : ""} → 过阈值 ${passed.length}`,
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
    block: buildInjectionBlock(picked.map((r) => r.memory), deps.session.projectId),
  };
}
