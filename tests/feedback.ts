/**
 * J15 事后核对自检：注入的记忆到底有没有被用上（DESIGN.md §4 J15 / §7.1）。
 *
 * 跑法：node tests/feedback.ts
 * 不联网、不调引擎 —— 这个信号每轮都要算，不可能每次都调一次 API。
 *
 * 这里钉的是一条「诚实性」性质：字符串比对只能证明**用上了**，证明不了**没用上**。
 * 所以 cited 只当确凿信号，`effectScore` 是下限而不是准确率 —— 名字和注释都得说清，
 * 否则以后有人拿它当 KPI 调阈值，就把「模型换了个说法」全算成了召回失败。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reflect-feedback-"));
process.env.REFLECTIVE_HOME = tmp;

const { openDb, insertMemory, recordRecall, recentRecalls } = await import("../src/storage/db.ts");
const { closeFeedbackLoop, longestSharedRun, MIN_CITED_RUN } = await import("../src/pipeline/feedback.ts");

const o = openDb(path.join(tmp, "fb.db"));
const SESSION = "s1";
const m1 = insertMemory(o, { content: "以后这个仓库的提交都必须一个模块一个提交，不要攒在一起", type: "fact", scope: "project", scopeId: "P" });
const m2 = insertMemory(o, { content: "日志统一用 logback，不要用 log4j2", type: "fact", scope: "project", scopeId: "P" });
const m3 = insertMemory(o, { content: "影子强度按立面高度算", type: "fact", scope: "project", scopeId: "P" });

// ------------------------------------------------------------ 最长连续二字组
assert.equal(longestSharedRun("一个模块一个提交", "按模块切，一个模块一个提交"), 7, "连续片段要数出来");
assert.equal(longestSharedRun("完全不同的话", "这里没有任何重叠"), 0);
assert.equal(longestSharedRun("", "任何东西"), 0, "空输入不该炸");
assert.ok(MIN_CITED_RUN >= 3, "门槛太低会把偶然同词算成「用上了」");

// ------------------------------------------------------------ 用上了
recordRecall(o, { sessionId: SESSION, query: "提交怎么拆？", recalledIds: [m1.id], injectedIds: [m1.id] });
const used = await closeFeedbackLoop(o, SESSION, "按这个仓库的约定，一个模块一个提交，我先按 src/jev 和 src/core 拆开。");
assert.deepEqual(used.cited, [m1.id], "回复里出现了原样片段，就是确凿用上了");
assert.equal(used.effectScore, 1);
assert.equal(used.by, "heuristic", "没给引擎就用字符串比对，并且要能看出来是谁判的");
const row = recentRecalls(o, 1)[0] as Record<string, unknown>;
assert.deepEqual(JSON.parse(String(row.cited_ids)), [m1.id], "核对结果要写回召回日志");
assert.equal(row.effect_score, 1);

// ------------------------------------------------------------ 共用了专有词就算用上了
recordRecall(o, { sessionId: SESSION, query: "日志怎么配？", recalledIds: [m2.id], injectedIds: [m2.id] });
const termUsed = await closeFeedbackLoop(o, SESSION, "日志框架我建议换成 logback 系列，配置集中放一份。");
assert.deepEqual(termUsed.cited, [m2.id], "「logback」这个专有词原样出现在回复里，就是确凿用上了");

// ------------------------------------------------------------ 换了说法就抓不到（已知盲区）
const m4 = insertMemory(o, { content: "部署前必须先跑一遍 index 重建", type: "procedure", scope: "project", scopeId: "P" });
recordRecall(o, { sessionId: SESSION, query: "部署要注意什么", recalledIds: [m4.id], injectedIds: [m4.id] });
const paraphrased = await closeFeedbackLoop(o, SESSION, "上线之前我会先把索引那步补上，再去发版。");
assert.deepEqual(paraphrased.cited, [], "同一个意思换了措辞就找不到确凿片段 —— 这是这套比对的已知盲区，别把它当准确率");
assert.equal(paraphrased.effectScore, 0, "分数是下限，不是准确率");

// ------------------------------------------------------------ 混合
recordRecall(o, { sessionId: SESSION, query: "这轮问两件事", recalledIds: [m1.id, m3.id], injectedIds: [m1.id, m3.id] });
const mixed = await closeFeedbackLoop(o, SESSION, "影子强度按立面高度算，这个没变；提交那件事照旧。");
assert.deepEqual(mixed.cited, [m3.id], "只认确凿的那条");
assert.equal(mixed.effectScore, 0.5);

// ------------------------------------------- 搜索行不许劫持归因（同一轮里模型常调 memory_search）
recordRecall(o, { sessionId: SESSION, query: "搜一下", recalledIds: [m1.id, m3.id], injectedIds: [m1.id] });
recordRecall(o, { sessionId: SESSION, query: "再搜一下", recalledIds: [m3.id], injectedIds: [] });
const attribution = await closeFeedbackLoop(o, SESSION, "按约定一个模块一个提交，所以照旧。");
assert.equal(attribution.injected, 1, "归因要落在最近一次真的注入过的那行，不是最后那条搜索");
assert.deepEqual(attribution.cited, [m1.id]);

// ------------------------------------------------------------ 本会话从来没注入过
const none = await closeFeedbackLoop(o, "从未注入过的会话", "影子强度按立面高度算。");
assert.equal(none.injected, 0);
assert.equal(none.effectScore, null, "没发生的事不给分（0 分会被当成「注入了但没用上」）");

// ------------------------------------------------------------ 别的会话不许串
recordRecall(o, { sessionId: "other", query: "别的会话", recalledIds: [m1.id], injectedIds: [m1.id] });
const last = recentRecalls(o, 1)[0] as Record<string, unknown>;
assert.equal(last.cited_ids, null, "别的会话的行不该被这次核对碰过（还是未核对状态）");

// ------------------------------------------------------------ 记忆被删了也不炸
recordRecall(o, { sessionId: SESSION, query: "删掉的那条", recalledIds: ["gone"], injectedIds: ["gone"] });
const gone = await closeFeedbackLoop(o, SESSION, "一个模块一个提交，随便说说");
assert.deepEqual(gone.cited, [], "查不到的 id 当没确凿用上，不能抛异常");
assert.equal(gone.effectScore, 0);

// ------------------------------------------------------------ 空回复不覆盖已有核对结果
recordRecall(o, { sessionId: SESSION, query: "重试的轮次", recalledIds: [m3.id], injectedIds: [m3.id] });
const first = await closeFeedbackLoop(o, SESSION, "影子强度按立面高度算，就这样。");
assert.deepEqual(first.cited, [m3.id]);
const blank = await closeFeedbackLoop(o, SESSION, "   ");
assert.deepEqual(blank.cited, [], "没回复可对，返回空");
const after = recentRecalls(o, 1)[0] as Record<string, unknown>;
assert.deepEqual(JSON.parse(String(after.cited_ids)), [m3.id], "空回复不许把上一轮的核对结果抹掉（那是报假账）");

// ------------------------------------------------------------ J15 只记录，不删记忆
const { countMemories } = await import("../src/storage/db.ts");
assert.equal(countMemories(o), 4, "效果分再低也不删记忆（§7.1：J15 只记录）");

o.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n全部通过");
