/** 核心数据模型。规格见 DESIGN.md §3 与 §7。 */

export type MemoryType =
  | "fact"        // 事实："项目用 Rust"
  | "preference"  // 偏好："用户喜欢简洁回答"
  | "event"       // 事件："上次改了登录模块"
  | "procedure"   // 过程："部署流程 A→B→C"
  | "emotion"     // 情绪："用户对方案不满"
  | "relation";   // 关系："模块 X 依赖 Y"

export const MEMORY_TYPES: readonly MemoryType[] = [
  "fact", "preference", "event", "procedure", "emotion", "relation",
];

/** 作用域。global 永远对所有项目可见，project 只在自己的库里，session 随会话结束衰减。 */
export type MemoryScope = "global" | "project" | "session";

/** 生命周期状态，见 DESIGN.md §9.1。 */
export type MemoryState = "active" | "cold" | "archived" | "superseded" | "deleted";

/**
 * 记忆的来源。
 *
 *   user  用户自己敲的话 —— 事实源，trust 1.0，永不降级。
 *   agent 模型自己说的话 —— 可能是推断，也可能是被工具结果验证过的结论。
 *
 * 为什么要分开：模型写的错东西存进库，下个会话会作为「既有记忆」注入回来，
 * 模型看见自己上次的话，更容易当既成事实再引一遍。来源标出来，这条环路才有断点。
 */
export type MemoryOrigin = "user" | "agent";

/**
 * trust 的上限。**不是 1.0** —— 这是刻意的。
 *
 * agent 来源的记忆靠「用户后来在同一个话题上说话又没推翻它」往上升，但永远升不到
 * 用户原话那一档。理由不是「用户可能没说」：是 trust 高到一定程度，模型就不再回头
 * 检查这条了，它变成公理。封顶是为了让复核这件事一直有理由发生。
 */
export const TRUST_CAP = 0.9;

/** trust 低于它就在注入时带标记（见 pipeline/inject.ts）。 */
export const TRUST_MARK_BELOW = 0.8;

/** 记忆之间的语义关系，由 J3 判定。 */
export type Relation = "none" | "extends" | "supersedes" | "contradicts" | "depends_on";

export interface MemoryNode {
  id: string;
  content: string;
  summary: string | null;
  type: MemoryType;
  scope: MemoryScope;
  scopeId: string | null;
  topic: string | null;
  importance: number;
  decayScore: number;
  state: MemoryState;
  createdAt: number;
  lastAccessed: number | null;
  accessCount: number;
  source: string | null;
  /** 来源，见 MemoryOrigin。 */
  origin: MemoryOrigin;
  /**
   * 可信度 0..1。跟 importance **正交**：importance 管衰减和排序，trust 管注入时怎么措辞。
   *
   * 为什么不拿它当召回过滤器：用户真问到那个话题时，低 trust 的记忆照样相关、照样该出现 ——
   * 只不过要带着「这是推断，未经确认」的标记出现，让模型有理由不是无条件信它。
   * 当过滤器用的话，恰恰在最需要它出现的时候把它藏了。
   */
  trust: number;
  metadata: string | null;
}

export interface MemoryStats {
  accessCount: number;
  daysSinceLastAccess: number;
}

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  projectId: string;
  /** 本会话已注入过的记忆 id —— 判断时要先排除，见 DESIGN.md §8.3。 */
  injectedIds: Set<string>;
  /**
   * 上一次注入时用的提问。
   *
   * J5 靠它判断「这次是不是同一个话题」—— 是的话上下文里已经有了，不必再插一遍。
   * 这件事必须由判断引擎做，不能让本地二字组规则兼职（那是内容判断，不是机械约束）。
   */
  lastInjectedQuery?: string | null;
}

export interface TokenBudget {
  /** 本次注入允许占用的 token 上限。 */
  maxTokens: number;
  /** 预留：调用方可以指定必须优先注入的记忆。 */
  pinnedIds?: string[];
}

/** 检索策略选择（J6）。 */
export type Strategy = "vector" | "keyword" | "tree" | "time" | "hybrid";
