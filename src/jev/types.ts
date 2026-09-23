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
  /**
   * J4：主题。只在**已有主题**里选（或 none），引擎不生成新词 ——
   * 给记忆起名是生成，§15 原则 1 不让引擎干这件事。
   */
  topic: string | null;
  /**
   * 这条记忆属于**别的项目**时给它的 projectId（跨项目写入）。
   * 写进那个项目的库，并在两边都留痕 —— 硬规则不是「不许跨项目写」，
   * 而是「不许在原库里悄悄改」（用户明确指出：发现后端问题就得能改）。
   */
  ownerProject?: string | null;
  /** J3 选中的旧记忆 id（relation === "none" 时为空）。 */
  targetId: string | null;
}

/** 召回闸的输出。 */
export interface RecallJudgment {
  /** J7：memoryId -> 相关性 0–1。 */
  relevance: Map<string, number>;
  /**
   * J14a：被边界判断挡下的 memoryId（§11.1）。现在是两类：global 记忆在当前项目不适用、
   * 别的项目的记忆在当前项目不适用（上层路由点过名的除外）。它是**屏蔽**而不是低分 ——
   * 低分会走阈值，而阈值在降级时不生效（fail-degraded），那正好把该挡的放过来了。
   * 所以单独一条通道。
   */
  blocked: Set<string>;
}

/**
 * J16 主动召回：用户没问，但这条记忆他现在就该知道吗。
 * 引擎说「值得提醒」的 id 集合 —— 提醒只给用户看（notify），不往上下文里塞（§8.3）。
 */
export interface ProactiveJudgment {
  remind: Set<string>;
}

/** J15：事后核对用引擎判「这条注入的记忆有没有被回复用上」。 */
export interface CitationJudgment {
  cited: Set<string>;
}

/** 注入闸（J8）的输出。 */

/**
 * J16 主动召回：用户没问，但这条记忆他现在就该知道吗。
 * 引擎说「值得提醒」的 id 集合 —— 提醒只给用户看（notify），不往上下文里塞（§8.3）。
 */
export interface ProactiveJudgment {
  remind: Set<string>;
}

/** J15：事后核对用引擎判「这条注入的记忆有没有被回复用上」。 */
export interface CitationJudgment {
  cited: Set<string>;
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
