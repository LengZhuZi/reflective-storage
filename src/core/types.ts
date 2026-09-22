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
}

export interface TokenBudget {
  /** 本次注入允许占用的 token 上限。 */
  maxTokens: number;
  /** 预留：调用方可以指定必须优先注入的记忆。 */
  pinnedIds?: string[];
}

/** 检索策略选择（J6）。 */
export type Strategy = "vector" | "keyword" | "tree" | "time" | "hybrid";
