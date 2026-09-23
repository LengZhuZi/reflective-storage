/**
 * 召回流程自检：多路召回合并、作用域门禁、候选压缩、J7 阈值、J8 注入、预算截断、
 * 三条失败姿态里属于召回的那两条（fail-degraded / fail-closed）。
 *
 * 跑法：node tests/recall.ts
 * 不联网：adapter 是假的，验证的是流程和门禁，不是 JEV 的判断质量。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reflect-recall-"));
process.env.REFLECTIVE_HOME = tmp;

const { openDb, insertMemory, setState, putEmbedding, getMemory } = await import("../src/storage/db.ts");
const { embed, embedBatch } = await import("../src/embed/encoder.ts");
const { recallFlow, worthRecalling, RELEVANCE_THRESHOLD } = await import("../src/pipeline/recall.ts");
const { MEMORY_OPEN, MEMORY_CLOSE } = await import("../src/pipeline/inject.ts");

const project = openDb(path.join(tmp, "proj.db"));
const global = openDb(path.join(tmp, "global.db"));
const session = { sessionId: "s1", cwd: tmp, projectId: "P", injectedIds: new Set<string>() };

/** 假 adapter：只实现召回流程用到的那两个方法，并记下 JEV 到底看见了哪些候选。 */
function fakeAdapter(opts: {
  relevance?: Record<string, number>;
  j7status?: "ok" | "degraded" | "unavailable";
  inject?: Record<string, "inject" | "skip">;
  j8status?: "ok" | "degraded" | "unavailable";
  seen?: string[];
} = {}) {
  const meta = (gate: string, status: string) => ({
    gate, fallbackUsed: status === "ok" ? "none" : "rule", status, latencyMs: 3,
    detail: status === "ok" ? undefined : `${gate} 降级：JEV 不可用`,
  });
  return {
    async judgeRelevance(_q: string, cands: Array<{ id: string }>) {
      opts.seen?.push(...cands.map((c) => c.id));
      return { relevance: new Map(Object.entries(opts.relevance ?? {})), meta: meta("J7", opts.j7status ?? "ok") };
    },
    async judgeInjection(_q: string, cands: Array<{ id: string }>) {
      return {
        decisions: new Map(cands.map((c) => [c.id, opts.inject?.[c.id] ?? "skip"])),
        meta: meta("J8", opts.j8status ?? "ok"),
      };
    },
  } as never;
}

// ------------------------------------------------------------ 造数据
const m1 = insertMemory(project, { content: "影子强度=|sun_side|*daylight，夜里无影子", type: "event", scope: "project", scopeId: "P" });
const m2 = insertMemory(project, { content: "构建脚本在 scripts/build.sh，用 esbuild 打包", type: "procedure", scope: "project", scopeId: "P" });
const m3 = insertMemory(global, { content: "用户喜欢简洁回答，不要长篇解释", type: "preference", scope: "global", scopeId: null });
const m4 = insertMemory(project, { content: "影子那条是 alpha 项目的做法，别的项目别照抄", type: "event", scope: "project", scopeId: "Other" });
const m5 = insertMemory(project, { content: "影子问题上一个会话里已经确认过了", type: "event", scope: "session", scopeId: "s0" });
const m6 = insertMemory(project, { content: "短", type: "event", scope: "session", scopeId: "s1" });
const m7 = insertMemory(project, { content: "影子的旧结论已经被推翻了", type: "event", scope: "project", scopeId: "P" });
setState(project, m7.id, "archived");

// 向量层真的跑起来（模型本地，离线），让多路召回里向量那一路也参与
const [v1, v2, v3] = await embedBatch([m1.content, m2.content, m3.content]);
putEmbedding(project, m1.id, v1);
putEmbedding(project, m2.id, v2);
putEmbedding(global, m3.id, v3);

const QUERY = "帮我把崖壁的影子调亮一点，太黑了";

