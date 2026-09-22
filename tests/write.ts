/**
 * 写入流程自检：预筛、脱敏、落库、作用域分流、失败姿态。
 *
 * 跑法：node tests/write.ts
 * 不联网：adapter 用假的，验证的是流程和落库，不是 JEV 的质量。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reflect-write-"));
process.env.REFLECTIVE_HOME = tmp;

const { openDb, countMemories, listInScope } = await import("../src/storage/db.ts");
const { writeFlow, worthEvaluating, redact, KEEP_THRESHOLD } = await import("../src/pipeline/write.ts");

const project = openDb(path.join(tmp, "proj.db"));
const global = openDb(path.join(tmp, "global.db"));
const session = { sessionId: "s1", cwd: tmp, projectId: "P", injectedIds: new Set<string>() };

/** 假 adapter：只实现 writeFlow 用到的那一个方法。 */
function fakeAdapter(worth: number, opts: { scope?: "global" | "project" | "session"; relation?: string; fail?: boolean } = {}) {
  return {
    async judgeWrite() {
      return {
        worthKeeping: { noul: worth },
        type: { choice: "event", confidence: 0.9, probabilities: {} },
        scope: { choice: opts.scope ?? "project", confidence: 0.9, probabilities: {} },
        relation: { choice: opts.relation ?? "none", confidence: 0.8, probabilities: {} },
        targetId: null,
        meta: {
          gate: "J1+J2+J3",
          fallbackUsed: opts.fail ? "rule" : "none",
          status: opts.fail ? "unavailable" : "ok",
          latencyMs: 12,
        },
      };
    },
  } as never;
}

// ------------------------------------------------------------ 本地预筛
assert.equal(worthEvaluating("继续").ok, false);
assert.equal(worthEvaluating("好").ok, false);
assert.equal(worthEvaluating("OK").ok, false);
assert.equal(worthEvaluating("嗯嗯").ok, false);
assert.equal(worthEvaluating("短").ok, false);
assert.equal(worthEvaluating("这个项目的记忆系统要完全独立，不要复用 cognee").ok, true);
console.log("✓ 本地预筛挡掉短输入和纯确认（这一步免费，JEV 才是花钱的）");

// ------------------------------------------------------------ 脱敏
const dirty = "配置写到 sk-abcdefghijklmnop 里，apikey_TESTFIXTURE0000001 也是，password: hunter2";
const clean = redact(dirty);
assert.ok(!clean.includes("sk-abcdefghijklmnop"), "sk- 形态的密钥必须被洗掉");
assert.ok(!clean.includes("apikey_TESTFIXTURE0000001"), "apikey_ 形态的密钥必须被洗掉");
assert.ok(!clean.includes("hunter2"), "password: 后面的值必须被洗掉");
console.log("✓ 落盘前脱敏（记忆库会被注入到每一次对话里，凭据进去就洗不干净）");

// ------------------------------------------------------------ 正常写入
const r1 = await writeFlow(project, global, fakeAdapter(0.89), session, {
  userTexts: ["以后所有的数据库迁移脚本都用 Flyway，不要用 Liquibase"],
  context: "用户在讨论迁移工具",
});
assert.equal(r1.action, "stored");
assert.equal(countMemories(project), 1);
assert.equal(countMemories(global), 0, "项目作用域不该写进 global 库");
assert.equal(listInScope(project, "project", "P").length, 1);
console.log("✓ J1 判定值得 → 落进项目库");

// ------------------------------------------------------------ 不值得存
const r2 = await writeFlow(project, global, fakeAdapter(0.2), session, {
  userTexts: ["我在看一下这个文件的内容到底是什么"],
  context: "",
});
assert.equal(r2.action, "skipped");
assert.equal(countMemories(project), 1, "跳过不能落库");
// 跳过的决定也要留痕，否则 /memory 里看不出「为什么没记」
const traces = project.db.prepare(`SELECT action, status FROM reflection_traces WHERE action='skip'`).all();
assert.equal(traces.length, 1);
console.log("✓ 不值得存 → 只写 trace，不落库");

// ------------------------------------------------------------ 作用域分流
const r3 = await writeFlow(project, global, fakeAdapter(0.8, { scope: "global" }), session, {
  userTexts: ["我一般喜欢直接给结论，不要长篇解释"],
  context: "",
});
assert.equal(r3.action, "stored");
assert.equal(countMemories(global), 1, "global 作用域的偏好必须进 global 库");
assert.equal(countMemories(project), 1, "不能同时写进项目库");
console.log("✓ global 作用域分流到 global 库（跨项目偏好不该污染项目库）");

// ------------------------------------------------------------ 静默输入
const r4 = await writeFlow(project, global, fakeAdapter(0.89), session, {
  userTexts: ["继续"],
  context: "",
});
assert.equal(r4.action, "noise");
assert.equal(countMemories(project), 1, "「继续」不该落库");
console.log("✓ 「继续」在本地被挡掉，没花掉一次 JEV 调用");

// ------------------------------------------------------------ 失败姿态
const r5 = await writeFlow(project, global, fakeAdapter(0.75, { fail: true }), session, {
  userTexts: ["不对，应该改成用立面表示高度，不要再按海拔调明暗"],
  context: "",
});
assert.equal(r5.action, "stored", "fail-open：JEV 挂了也必须照存");
assert.equal(countMemories(project), 2);
const failTrace = project.db.prepare(`SELECT status, fallback_used FROM reflection_traces ORDER BY created_at DESC LIMIT 1`).get() as Record<string, unknown>;
assert.equal(failTrace.status, "unavailable");
assert.equal(failTrace.fallback_used, "rule");
assert.ok(failTrace !== undefined, "降级也必须留痕");
console.log("✓ 写入闸 fail-open 且留痕（status=unavailable, fallback=rule）");

// ------------------------------------------------------------ 只吃用户的话
const before = countMemories(project);
await writeFlow(project, global, fakeAdapter(0.9), session, {
  userTexts: ["把部署流程改成先备份再执行"],
  context: "assistant: 我执行了 cat /etc/passwd 得到 root:x:0:0 和 export TOKEN=abc123456",
});
const stored = project.db.prepare(`SELECT content FROM memories ORDER BY created_at DESC LIMIT 1`).get() as { content: string };
assert.ok(stored.content.includes("部署流程"), "应该只存用户说的那句");
assert.ok(!stored.content.includes("root:x:0:0"), "工具输出不能被写进记忆");
assert.ok(!stored.content.includes("abc123456"), "上下文里的 token 不能在落盘内容里");
assert.equal(countMemories(project), before + 1);
console.log("✓ 只消化用户自己的话，工具输出不入库");

// ------------------------------------------------------------ 断言常量
assert.ok(KEEP_THRESHOLD > 0.2 && KEEP_THRESHOLD < 0.86, "阈值必须落在实测的无关(0.2)和明确要求(0.86)之间");

project.close();
global.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n全部通过");
