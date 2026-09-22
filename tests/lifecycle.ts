/**
 * 生命周期自检：J9 巩固、J10 衰减、J12 归档、J13 复活，以及 fail-silent。
 *
 * 跑法：node tests/lifecycle.ts
 * 不联网、不调任何判断引擎 —— §9.2 说得很明白：衰减是纯公式，J10 的编号只是标记。
 *
 * 为什么这条最需要断言：它会在没人看着的时候改库（归档、复活）。改错的方向不对称 ——
 * 该归档没归档只是库变大，不该归档却归档掉了用户明确在意的事就找不回来了。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reflect-life-"));
process.env.REFLECTIVE_HOME = tmp;

const { openDb, insertMemory, getMemory, setState, countMemories, addTrace } = await import("../src/storage/db.ts");
const {
  runLifecycle, resurrectFor, decayScore, DECAY,
  COLD_BELOW, ARCHIVE_BELOW, ARCHIVE_AFTER_DAYS, KEEP_IMPORTANCE,
} = await import("../src/pipeline/lifecycle.ts");

const o = openDb(path.join(tmp, "life.db"));
const DAY = 86400000;
const now = Date.now();
/** 把一条记忆「放到过去」：created_at / last_accessed 都是插入时写死的，只能直接改。 */
const backdate = (id: string, days: number) =>
  o.db.prepare(`UPDATE memories SET created_at = ?, last_accessed = ? WHERE id = ?`).run(now - days * DAY, now - days * DAY, id);

// ------------------------------------------------------------ J10 衰减公式
const base = { type: "fact" as const, importance: 1, accessCount: 0, createdAt: now, lastAccessed: now };
assert.ok(Math.abs(decayScore(base, now) - 1) < 1e-9, "刚记下、从没访问过的 fact 应该是 1.0");
assert.ok(decayScore({ ...base, lastAccessed: now - 100 * DAY }, now) < decayScore(base, now), "越久没用分越低");
assert.ok(
  decayScore({ ...base, type: "emotion" }, now - 30 * DAY) < decayScore({ ...base, type: "fact" }, now - 30 * DAY),
  "情绪的衰减必须比事实快得多（§3.2 的衰减曲线）",
);
assert.ok(
  decayScore({ ...base, accessCount: 9, lastAccessed: now - 30 * DAY }, now) >
    decayScore({ ...base, lastAccessed: now - 30 * DAY }, now),
  "常被用到的记忆衰减更慢（公式里的访问增益）",
);
assert.ok(DECAY.emotion.lambda > DECAY.event.lambda && DECAY.event.lambda > DECAY.fact.lambda);
console.log("✓ J10 衰减：纯公式，类型权重和访问次数都算进去");

// ------------------------------------------------------------ J9 巩固
const hot = insertMemory(o, { content: "用户每次都要求先给结论", type: "preference", scope: "project", scopeId: "P", importance: 0.6 });
for (let i = 0; i < 5; i++) o.db.prepare(`UPDATE memories SET access_count = access_count + 1 WHERE id = ?`).run(hot.id);
const before = getMemory(o, hot.id)!.importance;
const s1 = runLifecycle(o, { now });
assert.ok(getMemory(o, hot.id)!.importance > before, "访问够多的记忆要晋升（J9）");
assert.equal(s1.promoted, 1);
assert.match(String((o.db.prepare(`SELECT user_visible FROM reflection_traces WHERE gate='J9'`).get() as Record<string, unknown>).user_visible), /生命周期/);
console.log("✓ J9 巩固：访问频繁 → importance 上调，且留痕");

// ------------------------------------------------------------ J12 归档（含不改动的方向）
const stale = insertMemory(o, { content: "小车点表的字段顺序", type: "event", scope: "project", scopeId: "P", importance: 0.3 });
backdate(stale.id, 200);
const precious = insertMemory(o, { content: "用户明确说过这条永远不要忘", type: "fact", scope: "project", scopeId: "P", importance: 0.95 });
backdate(precious.id, 400);
const fresh = insertMemory(o, { content: "刚刚定下来的东西", type: "fact", scope: "project", scopeId: "P" });

