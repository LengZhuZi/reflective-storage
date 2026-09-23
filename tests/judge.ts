/**
 * 判断引擎自检：规则档、OpenAI 兼容档、档位选择、阈值跟着引擎走。
 *
 * 跑法：node tests/judge.ts
 * 不联网：OpenAI 兼容档用假的 fetch，验证的是「编译问题 → 解析答案 → 失败姿态」这条链，
 * 不是任何模型的判断质量（那是手工实测的，结论记在 DESIGN.md §4.1）。
 *
 * 为什么要有这个自检：判断引擎是这套东西唯一的可替换件。它一旦被写死成某一家 API，
 * 「别人也能用」就不成立 —— 所以这里钉的是「换 client 不改流程」这件事本身。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reflect-judge-"));
process.env.REFLECTIVE_HOME = tmp;
for (const k of ["TYPESAFE_API_KEY", "REFLECTIVE_JUDGE_PROVIDER", "REFLECTIVE_JUDGE_API_KEY", "REFLECTIVE_JUDGE_BASE_URL", "REFLECTIVE_JUDGE_MODEL", "REFLECTIVE_JUDGE_THRESHOLD"]) {
  delete process.env[k];
}

const { createJudgeAdapter, createJevAdapter } = await import("../src/jev/adapter.ts");
const { loadConfig } = await import("../src/config.ts");

// 判断模型是硬要求：没有 key 就不给 adapter（调用方拒绝启动）
const noKey = loadConfig();
assert.equal(noKey.judge.provider, "jev");
assert.equal(noKey.judge.ready, false, "没有 key → 不可用");
assert.match(noKey.judge.problems.join(" "), /没有判断模型的 key/);
assert.throws(() => createJudgeAdapter(noKey.judge), /没有可用的判断模型/, "缺模型要抛，不许退化成别的档位");

process.env.TYPESAFE_API_KEY = "test";
const withKey = loadConfig();
assert.equal(withKey.judge.ready, true);
assert.equal(withKey.judge.problems.length, 0);
const adapter = createJudgeAdapter(withKey.judge, { fetchImpl: async () => new Response(JSON.stringify({ model: "t", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 }) });
assert.ok(adapter, "有 key 就建得出来（真正调用失败时的降级由 adapter 内部按 §6.1 处理）");
delete process.env.TYPESAFE_API_KEY;

console.log("全部通过");