// ------------------------------------------------------------ 轻量预判
assert.equal(worthRecalling("继续").ok, false);
assert.equal(worthRecalling("好的，谢谢").ok, false);
assert.equal(worthRecalling("   ").ok, false);
assert.equal(worthRecalling("影子太黑").ok, false, "太短的输入先不花这次钱（跳过不打标记，下一轮还会查）");
// 实测：8 个字的问句是很常见的开场，挡掉它等于整段会话一条记忆都搭不上
assert.equal(worthRecalling("提交要按什么拆？").ok, true, "短但有内容的问句要查（§10.4 首轮直接走完整召回）");
assert.equal(worthRecalling("帮我把崖壁的影子强度调低一点，夜里看起来太黑了").ok, true);
console.log("✓ §10.4 轻量预判挡掉短输入（跳过不打标记，所以不是「本会话永不注入」）");

// ------------------------------------------------------------ 正常召回
const seen: string[] = [];
const res = await recallFlow(QUERY, {
  projectDb: project, globalDb: global, session,
  adapter: fakeAdapter({ relevance: { [m1.id]: 0.85, [m2.id]: 0.05, [m3.id]: 0.92, [m6.id]: 0.71 }, inject: { [m1.id]: "inject", [m3.id]: "skip" }, seen }),
  budget: { maxTokens: 800 },
});

assert.equal(res.status, "ok");
assert.deepEqual(res.injected.map((r) => r.memory.id), [m1.id], "J7 阈值 + J8 决策之后只该剩影子那条");
assert.ok(res.block.startsWith(MEMORY_OPEN) && res.block.endsWith(MEMORY_CLOSE));
assert.ok(res.block.includes(m1.content), "注入块里要有记忆原文");
assert.ok(!res.candidates.some((r) => r.memory.id === m2.id), "0.05 的相关性必须被阈值挡掉");
assert.ok(res.candidates.some((r) => r.memory.id === m3.id), "global 偏好该进候选（由 J8 决定跳不跳，而不是在门禁层丢）");
console.log("✓ J7 阈值 + J8 决策 + 注入块组装");

// ------------------------------------------------------------ 作用域门禁（门禁，不是建议）
assert.ok(!seen.includes(m4.id), "跨项目记忆必须在调 JEV 之前就被挡住");
assert.ok(!seen.includes(m5.id), "上一个会话的 session 记忆不该进这次会话");
assert.ok(!seen.includes(m7.id), "归档的记忆不该再被召回");
assert.ok(seen.includes(m6.id), "本会话自己的 session 记忆要能看到");
console.log("✓ 作用域门禁在 JEV 之前生效（JEV 是建议，SQL 和这行代码才是门禁）");

// ------------------------------------------------------------ 已注入的不重复判
session.injectedIds.add(m1.id);
const seen2: string[] = [];
const res2 = await recallFlow(QUERY, {
  projectDb: project, globalDb: global, session,
  adapter: fakeAdapter({ relevance: { [m2.id]: 0.5 }, inject: {}, seen: seen2 }),
  budget: { maxTokens: 800 },
});
assert.ok(!seen2.includes(m1.id), "已注入过的 id 不该再送进 JEV：不重复判断，也不重复付费");
session.injectedIds.clear();
console.log("✓ 已注入的 id 在调 JEV 之前就从候选池删掉");

// ------------------------------------------------------------ fail-degraded：J7 挂了
const degraded = await recallFlow(QUERY, {
  projectDb: project, globalDb: global, session,
  // 降级时 JEV 给不出分（真实兜底给的是规则分），阈值不能生效 ——
  // 否则「少召回几条」会变成「一条都不召回」。
  adapter: fakeAdapter({ relevance: {}, j7status: "degraded", inject: { [m1.id]: "inject" } }),
  budget: { maxTokens: 800 },
});
assert.equal(degraded.status, "degraded", "J7 降级要显式报出来，不能装成 ok");
assert.ok(degraded.candidates.length > 1, "降级时不能卡阈值，否则 fail-degraded 变成了不召回");
assert.deepEqual(degraded.injected.map((r) => r.memory.id), [m1.id], "J8 正常时，降级的候选仍然能注入");
assert.match(String(degraded.detail), /J7/);
console.log("✓ J7 fail-degraded：退回排序并放行，降级不装成「没有记忆」");

// ------------------------------------------------------------ fail-closed：J8 挂了
const closed = await recallFlow(QUERY, {
  projectDb: project, globalDb: global, session,
  adapter: fakeAdapter({ relevance: { [m1.id]: 0.85 }, j8status: "unavailable" }),
  budget: { maxTokens: 800 },
});
assert.equal(closed.status, "unavailable");
assert.deepEqual(closed.injected, [], "J8 挂了就不注入：沉默优于噪声");
assert.equal(closed.block, "", "不注入就不能产出注入块");
assert.ok(closed.candidates.length > 0, "候选还是要留着，/memory 才能看见「命中了但没注入」");
assert.match(String(closed.detail), /J8/);
console.log("✓ J8 fail-closed：判断不了就不注入，但状态可查");