const s2 = runLifecycle(o, { now });
assert.equal(getMemory(o, stale.id)!.state, "archived", "又旧又轻的事件该归档");
assert.notEqual(getMemory(o, precious.id)!.state, "archived", "高 importance 的记忆永远不归档（§11）—— 降到 cold 可以，藏起来不行");
assert.equal(getMemory(o, precious.id)!.state, "cold", "400 天没用到该降成 cold（cold 仍然能召回）");
assert.equal(getMemory(o, fresh.id)!.state, "active", "刚记下的东西不该被动");
assert.ok(s2.archived >= 1);
assert.ok(!JSON.stringify(s2).includes("deleted"), "本地版只归档不删除：删是不可逆的，交给用户 /memory forget");
console.log("✓ J12 归档：够冷才归档，高 importance 不动，且只归档不删除");

// 归档的那条不该再被召回（recall 的 inScope 挡它）
const { recallFlow } = await import("../src/pipeline/recall.ts");
const noop = { relevanceThreshold: 0.5, async judgeRelevance(_q: string, c: Array<{ id: string }>) { return { relevance: new Map(c.map((x) => [x.id, 1])), meta: { gate: "J7", fallbackUsed: "none", status: "ok", latencyMs: 0 } }; }, async judgeInjection(_q: string, c: Array<{ id: string }>) { return { decisions: new Map(c.map((x) => [x.id, "inject" as const])), meta: { gate: "J8", fallbackUsed: "none", status: "ok", latencyMs: 0 } }; } } as never;
const rec = await recallFlow("小车点表", { projectDb: o, globalDb: o, session: { sessionId: "s", cwd: tmp, projectId: "P", injectedIds: new Set() }, adapter: noop, budget: { maxTokens: 800 } });
assert.ok(!rec.candidates.some((c) => c.memory.id === stale.id), "归档的记忆不该再进候选");
console.log("✓ 归档后不再被召回");

// ------------------------------------------------------------ J13 复活
const revived = resurrectFor(o, "小车点表的字段顺序还能改吗", { now });
assert.equal(revived.resurrected, 1);
assert.equal(revived.ids[0], stale.id, "新会话命中它的主题，就该放回来");
assert.equal(getMemory(o, stale.id)!.state, "active");
assert.ok((getMemory(o, stale.id)!.lastAccessed ?? 0) >= now, "复活要顺手记一次访问");

const irrelevant = resurrectFor(o, "今天天气不错适合出去走走", { now });
assert.equal(irrelevant.resurrected, 0, "不相关的话题不该乱复活");
assert.equal(resurrectFor(o, "短", { now }).resurrected, 0, "太短的问题没有主题可言");
console.log("✓ J13 复活：话题命中才放回 active，无关不动");

// ------------------------------------------------------------ fail-silent（§6.1）
const closed = openDb(path.join(tmp, "closed.db"));
closed.close();
const s3 = runLifecycle(closed, { now });
assert.ok(s3.errors.length > 0, "出错要报告在摘要里");
assert.equal(s3.archived, 0);
assert.doesNotThrow(() => resurrectFor(closed, "任何话题任何话题", { now }), "纯后台的一层不许把异常抛给会话");
assert.doesNotThrow(() => runLifecycle(o, { now, maxRows: 0 }), "上限为 0 也不该炸");
console.log("✓ fail-silent：出错只记进摘要，不抛给会话");

// ------------------------------------------------------------ 上限与幂等
const s4 = runLifecycle(o, { now, maxRows: 1 });
assert.ok(s4.scanned <= 1, "有上限时不能扫全表（§9.3：别拖慢启动）");
const stateA = getMemory(o, fresh.id)!.state;
runLifecycle(o, { now });
runLifecycle(o, { now });
assert.equal(getMemory(o, fresh.id)!.state, stateA, "连跑多次不该把状态抖来抖去");
const promotedTwice = getMemory(o, hot.id)!.importance;
assert.ok(promotedTwice <= 1, "importance 上限 1.0");
assert.ok(countMemories(o) > 0, "生命周期不删不加，只改状态");
console.log("✓ 上限生效、重复跑不抖动、不增删记忆");

// ------------------------------------------------------------ 边界常量
assert.ok(ARCHIVE_BELOW < COLD_BELOW, "归档线必须比转冷线更低");
assert.ok(ARCHIVE_AFTER_DAYS >= 30, "归档要看日子，不能只看分数");
assert.ok(KEEP_IMPORTANCE > 0.5, "「永不归档」的门槛不能太低，否则什么都保不住");

o.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n全部通过");
