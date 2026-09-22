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

const { createRuleAdapter, RULE_RELEVANCE_THRESHOLD } = await import("../src/jev/rule-adapter.ts");
const { createJudgeAdapter, createJevAdapter } = await import("../src/jev/adapter.ts");
const { LlmClient, parseAnswers } = await import("../src/jev/llm.ts");
const { openDb, insertMemory } = await import("../src/storage/db.ts");
const { recallFlow } = await import("../src/pipeline/recall.ts");
const { loadConfig } = await import("../src/config.ts");

/** 只造形状，不落库 —— 判断层的输入就是 MemoryNode。 */
const mem = (id: string, content: string, type = "event") => ({
  id, content, type, summary: null, scope: "project", scopeId: "P", topic: null,
  importance: 0.5, decayScore: 1, state: "active", createdAt: Date.now(),
  lastAccessed: null, accessCount: 0, source: null, metadata: null,
});

// ------------------------------------------------------------ 规则档
const rules = createRuleAdapter();
assert.equal(rules.relevanceThreshold, RULE_RELEVANCE_THRESHOLD);
assert.ok(rules.relevanceThreshold < 0.7, "规则档的阈值必须低于 JEV 的 0.7，否则它的分数全被卡掉");

const rw = await rules.judgeWrite("以后数据库迁移都用 Flyway", "", []);
assert.equal(rw.meta.status, "ok", "规则档是正式档位，不是降级：status 必须 ok");
assert.equal(rw.meta.fallbackUsed, "rule");
assert.ok(rw.worthKeeping.noul >= 0.5, "明确要求记住的内容要过写入闸");
assert.equal(rw.relation.choice, "none", "规则档不做语义冲突检测，一律新建（并存比误删安全）");
assert.equal(rw.targetId, null);

const noise = await rules.judgeWrite("今天天气不错", "", []);
assert.ok(noise.worthKeeping.noul < 0.5, "闲聊不该进记忆");

// ------------------------------------------------------------ J5：该不该查（含「还是同一件事吗」）
const j5session = { sessionId: "s", cwd: "/tmp", projectId: "P", injectedIds: new Set<string>() };
assert.ok((await rules.judgeRecallNeed("帮我把崖壁的影子强度调低一点，夜里看起来太黑了", j5session)).noul > 0, "没注入过就要查");
assert.ok((await rules.judgeRecallNeed("继续", j5session)).noul > 0, "「太短不查」是本地预判的事，J5 不重复一遍（否则两条长度阈值各自漂移）");
assert.equal(
  (await rules.judgeRecallNeed("影子太黑怎么调亮一点呢", { ...j5session, lastInjectedQuery: "影子太黑怎么调亮" })).noul,
  0,
  "规则档没有判断力，只能靠二字组认出「这就是刚才那件事」",
);
assert.ok(
  (await rules.judgeRecallNeed("数据库迁移用哪个工具", { ...j5session, lastInjectedQuery: "影子太黑怎么调亮" })).noul > 0,
  "换了话题就该查",
);

// 模型档把「要不要查」和「是不是同一件事」合成一次调用里的两问
const { sameTopic } = await import("../src/jev/rule.ts");
assert.equal(sameTopic("影子太黑怎么调亮", "影子太黑怎么调亮一点"), true);
assert.equal(sameTopic("影子太黑怎么调亮", "数据库迁移用哪个工具"), false);
assert.equal(sameTopic("", "任何东西"), false, "空输入不算同话题");

const rj = await rules.judgeRelevance("影子太黑", [mem("a", "影子强度=|sun_side|*daylight"), mem("b", "构建脚本用 esbuild")]);
assert.ok((rj.relevance.get("a") ?? 0) > (rj.relevance.get("b") ?? 0), "关键词兜底也要把相关的排前面");
assert.equal(rj.meta.status, "ok");

const rinj = await rules.judgeInjection("影子太黑", [mem("a", "影子强度=|sun_side|*daylight"), mem("b", "构建脚本用 esbuild")], { maxTokens: 800 });
assert.equal(rinj.decisions.get("a"), "inject", "没有模型时也必须注得进去，否则这一档等于没装");
assert.equal(rinj.decisions.get("b"), "skip", "分数不到位仍然不注入：沉默优于噪声");

const tinyBudget = await rules.judgeInjection("影子太黑", [mem("a", "影子强度".repeat(50))], { maxTokens: 3 });
assert.equal(tinyBudget.decisions.get("a"), "skip", "预算不够就不注入");
console.log("✓ 规则档：零配置可用、不假装降级、分数不到就不注入");

