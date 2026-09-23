/**
 * 待确认队列自检：什么时候该问、问了之后数据变成什么样。
 *
 * 跑法：node tests/review.ts
 * 不联网、不调引擎：排队与处置都是本地逻辑（提议来自 J3 的置信度 + 连续片段比对）。
 *
 * 这里钉的核心是**提议不改数据**：队列只写 review_queue，记忆状态和关系要等用户
 * 真的选了才动。误提议的代价必须为零 —— 否则「引擎判不了就让用户判」会变成
 * 「引擎判错了就污染库」。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reflect-review-"));
process.env.REFLECTIVE_HOME = tmp;

const {
  openDb, insertMemory, getMemory, countPendingReviews, pendingReviews, resolveReview,
} = await import("../src/storage/db.ts");
const {
  queueAfterWrite, applyResolution, labelToResolution, pendingItems,
  RESOLUTION_LABELS, SAME_THING_RUN,
} = await import("../src/pipeline/review.ts");

const o = openDb(path.join(tmp, "review.db"));
const solid = (o: OpenedDb) => o;

// ------------------------------------------------------------ 低置信冲突 → 排队
const oldPref = insertMemory(o, { content: "提交必须一个模块一个提交", type: "fact", scope: "project", scopeId: "P" });
const fresh = insertMemory(o, { content: "提交可以攒在一起提", type: "fact", scope: "project", scopeId: "P" });

const queued = queueAfterWrite(solid(o), fresh, [oldPref], { choice: "supersedes", confidence: 0.38 });
assert.equal(queued.length, 1, "置信度 0.38 的取代关系要交用户确认（§6 的 <0.5 档）");
assert.equal(countPendingReviews(o), 1);
// 关键：提议阶段不许改任何数据
assert.equal(getMemory(o, oldPref.id)!.state, "active", "提议阶段不能动旧记忆");
assert.equal(getMemory(o, fresh.id)!.state, "active", "提议阶段不能动新记忆");
assert.equal(o.db.prepare(`SELECT count(*) c FROM memory_relations`).get().c, 0, "提议阶段不能写关系");
console.log("✓ 低置信冲突只排队，不动数据");

// 高置信的不排队（§6：>0.8 直接执行，已经是既成事实的关系）
const high = insertMemory(o, { content: "数据库迁移统一用 Flyway，不要用 Liquibase", type: "fact", scope: "project", scopeId: "P" });
assert.equal(queueAfterWrite(o, high, [oldPref], { choice: "supersedes", confidence: 0.92 }).length, 0, "高置信不打扰用户");
// 无关内容不排队
const unrelated = insertMemory(o, { content: "日志用 logback", type: "fact", scope: "project", scopeId: "P" });
assert.equal(queueAfterWrite(o, unrelated, [oldPref], { choice: "none", confidence: 0.9 }).length, 0);
console.log("✓ 高置信和无关的都不打扰用户");

// ------------------------------------------------------------ 看着是同一件事 → 提议合并
const dupA = insertMemory(o, { content: "以后这个仓库的提交都必须一个模块一个提交，不要攒在一起", type: "fact", scope: "project", scopeId: "P" });
const dupB = insertMemory(o, { content: "以后这个仓库的提交都必须一个模块一个提交，不许攒", type: "fact", scope: "project", scopeId: "P" });
const merge = queueAfterWrite(o, dupB, [dupA], { choice: "none", confidence: 0.9 });
assert.equal(merge.length, 1, "连续片段够长就该提议合并");
assert.equal(merge[0].kind, "merge");
assert.ok(SAME_THING_RUN >= 4 && SAME_THING_RUN <= 10, "判据不能太松（误报太多）也不能太紧（提议不出来）");

// 只提议一个合并对象，别刷屏
const many = [dupA, oldPref, high];
assert.equal(queueAfterWrite(o, dupB, many, { choice: "none", confidence: 0.9 }).length <= 1, true, "一条新记忆一次只提议一个合并对象");

// 重复排队要被挡住：同一件事问第二遍比不问更惹人烦
const before = countPendingReviews(o);
queueAfterWrite(o, dupB, [dupA], { choice: "none", confidence: 0.9 });
assert.equal(countPendingReviews(o), before, "同一个 (kind, 新, 旧) 不重复排队");
console.log("✓ 合并提议：只提议、去重、一次只提一个");

// ------------------------------------------------------------ J4：主题起名
const {
  queueTopicNaming, TOPIC_ASK_IMPORTANCE,
} = await import("../src/pipeline/review.ts");
const { setTopic, distinctTopics, getMemory: get2 } = await import("../src/storage/db.ts");
const important = insertMemory(o, { content: "上线灰度按 5% → 20% → 100% 走", type: "procedure", scope: "project", scopeId: "P", importance: 0.9 });
assert.equal(queueTopicNaming(o, important, []).length, 1, "够重要的记忆该问一句要不要起主题");
const trivial = insertMemory(o, { content: "随手记一句", type: "event", scope: "project", scopeId: "P", importance: 0.3 });
assert.equal(queueTopicNaming(o, trivial, []).length, 0, "一次性小事不值得占用户一次输入");
const already = insertMemory(o, { content: "已有主题的记忆", type: "fact", scope: "project", scopeId: "P", importance: 0.9, topic: "提交流程" });
assert.equal(queueTopicNaming(o, already, ["提交流程"]).length, 0, "已经有主题就不问");
assert.ok(TOPIC_ASK_IMPORTANCE > 0.5 && TOPIC_ASK_IMPORTANCE < 0.95);

// 用户起名之后：主题能查到，也能按主题捞回来
setTopic(o, important.id, "发布流程");
assert.ok(distinctTopics(o).includes("发布流程"), "起过名的主题要出现在主题表里");
assert.equal(get2(o, important.id)!.topic, "发布流程");
const inTopic = o.db.prepare(`SELECT id FROM memories WHERE topic = ?`).all("发布流程") as Array<{ id: string }>;
assert.deepEqual(inTopic.map((r) => r.id), [important.id]);

// ------------------------------------------------------------ J14b：不确定就问用户（不放宽不静默）
const { queueScopeWidening, widenScopeToGlobal, SCOPE_KEEP, SCOPE_WIDEN } = await import("../src/pipeline/review.ts");
const narrowed = insertMemory(o, { content: "我一般喜欢用 vim 编辑", type: "preference", scope: "project", scopeId: "P", importance: 0.7 });
assert.equal(queueScopeWidening(o, narrowed, "global").length, 1, "引擎说 global 却被收窄成 project → 要问用户");
assert.equal(queueScopeWidening(o, insertMemory(o, { content: "项目级的就不问了", type: "fact", scope: "project", scopeId: "P" }), "project").length, 0, "引擎本来就说 project，没什么可问");
assert.equal(queueScopeWidening(o, insertMemory(o, { content: "本来就已经是全局的", type: "preference", scope: "global", scopeId: null }), "global").length, 0);

const gdb = openDb(path.join(tmp, "global-review.db"));
const widenItem = pendingItems(o, 20).find((it) => String(it.kind) === "scope")!;
assert.ok([SCOPE_KEEP, SCOPE_WIDEN].every((x) => JSON.parse(String(widenItem.options)).includes(x)));
const widened = widenScopeToGlobal(o, gdb, narrowed.id);
assert.match(widened, /全局库/);
assert.equal(getMemory(o, narrowed.id)!.state, "superseded", "原项目级那条标成已取代（不乱删）");
const moved = gdb.db.prepare(`SELECT scope, content FROM memories`).all() as Array<Record<string, unknown>>;
assert.equal(moved.length, 1);
assert.equal(moved[0].scope, "global");
assert.equal(moved[0].content, "我一般喜欢用 vim 编辑", "内容原样搬过去");
assert.equal(widenScopeToGlobal(o, gdb, "不存在的 id"), "那条记忆已经不在了", "目标没了也不能炸");
gdb.close();
console.log("✓ J14b：作用域不确定就问用户；放宽是跨库搬迁（复制 + 标已取代），不是原地改字段");

// ------------------------------------------------------------ 处置
const items = pendingItems(o, 20);
const kinds = items.map((it) => String(it.kind));
assert.ok(kinds.includes("conflict") && kinds.includes("merge") && kinds.includes("topic"), `三种提议都要能排队，实际 ${kinds.join(",")}`);
for (const it of items) assert.ok(JSON.parse(String(it.options)).length >= 1);
const pendingBeforeResolve = countPendingReviews(o);

// 1) 并存：什么都不改
const conflictItem = items.find((it) => String(it.kind) === "conflict")!;
assert.match(applyResolution(o, conflictItem, "keep_both"), /并存/);
assert.equal(getMemory(o, oldPref.id)!.state, "active");
assert.equal(getMemory(o, fresh.id)!.state, "active");
assert.equal(countPendingReviews(o), pendingBeforeResolve - 1, "处置完就从队列里出去");

// 2) 用新的取代旧的
const mergeItem = items.find((it) => String(it.kind) === "merge")!;
assert.match(applyResolution(o, mergeItem, "keep_new"), /取代/);
assert.equal(getMemory(o, dupA.id)!.state, "superseded", "旧的标成已取代");
assert.equal(getMemory(o, dupB.id)!.state, "active", "新的留着");
const rel = o.db.prepare(`SELECT relation FROM memory_relations WHERE from_id = ? AND to_id = ?`).get(dupB.id, dupA.id) as Record<string, unknown>;
assert.equal(rel.relation, "supersedes");
assert.equal(countPendingReviews(o), pendingBeforeResolve - 2, "两条处置完就少两条（主题那条还留着）");

// 3) 保留旧的（只在内存里试，不入库新队列）
const c2 = insertMemory(o, { content: "部署前先跑一遍 index 重建", type: "procedure", scope: "project", scopeId: "P" });
const c3 = insertMemory(o, { content: "部署前先跑一遍 index 重建再发版", type: "procedure", scope: "project", scopeId: "P" });
queueAfterWrite(o, c3, [c2], { choice: "none", confidence: 0.9 });
const item3 = pendingItems(o, 20).find((it) => String(it.kind) === "merge" && String(it.other_id) === c2.id)!;
assert.match(applyResolution(o, item3, "keep_old"), /保留了旧的/);
assert.equal(getMemory(o, c3.id)!.state, "superseded");
assert.equal(getMemory(o, c2.id)!.state, "active");

// 取消 / 传了不认识的标签 → 一律按最安全的「并存」处理
assert.equal(labelToResolution("随便什么东西"), "keep_both", "取消键不能变成删数据");
assert.equal(labelToResolution(""), "keep_both");
assert.equal(labelToResolution(RESOLUTION_LABELS.keep_old), "keep_old");
console.log("✓ 三种处置都只改状态 + 记关系（不硬删，反悔还有救）");

// ------------------------------------------------------------ 被取代的不再被召回
const { recallFlow } = await import("../src/pipeline/recall.ts");
const stub = {
  relevanceThreshold: 0.5,
  async judgeRelevance(_q: string, c: Array<{ id: string }>) {
    return { relevance: new Map(c.map((x) => [x.id, 1])), meta: { gate: "J7", fallbackUsed: "none", status: "ok", latencyMs: 0 } };
  },
  async judgeInjection(_q: string, c: Array<{ id: string }>) {
    return { decisions: new Map(c.map((x) => [x.id, "inject" as const])), meta: { gate: "J8", fallbackUsed: "none", status: "ok", latencyMs: 0 } };
  },
} as never;
const rec = await recallFlow("提交怎么拆", {
  projectDb: o, globalDb: o,
  session: { sessionId: "s", cwd: tmp, projectId: "P", injectedIds: new Set() },
  adapter: stub, budget: { maxTokens: 800 },
});
assert.ok(!rec.candidates.some((c) => c.memory.id === dupA.id), "被取代的记忆不该再进候选");
assert.ok(rec.candidates.some((c) => c.memory.id === dupB.id), "取代它的那条要能召回");
console.log("✓ 处置生效：被取代的不再被召回");

o.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n全部通过");
