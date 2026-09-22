/**
 * 冒烟自检：schema + 作用域硬过滤 + 向量召回 + 四个 gate 的成功路径与失败路径。
 *
 * 跑法：node tests/smoke.ts
 * 不联网：JEV 用假的 fetch，验证的是「解析 + 失败姿态」，不是模型质量。
 * 模型质量那部分是手工测的，结论记在 DESIGN.md §4.1 / §13.2。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reflect-"));
process.env.REFLECTIVE_HOME = tmp;

const { openDb, insertMemory, putEmbedding, listInScope, searchByVector, searchByKeyword, getMemory, addRelation, addTrace, countMemories, setState, hardDelete, projectIdFor } = await import("../src/storage/db.ts");
const { embed, embedBatch, cosine, EMBED_DIM } = await import("../src/embed/encoder.ts");
const { JevHttpClient, JevUnavailableError } = await import("../src/jev/http.ts");
const { createJevAdapter, MAX_CANDIDATES } = await import("../src/jev/adapter.ts");

const o = openDb(path.join(tmp, "test.db"));
assert.equal(o.vecEnabled, true, "sqlite-vec 应该能加载；加载不了说明 sqlite-vec 没装");
console.log("✓ 打开数据库 + sqlite-vec");

// ---------------------------------------------------------------- 写入
const a = insertMemory(o, { content: "影子强度=|sun_side|*daylight，夜里无影子", type: "event", scope: "project", scopeId: "World" });
const b = insertMemory(o, { content: "用户喜欢简洁回答，不要长篇解释", type: "preference", scope: "global", scopeId: null });
const c = insertMemory(o, { content: "core_base_info_detail 查字典用 class_code 不用 deta_code", type: "fact", scope: "project", scopeId: "tobacco" });
assert.equal(countMemories(o), 3);
addRelation(o, a.id, b.id, "extends", 0.6);
addTrace(o, { memoryId: a.id, stage: "write", gate: "J1", action: "keep", status: "ok" });
console.log("✓ 写入 + 关系 + 轨迹");

// ---------------------------------------------------- 作用域硬过滤（门禁）
const worldScope = listInScope(o, "project", "World");
assert.deepEqual(worldScope.map((m) => m.id).sort(), [a.id, b.id].sort(), "World 只该看到自己的 + global，不该看到 tobacco 的");
const tobaccoScope = listInScope(o, "project", "tobacco");
assert.ok(!tobaccoScope.some((m) => m.id === a.id), "跨项目记忆必须被 SQL 层挡住");
console.log("✓ 作用域硬过滤挡住跨项目记忆");

// ------------------------------------------------------------ 向量召回
const [va, vb, vc] = await embedBatch([a.content, b.content, c.content]);
assert.equal(va.length, EMBED_DIM);
putEmbedding(o, a.id, va);
putEmbedding(o, b.id, vb);
putEmbedding(o, c.id, vc);

const qv = await embed("帮我把崖壁的影子调亮一点，太黑了");
const hits = searchByVector(o, qv, 3);
assert.equal(hits[0][0].id, a.id, "影子的问题应该先召回影子那条");
// 实测的弱分离特性：命中和无关的间隔只有 ~0.05，所以这里只断言排序不断言阈值。
assert.ok(cosine(qv, va) > 0.4, `命中的余弦应 >0.4，实际 ${cosine(qv, va).toFixed(3)}`);
console.log("✓ 向量召回排序正确（余弦间隔只有 ~0.05，所以不当阈值用）");

// ------------------------------------------------------------ 关键词召回
assert.deepEqual(searchByKeyword(o, "class_code").map((m) => m.id), [c.id]);
console.log("✓ FTS5 关键词召回");

// -------------------------------------------------- 四个 gate：成功路径
const okFetch: typeof fetch = async (_url, init) => {
  const req = JSON.parse(String(init?.body));
  const answers: Record<string, unknown> = {};
  for (const [key, q] of Object.entries(req.questions as Record<string, { type: string; criteria?: Record<string, string> }>)) {
    if (key === "worth_keeping") answers[key] = { type: "noul", noul: 0.89 };
    else if (key === "memory_type") answers[key] = { type: "choice", choice: "event", confidence: 1, probabilities: { event: 1 } };
    else if (key === "memory_scope") answers[key] = { type: "choice", choice: "project", confidence: 0.9, probabilities: {} };
    else if (key === "relation") answers[key] = { type: "choice", choice: "supersedes", confidence: 0.84, probabilities: {} };
    else if (key === "topic") answers[key] = { type: "choice", choice: "none", confidence: 0.7, probabilities: {} };
    else if (key === "target") answers[key] = { type: "choice", choice: Object.keys(q.criteria ?? {}).filter((k) => k !== "none")[1] ?? "none", confidence: 0.8, probabilities: {} };
    else if (key === "need_recall") answers[key] = { type: "noul", noul: 0.9 };
    else if (key === "new_topic") answers[key] = { type: "noul", noul: 0.1 };
    else if (key.startsWith("rel_")) answers[key] = { type: "noul", noul: key === `rel_${a.id}` ? 0.85 : 0.03 };
    else if (key.startsWith("inj_")) answers[key] = { type: "choice", choice: key === `inj_${a.id}` ? "inject" : "skip", confidence: 0.8, probabilities: {} };
  }
  return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 123, output_tokens: 45 } }), { status: 200 });
};
const live = createJevAdapter(new JevHttpClient({ apiKey: "test", fetchImpl: okFetch }));

const w = await live.judgeWrite("改用立面表示高度", "上下文", [getMemory(o, a.id)!, getMemory(o, b.id)!]);
assert.equal(w.meta.status, "ok");
assert.equal(w.worthKeeping.noul, 0.89);
assert.equal(w.type.choice, "event");
assert.equal(w.relation.choice, "supersedes");
assert.equal(w.targetId, b.id, "target 应该解析成真实的记忆 id");
console.log("✓ J1+J2+J3 一次调用，target 解析成真实 id");

// J5：第一次只有一问；已经注入过时多问一句「还是同一件事吗」，两个都过才需要再查。
const need1 = await live.judgeRecallNeed("影子太黑怎么调亮", { sessionId: "s", cwd: ".", projectId: "P", injectedIds: new Set() });
assert.equal(need1.meta.status, "ok");
const need2 = await live.judgeRecallNeed("影子太黑怎么调亮一点", {
  sessionId: "s", cwd: ".", projectId: "P", injectedIds: new Set(), lastInjectedQuery: "影子太黑怎么调亮",
});
assert.match(String(need2.meta.detail), /new_topic/, "第二次注入要问「还是同一件事吗」");
assert.equal(need2.noul, 0.1, "两问取最小值：任何一个说不用，就不查");
console.log("✓ J5：内容判断交给引擎（要不要查 + 还是不是同一件事）");

const r = await live.judgeRelevance("影子太黑", [getMemory(o, a.id)!, getMemory(o, b.id)!]);
assert.equal(r.meta.status, "ok");
assert.equal(r.relevance.get(a.id), 0.85);
assert.equal(r.relevance.get(b.id), 0.03);
console.log("✓ J7 相关性，相关与无关分得开");

const inj = await live.judgeInjection("影子太黑", [getMemory(o, a.id)!, getMemory(o, b.id)!], { maxTokens: 500 });
assert.equal(inj.decisions.get(a.id), "inject");
assert.equal(inj.decisions.get(b.id), "skip");
console.log("✓ J8 注入决策");

// -------------------------------------------------- 四个 gate：失败路径
const deadFetch: typeof fetch = async () => { throw new JevUnavailableError("模拟代理挂了"); };
const dead = createJevAdapter(new JevHttpClient({ apiKey: "test", fetchImpl: deadFetch }));

const dw = await dead.judgeWrite("不对，应该改用 Flyway", "上下文", []);
assert.equal(dw.meta.status, "unavailable");
assert.equal(dw.meta.fallbackUsed, "rule");
assert.ok(dw.worthKeeping.noul > 0.5, "fail-open：JEV 挂了也必须给出可写入的判断");
assert.equal(dw.type.choice, "event");
console.log("✓ 写入闸 fail-open（JEV 挂了照存）");

const dr = await dead.judgeRelevance("影子太黑", [getMemory(o, a.id)!, getMemory(o, b.id)!]);
assert.equal(dr.meta.status, "unavailable");
assert.ok((dr.relevance.get(a.id) ?? 0) > (dr.relevance.get(b.id) ?? 0), "fail-degraded：退回关键词也要排对");
console.log("✓ 召回闸 fail-degraded（退回关键词）");

const di = await dead.judgeInjection("影子太黑", [getMemory(o, a.id)!], { maxTokens: 500 });
assert.equal(di.meta.status, "unavailable");
assert.equal(di.decisions.get(a.id), "skip", "fail-closed：判断不了就不注入");
console.log("✓ 注入闸 fail-closed（不注入）");

// 超时 = 根本没连上，和代理挂掉走同一条降级路径：unavailable
const slowFetch: typeof fetch = async () => { throw new Error("The operation was aborted due to timeout"); };
const slow = createJevAdapter(new JevHttpClient({ apiKey: "test", fetchImpl: slowFetch, timeoutMs: 10 }));
assert.equal((await slow.judgeInjection("影子太黑", [getMemory(o, a.id)!], { maxTokens: 100 })).meta.status, "unavailable");
console.log("✓ 超时归为 unavailable");

// 连上了但答案不全 = degraded（判断不完整），必须和 unavailable 分得开
const partialFetch: typeof fetch = async () => new Response(
  JSON.stringify({ model: "jev-test", answers: { need_recall: { type: "noul", noul: 1 } }, usage: { input_tokens: 9, output_tokens: 1 } }),
  { status: 200 },
);
const partial = createJevAdapter(new JevHttpClient({ apiKey: "test", fetchImpl: partialFetch }));
const pw = await partial.judgeWrite("x", "y", [getMemory(o, a.id)!]);
assert.equal(pw.meta.status, "degraded", "答案缺失不能当成 ok");
assert.match(String(pw.meta.detail), /缺少/);
console.log("✓ 答案不全归为 degraded（与 unavailable 可区分）");

// ------------------------------------------------------------ 删除
hardDelete(o, b.id);
assert.equal(getMemory(o, b.id), null);
assert.equal(countMemories(o), 2);
setState(o, c.id, "archived");
assert.ok(!listInScope(o, "project", "tobacco").some((m) => m.id === c.id), "归档后不该再被召回");
console.log("✓ 硬删 + 归档");

// ------------------------------------------------------------ 其他
// ReflectiveStorage 现在自带 .git，所以最近的祖先就是它自己 → 直接用仓库名。
// 这正是想要的结果：每个仓库一个库。
assert.equal(projectIdFor(process.cwd()), "ReflectiveStorage");
// 一个仓库里放多个项目时（没有自己的 .git 的子目录）不能混库：
// 父仓库名 + 第一层子目录名。只用 git 根名会让下面的子项目全挤进同一个库。
assert.equal(projectIdFor("../../MyProject/GameProject/World"), "MyProject-GameProject");
// 深层目录不能变成 "src"/"java" 这种垃圾库名，要回退到第一层
assert.equal(projectIdFor("../../MyProject/GameProject/World/src/main/java"), "MyProject-GameProject");
assert.ok(MAX_CANDIDATES <= 20, "候选上限必须保持在实测的高区分度区间内");
console.log("✓ 项目 id 解析 + 候选上限");

o.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n全部通过");
