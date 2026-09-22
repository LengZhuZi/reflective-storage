/**
 * 治理层自检：J14b 兜底路由（置信度分级 + 作用域只许收窄）与 J14c 用户可见理由。
 *
 * 跑法：node tests/governance.ts
 * 不碰数据库、不联网：这里是纯函数。
 *
 * 为什么这条性质要用断言钉死：作用域判断错的方向不对称。放宽了，一条项目内的
 * 步骤会出现在别的项目里（§15 原则 6 说这是长期记忆最大的坑）；收窄了，只是少
 * 看见几条。所以低置信时只允许朝窄的方向动。
 */

import assert from "node:assert/strict";

const {
  routeFallback, narrowerScope, resolveScope, userVisibleReason,
  AUTO_CONFIDENCE, REVIEW_CONFIDENCE,
} = await import("../src/core/governance.ts");

// ------------------------------------------------------------ 置信度分级（§6 的表）
assert.equal(routeFallback(0.99), "auto");
assert.equal(routeFallback(0.81), "auto");
assert.equal(routeFallback(0.8), "auto", "0.8 是「直接执行」的下界");
assert.equal(routeFallback(0.79), "rule");
assert.equal(routeFallback(0.5), "rule", "0.5 是「规则复核」的下界");
assert.equal(routeFallback(0.49), "user");
assert.equal(routeFallback(0), "user");
assert.ok(AUTO_CONFIDENCE === 0.8 && REVIEW_CONFIDENCE === 0.5);
console.log("✓ 置信度分级和 §6 的表一致");

// ------------------------------------------------------------ 宽窄只有一种序
assert.equal(narrowerScope("session", "project"), "session");
assert.equal(narrowerScope("project", "global"), "project");
assert.equal(narrowerScope("global", "session"), "session");
assert.equal(narrowerScope("project", "project"), "project");
console.log("✓ 作用域宽窄：session < project < global");

// ------------------------------------------------------------ 高置信：原样采用
const sure = resolveScope("global", 0.99, "project");
assert.equal(sure.scope, "global", "置信度够高就不该被动过");
assert.equal(sure.route, "auto");
assert.equal(resolveScope("session", 0.85, "global").scope, "session", "高置信的窄作用域也要原样采用");

// ------------------------------------------------------------ 低置信：只许收窄
// 实测过的形状：引擎说 global 但只有 0.53，规则档说 project。
const shaky = resolveScope("global", 0.53, "project");
assert.equal(shaky.scope, "project", "0.53 的 global 必须收窄，否则一条项目步骤会跑去别的项目");
assert.equal(shaky.route, "rule");
assert.match(shaky.note, /收窄/);

const veryShaky = resolveScope("global", 0.2, "project");
assert.equal(veryShaky.scope, "project");
assert.equal(veryShaky.route, "user", "低于 0.5 走保守处理（Phase 1 没有 UI，所以是收窄 + 留痕）");
assert.equal(resolveScope("project", 0.3, "global").scope, "project", "保守策略也绝不把作用域放宽");

// 引擎本来就选了窄的，规则说宽的：仍然取窄
const alreadyNarrow = resolveScope("session", 0.6, "global");
assert.equal(alreadyNarrow.scope, "session");
assert.match(alreadyNarrow.note, /一致/);
console.log("✓ 作用域只许收窄：0.53 的 global 收窄、0.2 的 global 也收窄，放宽永远不发生");

// ------------------------------------------------------------ J14c 一句人话
assert.equal(userVisibleReason({ stage: "write", action: "keep", route: "auto", status: "ok" }), "记住了这条（引擎判断）");
assert.match(userVisibleReason({ stage: "write", action: "keep", route: "rule", status: "ok" }), /规则复核/);
assert.equal(userVisibleReason({ stage: "write", action: "skip" }), "没记：判断它不值得长期保留");
assert.equal(userVisibleReason({ stage: "write", action: "noise" }), "没记：太短或只是确认");
assert.equal(userVisibleReason({ stage: "recall", action: "inject" }), "这次用上了库里的旧记忆");
assert.equal(userVisibleReason({ stage: "recall", action: "skip" }), "这次没用上旧记忆");
assert.equal(userVisibleReason({ stage: "governance", action: "delete" }), "按你的要求删掉了这条");

// 降级必须说出来：用户分不清「没记」和「系统死了」就永远修不了（§6.2）
assert.match(userVisibleReason({ stage: "write", action: "keep", status: "unavailable" }), /降级/);
assert.match(userVisibleReason({ stage: "recall", action: "skip", status: "degraded" }), /降级/);
assert.ok(!userVisibleReason({ stage: "recall", action: "skip", status: "ok" }).includes("降级"), "正常时不许乱喊降级");
console.log("✓ J14c 模板：一句人话，降级另说");

console.log("\n全部通过");