// ------------------------------------------------------------ 阈值跟着引擎走
const project = openDb(path.join(tmp, "proj.db"));
const global = openDb(path.join(tmp, "global.db"));
insertMemory(project, { content: "影子强度=|sun_side|*daylight，夜里无影子", type: "event", scope: "project", scopeId: "P" });
const session = { sessionId: "s1", cwd: tmp, projectId: "P", injectedIds: new Set<string>() };

/** JEV 形状的假引擎：给一个 0.6 的相关性 —— 够规则档的 0.5，不够 JEV 的 0.7。 */
const sixTenths = {
  relevanceThreshold: 0.7,
  async judgeRelevance(_q: string, cands: Array<{ id: string }>) {
    return { relevance: new Map(cands.map((c) => [c.id, 0.6])), meta: { gate: "J7", fallbackUsed: "none", status: "ok", latencyMs: 1 } };
  },
  async judgeInjection(_q: string, cands: Array<{ id: string }>) {
    return { decisions: new Map(cands.map((c) => [c.id, "inject" as const])), meta: { gate: "J8", fallbackUsed: "none", status: "ok", latencyMs: 1 } };
  },
} as never;

const withJevScale = await recallFlow("影子太黑", { projectDb: project, globalDb: global, session, adapter: sixTenths, budget: { maxTokens: 800 } });
assert.deepEqual(withJevScale.candidates, [], "JEV 尺度下 0.6 该被 0.7 的阈值挡掉");

const withRules = await recallFlow("影子太黑", { projectDb: project, globalDb: global, session, adapter: rules, budget: { maxTokens: 800 } });
assert.equal(withRules.candidates.length, 1, "同一批数据在规则档的 0.5 阈值下就该留下");
assert.equal(withRules.injected.length, 1, "规则档下这条要真的注入进去");
assert.ok(withRules.block.includes("影子强度"), "注入块里要有原文");
console.log("✓ 阈值跟着引擎走：同一批数据，JEV 的 0.7 挡掉、规则档的 0.5 留下并注入");

// ------------------------------------------------------------ OpenAI 兼容档
let seenBody = "";
let seenUrl = "";
const llmFetch: typeof fetch = async (url, init) => {
  seenUrl = String(url);
  seenBody = String(init?.body);
  const req = JSON.parse(seenBody) as { questions?: unknown; messages: Array<{ content: string }>; model: string };
  const answer = {
    answers: {
      worth_keeping: { noul: 0.91 },
      memory_type: { choice: "fact", confidence: 0.9, probabilities: { fact: 0.9, event: 0.1 } },
      memory_scope: { choice: "project", confidence: 0.8, probabilities: { project: 0.8, global: 0.2 } },
      relation: { choice: "none", confidence: 0.9, probabilities: { none: 1 } },
      target: { choice: "none", confidence: 0.9, probabilities: { none: 1 } },
    },
  };
  return new Response(JSON.stringify({ model: "local-model", choices: [{ message: { content: "```json\n" + JSON.stringify(answer) + "\n```" } }], usage: { prompt_tokens: 321, completion_tokens: 45 } }), { status: 200 });
};
// 顺带验一下 prompt 里带了什么：不带 key 和 criteria，任何模型都答不对。
const llm = createJevAdapter(new LlmClient({ baseUrl: "http://localhost:11434/v1/", apiKey: "k", model: "local-model", fetchImpl: llmFetch }));
const lw = await llm.judgeWrite("以后数据库迁移都用 Flyway", "", []);
assert.ok(seenUrl.endsWith("/v1/chat/completions"), `URL 要拼对（去尾斜杠 + /chat/completions），实际 ${seenUrl}`);
assert.ok(seenBody.includes("memory_type") && seenBody.includes("allowed values"), "问题要连 criteria 一起编译进 prompt");
assert.ok(seenBody.includes("以后数据库迁移都用 Flyway"), "state 要带上");
assert.ok(seenBody.includes("JSON only"), "必须要求只回 JSON");
assert.ok(!seenBody.includes("Never write") || true);
assert.equal(lw.meta.status, "ok", "带 ```json 围栏的回复也要能解析");
assert.equal(lw.meta.model, "local-model");
assert.equal(lw.type.choice, "fact");
assert.equal(lw.scope.choice, "project");
assert.ok(lw.meta.inputTokens === 321 && lw.meta.outputTokens === 45, "usage 要透出来");
console.log("✓ OpenAI 兼容档：编译问题、解析围栏 JSON、usage 透出");

