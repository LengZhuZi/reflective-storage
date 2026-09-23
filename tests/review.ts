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

// ------------------------------------------------------------ 主题：模型定名，用户不再被问
// 主题的落库路径在 tests/write.ts 里测（提炼层提议 → 直接落库）。
// 这里只确认「起名之后主题能查到、能按主题捞回来」。
const { setTopic, distinctTopics, getMemory: get2 } = await import("../src/storage/db.ts");
const named = insertMemory(o, { content: "上线灰度按 5% → 20% → 100% 走", type: "procedure", scope: "project", scopeId: "P", importance: 0.9 });
setTopic(o, named.id, "发布流程");
assert.ok(distinctTopics(o).includes("发布流程"), "起过名的主题要出现在主题表里");
assert.equal(get2(o, named.id)!.topic, "发布流程");
const inTopic = o.db.prepare(`SELECT id FROM memories WHERE topic = ?`).all("发布流程") as Array<{ id: string }>;
assert.deepEqual(inTopic.map((r) => r.id), [named.id]);
assert.ok(!pendingReviews(o, 20).some((r) => r.kind === "topic"), "主题不再进复核队列");

// ------------------------------------- 0.5–0.8 的冲突也要问用户（贪吃蛇 demo 验出来的）
// 用户先说「不做音效」，后一句「音效还是加上吧」被判成 contradicts 0.54 —— 落在 0.5–0.8，
// 而当时只在 <0.5 才问，于是两条互相矛盾的记忆都留在库里，召回给哪条看运气。
const noSound = insertMemory(o, { content: "这个 demo 不要音效", type: "preference", scope: "project", scopeId: "P" });
const wantSound = insertMemory(o, { content: "音效还是加上吧，吃到食物叮一声", type: "preference", scope: "project", scopeId: "P" });
const midConf = queueAfterWrite(o, wantSound, [noSound], { choice: "contradicts", confidence: 0.54 });
assert.equal(midConf.length, 1, "0.54 的冲突必须问用户（§6 的 0.5–0.8 档），不能两条并存");
const item = pendingItems(o, 20).find((it) => String(it.id) === midConf[0].id)!;
assert.match(String(item.question), /冲突/);
// 够确信的取代不排队：write.ts 会直接标掉旧的
assert.equal(queueAfterWrite(o, wantSound, [noSound], { choice: "supersedes", confidence: 0.9 }).length, 0, ">0.8 的取代直接执行，不打扰用户");
// 0.5 以下同样问（原来就有的口径不能丢）
const lowConfMemory = insertMemory(o, { content: "另一个 0.38 的情况", type: "fact", scope: "project", scopeId: "P" });
assert.equal(queueAfterWrite(o, lowConfMemory, [noSound], { choice: "contradicts", confidence: 0.38 }).length, 1, "0.5 以下同样问");
console.log("✓ 冲突的 0.5–0.8 档也问用户（>0.8 的取代自动执行）");

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
assert.ok(kinds.includes("conflict") && kinds.includes("merge") && kinds.includes("scope"), `引擎拿不准的都要能排队，实际 ${kinds.join(",")}`);
assert.ok(!kinds.includes("topic"), "主题不再进队列（模型直接定）");
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
