/**
 * 治理层（DESIGN.md §4 的 J14b / J14c，§6 的置信度分级，§11 的作用域优先）。
 *
 * J14b 兜底路由：判断分了置信度，就别让所有判断一视同仁地执行。
 *   > 0.8        直接执行
 *   0.5 – 0.8    规则二次确认 —— 只对**作用域**有意义：作用域是可收窄的
 *   < 0.5        保守策略（Phase 1 没有 UI，所以是收窄 + 留痕，不是弹窗）
 *
 * J14c 用户可见理由：一句人话。写进 reflection_traces.user_visible 和 judgment
 * 两个一直空着的列，`/memory why` 用它回答「为什么记住」。
 *
 * 一条安全性质写在这里：**作用域只许收窄，不许放宽**。
 * 引擎说 global 但只有 0.53 的置信度时，宽的那个选择会把一条项目内的步骤带去
 * 别的项目（§15 原则 6：跨项目污染是长期记忆最大的坑），而收窄只是少看见几条。
 * 不对称的代价，所以不对称地处理。
 *
 * 这一层不调用判断引擎：路由本身就是「不信任某一次判断」时做的事。
 */

import type { MemoryScope } from "./types.ts";

/** 判断引擎的置信度分级（§6 的表）。 */
export const AUTO_CONFIDENCE = 0.8;
export const REVIEW_CONFIDENCE = 0.5;

export type FallbackRoute = "auto" | "rule" | "user";

/** 从窄到宽。保守策略取更靠前的那个。 */
const SCOPE_WIDTH: readonly MemoryScope[] = ["session", "project", "global"];

export function routeFallback(confidence: number): FallbackRoute {
  if (confidence >= AUTO_CONFIDENCE) return "auto";
  if (confidence >= REVIEW_CONFIDENCE) return "rule";
  return "user";
}

export function narrowerScope(a: MemoryScope, b: MemoryScope): MemoryScope {
  return SCOPE_WIDTH.indexOf(a) <= SCOPE_WIDTH.indexOf(b) ? a : b;
}

export interface ResolvedScope {
  scope: MemoryScope;
  route: FallbackRoute;
  /** 一句人话，写进 trace 的 judgment 列。 */
  note: string;
}

/**
 * 作用域的兜底路由。`fallback` 是规则档的判断（ruleScope），它永远是一个具体值：
 * 引擎不确定时至少还有个「更窄」的参照。
 */
export function resolveScope(choice: MemoryScope, confidence: number, fallback: MemoryScope): ResolvedScope {
  const route = routeFallback(confidence);
  if (route === "auto") {
    return { scope: choice, route, note: `作用域采用引擎判断（置信度 ${confidence.toFixed(2)}）` };
  }
  const narrowed = narrowerScope(choice, fallback);
  return {
    scope: narrowed,
    route,
    note: narrowed === choice
      ? `作用域与规则判断一致（引擎置信度只有 ${confidence.toFixed(2)}）`
      : `引擎置信度只有 ${confidence.toFixed(2)}，作用域收窄到 ${narrowed}`,
  };
}

const ROUTE_LABEL: Record<FallbackRoute, string> = {
  auto: "引擎判断",
  rule: "规则复核",
  user: "保守处理",
};

/** J14c：模板拼接的一句人话（§4 的兜底就是「模板拼接」，不调引擎）。 */
export function userVisibleReason(t: {
  stage: string;
  action: string;
  status?: string | null;
  route?: FallbackRoute;
  reason?: string | null;
}): string {
  const degraded = t.status === "unavailable" || t.status === "degraded";
  const core = (() => {
    if (t.stage === "write") {
      if (t.action === "keep" || t.action === "stored") return `记住了这条（${t.route ? ROUTE_LABEL[t.route] : "引擎判断"}）`;
      if (t.action === "skip") return "没记：判断它不值得长期保留";
      return "没记：太短或只是确认";
    }
    if (t.stage === "recall") {
      return t.action === "inject" ? "这次用上了库里的旧记忆" : "这次没用上旧记忆";
    }
    if (t.stage === "governance") {
      return t.action === "delete" ? "按你的要求删掉了这条" : `治理动作：${t.action}`;
    }
    if (t.stage === "lifecycle") return `生命周期动作：${t.action}`;
    return `${t.stage}/${t.action}`;
  })();
  // 降级必须说出来（§6.2）：用户分不清「没记」和「系统死了」就永远修不了。
  return degraded ? `${core}；判断引擎降级` : core;
}