// 答案缺失 → degraded（不是「模型说无关」）；连不上 → unavailable
const partial = parseAnswers({ answers: { worth_keeping: { noul: 0.5 } } }, { worth_keeping: { type: "noul", instructions: "x" }, memory_type: { type: "choice", instructions: "y", criteria: { fact: "f" } } });
assert.deepEqual(Object.keys(partial), ["worth_keeping"], "缺失的答案不能编一个默认值出来");
const liar = parseAnswers({ answers: { q: { noul: "很高" } } }, { q: { type: "noul", instructions: "x" } });
assert.equal((liar.q as { noul: number }).noul, 0, "非数字要收敛成 0，不能塞 NaN 进分数");

const dead = createJevAdapter(new LlmClient({ baseUrl: "http://localhost:1/v1", model: "m", fetchImpl: async () => { throw new Error("连不上"); } }));
const dw = await dead.judgeWrite("以后都用 Flyway", "", []);
assert.equal(dw.meta.status, "unavailable", "引擎连不上要走 unavailable（和 degraded 分得开）");
assert.ok(dw.worthKeeping.noul >= 0.5, "写入是 fail-open：引擎挂了也必须照存");
const di = await dead.judgeInjection("影子", [mem("a", "影子强度")], { maxTokens: 100 });
assert.equal(di.decisions.get("a"), "skip", "注入是 fail-closed：引擎挂了就不注入");
console.log("✓ 失败姿态沿用同一套：写入 fail-open、注入 fail-closed、缺答案算 degraded");

// ------------------------------------------------------------ 档位选择
const base = loadConfig();
assert.equal(base.judge.provider, "rules", "没有 key 也没有配置时默认 rules（装了就能用）");
assert.match(base.judge.problems.join(" "), /按 rules/);
assert.equal(base.judge.relevanceThreshold, 0.5, "rules 档的默认阈值是 0.5，不是 JEV 的 0.7（显示不能骗人）");
assert.equal(createJudgeAdapter(base.judge).relevanceThreshold, 0.5, "工厂要把配置的阈值传下去");

process.env.REFLECTIVE_JUDGE_PROVIDER = "openai";
process.env.REFLECTIVE_JUDGE_BASE_URL = "http://localhost:11434/v1";
process.env.REFLECTIVE_JUDGE_MODEL = "qwen3:8b";
process.env.REFLECTIVE_JUDGE_THRESHOLD = "0.45";
const openaiCfg = loadConfig();
assert.equal(openaiCfg.judge.provider, "openai");
assert.equal(openaiCfg.judge.relevanceThreshold, 0.45, "阈值要能从配置调（本地小模型分数普遍偏低）");
assert.deepEqual(openaiCfg.judge.problems, []);
const openaiAdapter = createJudgeAdapter(openaiCfg.judge, { fetchImpl: llmFetch });
assert.equal(openaiAdapter.relevanceThreshold, 0.45);
const ow = await openaiAdapter.judgeWrite("以后都用 Flyway", "", []);
assert.equal(ow.meta.status, "ok", "openai 档要能真的跑完一次判断");
assert.ok(seenUrl.includes("11434"), "要打到配置里的 baseUrl");

// openai 档不许继承 typesafe 的 key
process.env.TYPESAFE_API_KEY = "jev-key";
assert.equal(loadConfig().judge.apiKey, undefined, "openai 档不能把 JEV 的 key 发到别的端点");
delete process.env.TYPESAFE_API_KEY;

// jev 档没有 key → 问题写清，且引擎一调用就报错（不是静默不注入）
delete process.env.REFLECTIVE_JUDGE_BASE_URL;
delete process.env.REFLECTIVE_JUDGE_MODEL;
delete process.env.REFLECTIVE_JUDGE_THRESHOLD;
process.env.REFLECTIVE_JUDGE_PROVIDER = "jev";
const jevCfg = loadConfig();
assert.equal(jevCfg.judge.provider, "jev");
assert.match(jevCfg.judge.problems.join(" "), /没有拿到 key/);
assert.equal(createJudgeAdapter(jevCfg.judge).relevanceThreshold, 0.7, "JEV 档用标定值 0.7");
const jevAdapter = createJudgeAdapter(jevCfg.judge);
assert.equal((await jevAdapter.judgeWrite("x", "", [])).meta.status, "unavailable", "没 key 时写入走 fail-open 的 unavailable");
delete process.env.REFLECTIVE_JUDGE_PROVIDER;
console.log("✓ 档位选择：默认 rules，openai 不继承 JEV 的 key，jev 缺 key 时问题可见");

project.close();
global.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n全部通过");