// ------------------------------------------------------------ 预算截断
const tiny = await recallFlow(QUERY, {
  projectDb: project, globalDb: global, session,
  adapter: fakeAdapter({ relevance: { [m1.id]: 0.85, [m6.id]: 0.9 }, inject: { [m1.id]: "inject", [m6.id]: "inject" } }),
  budget: { maxTokens: 4 },
});
assert.deepEqual(tiny.injected.map((r) => r.memory.id), [m6.id], "预算只放得下那条短的，就不硬塞长的");
assert.ok(tiny.injected.every((r) => r.relevance >= RELEVANCE_THRESHOLD));

const zero = await recallFlow(QUERY, {
  projectDb: project, globalDb: global, session,
  adapter: fakeAdapter({ relevance: { [m1.id]: 0.85 }, inject: { [m1.id]: "inject" } }),
  budget: { maxTokens: 0 },
});
assert.deepEqual(zero.injected, [], "预算为 0 就不注入");
console.log("✓ token 预算截断（装不下的跳过，预算不够时沉默）");

// ------------------------------------------------------------ memory_search 模式
const search = await recallFlow(QUERY, {
  projectDb: project, globalDb: global, session,
  adapter: fakeAdapter({ relevance: { [m1.id]: 0.85, [m3.id]: 0.8 } }),
});
assert.deepEqual(search.injected, [], "不给预算 = 不做注入决策");
assert.equal(search.block, "", "不给预算就不产出注入块");
assert.ok(search.candidates.length >= 2, "但候选还是要返回（工具要把命中摆出来）");
console.log("✓ 不传预算 = memory_search 模式（只召回，不注入）");

// ------------------------------------------------------------ J6：同主题那一路
// 主题是人起的名，命中一次比关键词更值钱；而向量那 0.046 的区分度本来就弱，
// 按主题捞是它的互补。走的是「提问里出现了主题名」这种确定性查表，不是语义判断。
const { mentionsTopic } = await import("../src/pipeline/recall.ts");
assert.equal(mentionsTopic("认证那套要不要动", "认证"), true, "提问里直接出现主题名");
assert.equal(mentionsTopic("提交流程怎么走", "提交流程"), true, "二字组基本覆盖也算提到");
assert.equal(mentionsTopic("影子太黑", "认证"), false);
assert.equal(mentionsTopic("任何东西", ""), false, "空主题名不匹配一切");

const { setTopic, memoriesByTopic } = await import("../src/storage/db.ts");
const topicMem = insertMemory(project, { content: "认证走 OIDC，token 有效期 30 分钟", type: "fact", scope: "project", scopeId: "P" });
setTopic(project, topicMem.id, "认证");
assert.deepEqual(memoriesByTopic(project, "认证").map((m) => m.id), [topicMem.id]);

// 让「同主题」那一路成为**唯一**能把它捞回来的路：灌 60 条更新的无关记忆把
// 「作用域内最近 50 条」和「向量 top 50」的位置占满（下面这条还没有 embedding）。
for (let i = 0; i < 60; i++) {
  insertMemory(project, { content: `第 ${i} 条构建日志：esbuild 打包参数与缓存命中情况 -${i}`, type: "event", scope: "project", scopeId: "P" });
}
const topicSeen: string[] = [];
const topicRes = await recallFlow("认证那块现在怎么做的？", {
  projectDb: project, globalDb: global, session,
  adapter: fakeAdapter({ relevance: { [topicMem.id]: 0.9 }, inject: { [topicMem.id]: "inject" }, seen: topicSeen }),
  budget: { maxTokens: 800 },
});
assert.ok(topicSeen.includes(topicMem.id), "提到主题名就该把它下面的记忆捞进候选（其他三路都被挤掉了）");
assert.deepEqual(topicRes.injected.map((r) => r.memory.id), [topicMem.id]);
// 不相关的话题不该靠主题乱捞
const seenOther: string[] = [];
await recallFlow("影子太黑怎么调亮", {
  projectDb: project, globalDb: global, session,
  adapter: fakeAdapter({ relevance: { [topicMem.id]: 0.9 }, inject: {}, seen: seenOther }),
  budget: { maxTokens: 800 },
});
assert.ok(!seenOther.includes(topicMem.id), "没提到的主题不许硬塞进来");
console.log("✓ J6：同主题那一路参与召回（查表捞候选，相关性仍然 J7 说了算）");

