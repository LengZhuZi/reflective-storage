/**
 * JEV 判断层的类型。
 *
 * 规格见 DESIGN.md §4（能力矩阵）、§5（接口）、§6（置信度与兜底）。
 *
 * 一条铁律：JEV 只回答问题，不生成内容。所有返回值都是类型化结果 + 置信度，
 * 记忆原文永远由本地系统控制。见 DESIGN.md §15 原则 1。
 */

export interface NoulResult {
  /** 问题为真的概率，0–1。 */
  noul: number;
}

export interface ChoiceResult<T extends string = string> {
  choice: T;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreResult {
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}

/** 判断的元信息。失败姿态见 DESIGN.md §6.1，落库到 reflection_traces。 */
export interface JudgeMeta {
  /** 能力编号，如 "J1"。 */
  gate: string;
  /** none = JEV 正常返回；rule = 走了 RuleAdapter；llm/user 预留。 */
  fallbackUsed: "none" | "rule" | "llm" | "user";
  /** ok = 判断可信；degraded = 降级结果；unavailable = JEV 不可用。 */
  status: "ok" | "degraded" | "unavailable";
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  /** 失败时的原因，用于 /memory 展示，不能静默。见 DESIGN.md §6.2。 */
  detail?: string;
}

export type Judged<T> = T & { meta: JudgeMeta };

/** 写入闸（J1+J2+J3 合并为一次 API 调用，见 DESIGN.md §5.1）。 */
export interface WriteJudgment {
  worthKeeping: NoulResult;
  type: ChoiceResult;
  scope: ChoiceResult;
  /** J3：与前一条候选旧记忆的关系。 */
  relation: ChoiceResult;
  /** J3 选中的旧记忆 id（relation === "none" 时为空）。 */
  targetId: string | null;
}

/** 召回闸的输出。 */
export interface RecallJudgment {
  /** J7：memoryId -> 相关性 0–1。 */
  relevance: Map<string, number>;
}

/** 注入闸（J8）的输出。 */
export interface InjectionJudgment {
  /** J8：memoryId -> inject / skip。 */
  decisions: Map<string, "inject" | "skip">;
}

/**
 * 相关性阈值的缺省值（JEV 的标定值，见 DESIGN.md §4.1 / §10.1）。
 * 每个判断引擎的分数尺度不同，所以真正生效的是 `JevAdapter.relevanceThreshold`，
 * 这个常量只在适配器没给的时候兜底。
 */
export const DEFAULT_RELEVANCE_THRESHOLD = 0.7;