// ------------------------------------------------------------ J14a：边界屏蔽（不是低分）
const gBlocked = insertMemory(global, { content: "用户喜欢用 vim，所有项目都一样", type: "preference", scope: "global", scopeId: null });
const blockingAdapter = {
  relevanceThreshold: 0.5,
  async judgeRelevance(_q: string, c: Array<{ id: string }>) {
    return {
      relevance: new Map(c.map((x) => [x.id, 0.95])),
      blocked: new Set(c.map((x) => x.id).filter((id) => id === gBlocked.id)),
      meta: { gate: "J7", fallbackUsed: "none", status: "ok", latencyMs: 1 },
    };
  },
  async judgeInjection(_q: string, c: Array<{ id: string }>) {
    return { decisions: new Map(c.map((x) => [x.id, "inject" as const])), meta: { gate: "J8", fallbackUsed: "none", status: "ok", latencyMs: 1 } };
  },
} as never;
const gRes = await recallFlow("编辑器用哪个", {
  projectDb: project, globalDb: global, session, adapter: blockingAdapter, budget: { maxTokens: 800 },
});
assert.ok(!gRes.candidates.some((c) => c.memory.id === gBlocked.id), "被 J14a 屏蔽的即使相关性 0.95 也不许留");
assert.ok(gRes.candidates.length > 0, "屏蔽只针对那一条，不许误伤别的候选");
const blockTrace = project.db.prepare(`SELECT gate, action, reason FROM reflection_traces WHERE gate = 'J14a'`).get() as Record<string, unknown>;
assert.equal(blockTrace.action, "block");
assert.match(String(blockTrace.reason), /不适用于当前项目/);
console.log("✓ J14a：屏蔽走独立通道（不是低分），且留痕");

// ------------------------------------------------------------ 空库 + 留痕
const empty = await recallFlow(QUERY, {
  projectDb: openDb(path.join(tmp, "empty.db")), globalDb: openDb(path.join(tmp, "empty-global.db")),
  session, adapter: fakeAdapter(), budget: { maxTokens: 800 },
});
assert.deepEqual(empty.candidates, []);
assert.equal(empty.status, "ok");
assert.equal(empty.detail, "库里没有命中");
console.log("✓ 库里确实没有时和 JEV 降级分得开（§6.2）");

// 命中过就得更新 last_accessed：衰减（§9.2）看的是这个
assert.ok((getMemory(project, m1.id)?.lastAccessed ?? 0) > 0, "注入过的记忆要记一次访问");

const traces = project.db.prepare(`SELECT gate, action, status FROM reflection_traces ORDER BY created_at`).all() as Array<Record<string, unknown>>;
assert.ok(traces.some((t) => t.gate === "J7" && t.action === "keep"), "J7 要留痕");
assert.ok(traces.some((t) => t.gate === "J8" && t.action === "inject"), "J8 要留痕");
assert.ok(traces.some((t) => t.status === "unavailable"), "降级必须留痕（§6.2 降级可见）");
console.log("✓ 每次 JEV 判断都留痕（含降级）");

// ------------------------------------------------------------ J15：召回登记
const { recentRecalls } = await import("../src/storage/db.ts");
const logged = recentRecalls(project, 20) as Array<Record<string, unknown>>;
assert.ok(logged.length > 0, "每次召回都要登记一条（J15 轻量反馈）");
const injectedInLog = logged.map((r) => JSON.parse(String(r.injected_ids)) as string[]);
assert.ok(injectedInLog.some((ids) => ids.length > 0), "注入了就要记下来注入了什么");
assert.ok(logged.some((r) => JSON.parse(String(r.recalled_ids)).length === 0), "一条都没召回时也要记 —— 那正是排查「为什么没注入」时最想看的一次");
console.log("✓ J15 召回日志：记事实，不推断效果");

project.close();
global.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n全部通过");
