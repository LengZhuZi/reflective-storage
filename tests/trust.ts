/**
 * 来源权重（origin / trust）自检。
 *
 * 跑法：node tests/trust.ts
 * 不联网：adapter 用假的 —— 这里验的是「谁的活算数、活成什么样」，不是 JEV 的质量。
 *
 * 为什么要有这一层：判断引擎只能看到文本，看不出哪句是编的。所以真假的证据不放在
 * 判断链里，放在两个可观测的地方 —— 来源（谁说的）和工具结果（跑没跑过）。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reflect-trust-"));
process.env.REFLECTIVE_HOME = tmp;

const { openDb, insertMemory, getMemory } = await import("../src/storage/db.ts");
const { writeFlow, TRUST_USER, TRUST_AGENT_VERIFIED, TRUST_AGENT_BARE } = await import("../src/pipeline/write.ts");
const { buildInjectionBlock, trustMark } = await import("../src/pipeline/inject.ts");
const { TRUST_CAP, TRUST_MARK_BELOW } = await import("../src/core/types.ts");
const { mergeMemories } = await import("../src/pipeline/review.ts");

const project = openDb(path.join(tmp, "proj.db"));
const global = openDb(path.join(tmp, "global.db"));
const session = { sessionId: "s1", cwd: tmp, projectId: "P", injectedIds: new Set<string>() };

/** 假 adapter：写入闸全放行，可控的是 relation / targetId / 合并分。 */
function adapter(opts: { relation?: "none" | "extends" | "contradicts" | "supersedes"; targetId?: string; confidence?: number; merge?: number } = {}) {
  return {
    async judgeWrite() {
      return {
        worthKeeping: { noul: 0.9 },
        type: { choice: "fact", confidence: 0.9, probabilities: {} },
        scope: { choice: "project", confidence: 0.9, probabilities: {} },
        relation: { choice: opts.relation ?? "none", confidence: opts.confidence ?? 0.9, probabilities: {} },
        targetId: opts.targetId ?? null,
        topic: null,
        meta: { gate: "J1+J2+J3", fallbackUsed: "none", status: "ok", latencyMs: 3 },
      };
    },
    async judgeMerge(_m: unknown, cands: Array<{ id: string }>) {
      const out = new Map(cands.map((c) => [c.id, opts.merge ?? 0]));
      return Object.assign(out, { meta: { gate: "J11", fallbackUsed: "none", status: "ok", latencyMs: 3 } });
    },
  } as never;
}

// ------------------------------------------------------------ 出厂值按来源定
// 用户原话是事实源；模型的话按「这一轮有没有工具跑成功过」分两档。
// 不按引擎打分定 —— 引擎判不了真假，它只能看到文本。
const user = await writeFlow(project, global, adapter(), session, { userTexts: ["以后提交都必须一个模块一个提交"], context: "" });
assert.equal(user.memory!.origin, "user");
assert.equal(user.memory!.trust, TRUST_USER);
assert.equal(trustMark(user.memory!), "", "用户原话不加标记");

const bare = await writeFlow(project, global, adapter(), session, { userTexts: ["这个服务的配置读的是环境变量"], context: "", origin: "agent" });
assert.equal(bare.memory!.origin, "agent", "模型自己写的要标来源");
assert.equal(bare.memory!.trust, TRUST_AGENT_BARE, "没有外部验证 = 纯推断，最低一档");

const verified = await writeFlow(project, global, adapter(), session, { userTexts: ["部署脚本先备份再执行"], context: "", origin: "agent", agentVerified: true });
assert.equal(verified.memory!.trust, TRUST_AGENT_VERIFIED, "这一轮有工具跑成功过 → 高一档");
assert.ok(TRUST_AGENT_VERIFIED < TRUST_USER, "验证过也不等于用户原话");
assert.ok(TRUST_AGENT_BARE < TRUST_AGENT_VERIFIED);
console.log("✓ 出厂值：用户 1.0，模型有验证 0.7、没验证 0.4");

// ------------------------------------------------------------ 低 trust 带标记注入
// 标记线只切一刀：用户原话（和后来被用户默认下来的）不带，模型自己写的带 ——
// 连「有工具验证过」那一档也带。理由不是不信那次验证，是自洽回路没变：模型看到的
// 仍然是自己上一轮的话。只有用户默认下来了（升到 TRUST_CAP 一侧），标记才去掉。
const block = buildInjectionBlock([user.memory!, bare.memory!, verified.memory!]);
assert.ok(block.includes(`[模型所记，未经用户确认] ${bare.memory!.content}`), "纯推断要带标记");
assert.ok(block.includes(`[模型所记，未经用户确认] ${verified.memory!.content}`), "验证过也还是模型说的，照样带");
assert.ok(!block.includes(`[模型所记，未经用户确认] ${user.memory!.content}`), "用户原话不加标记");
assert.ok(TRUST_AGENT_VERIFIED < TRUST_MARK_BELOW, "两档都落在标记线下面 —— 能升到线上面的只有「用户默认」这一种");
// 标记只影响措辞，不影响召回 —— trust 不是过滤器（见 core/types.ts 的说明）
assert.equal(block.split("\n").length - 2, 3, "三条都在块里，一条都没被藏掉");
console.log("✓ 低 trust 带「未经确认」标记注入，但照常出现在块里");

// ------------------------------------------------------------ trust 的涨跌
// 只认两件可观测的事：用户后来在同一个话题上说话又没推翻它（extends → 升），
// 撞上反证（contradicts → 降）。封顶不是 1.0：升到顶这条就免疫复核了。
const agentFact = insertMemory(project, { content: "这个模块用的是 gRPC", type: "fact", scope: "project", scopeId: "P", origin: "agent", trust: TRUST_AGENT_VERIFIED });
await writeFlow(project, global, adapter({ relation: "extends", targetId: agentFact.id }), session, {
  userTexts: ["那这个模块的超时也一起调一下"], context: "",
});
assert.equal(getMemory(project, agentFact.id)!.trust.toFixed(1), "0.8", "用户后来在同话题说话没推翻 → 升 0.1");
assert.equal(trustMark(getMemory(project, agentFact.id)!), "", "升过标记线就不再加标记 —— 这是标记唯一的去除途径");

// 一直升也不许过 TRUST_CAP：模型的话永远升不到用户那一档
for (let i = 0; i < 5; i++) {
  await writeFlow(project, global, adapter({ relation: "extends", targetId: agentFact.id }), session, {
    userTexts: [`那这个模块的第 ${i} 个超时也一起调一下`], context: "",
  });
}
assert.equal(getMemory(project, agentFact.id)!.trust, TRUST_CAP, `封顶在 ${TRUST_CAP}，不是 1.0`);

// 反证：降分 + 排进待确认队列（哪条对得人来判，不自动删）
const conflict = await writeFlow(project, global, adapter({ relation: "contradicts", targetId: agentFact.id, confidence: 0.6 }), session, {
  userTexts: ["不对，这个模块早就改成 HTTP 了"], context: "",
});
assert.equal(getMemory(project, agentFact.id)!.trust.toFixed(1), "0.7", "撞上反证 → 降 0.2");
assert.ok((conflict.review ?? []).some((r) => r.kind === "conflict"), "冲突要问用户，不许自动拍");
// 用户的话本身不该被降：它没有「推断」这一档
assert.equal(getMemory(project, user.memory!.id)!.trust, TRUST_USER, "用户原话的 trust 不动");
const trustTrace = project.db.prepare(`SELECT action, reason FROM reflection_traces WHERE gate = 'J3-trust' LIMIT 1`).get() as Record<string, unknown>;
assert.equal(trustTrace.action, "trust", "涨跌要留痕，不然 /memory why 说不清");
console.log("✓ trust 涨跌：extends 升 0.1 且封顶 0.9，contradicts 降 0.2 并问用户");

// ------------------------------------------------------------ 合并/放宽不冲掉可信度
// 并进来的那条 trust 高，保留的那条就该拿到它 —— 否则一条模型推断会跟着用户的权威一起走。
const keepAgent = insertMemory(project, { content: "索引重建要在部署前跑", type: "procedure", scope: "project", scopeId: "P", origin: "agent", trust: TRUST_AGENT_BARE });
const dropUser = insertMemory(project, { content: "部署前必须先跑一遍索引重建", type: "procedure", scope: "project", scopeId: "P", origin: "user", trust: TRUST_USER });
mergeMemories(project, keepAgent.id, dropUser.id, "测试：并进来的是用户原话");
assert.equal(getMemory(project, keepAgent.id)!.trust, TRUST_USER, "合并后保留用户那一档的可信度");

// 反过来不许降：低 trust 并进来不该把保留的那条拉低
const keepUser = insertMemory(project, { content: "日志一律用结构化输出", type: "preference", scope: "project", scopeId: "P", origin: "user", trust: TRUST_USER });
const dropAgent = insertMemory(project, { content: "日志最好用结构化输出", type: "preference", scope: "project", scopeId: "P", origin: "agent", trust: TRUST_AGENT_BARE });
mergeMemories(project, keepUser.id, dropAgent.id, "测试：并进来的是模型推断");
assert.equal(getMemory(project, keepUser.id)!.trust, TRUST_USER, "合并不能把用户原话的 trust 拉低");
console.log("✓ 合并只沿用高的那一档可信度，双向都不跑偏");

// ---------------------------------------- 保留原文：模型转述不该顶掉用户原话
// 合并时如果让 agent 那条当「保留方」，活下来的就是模型的重述 —— 文字就不对了。
const told = insertMemory(project, { content: "部署前必须先跑一遍 index 重建", type: "procedure", scope: "project", scopeId: "P", origin: "user", trust: TRUST_USER });
const restated = await writeFlow(project, global, adapter({ merge: 0.95 }), session, {
  userTexts: ["部署前要先跑一遍 index 重建才行"], context: "", origin: "agent", agentVerified: true,
});
assert.equal(restated.merged, 1, "引擎说 0.95 是同一件事 → 自动合并");
assert.equal(getMemory(project, told.id)!.state, "active", "用户原话要活下来");
assert.equal(getMemory(project, restated.memory!.id)!.state, "superseded", "模型的重述被并掉");
assert.match(getMemory(project, told.id)!.metadata ?? "", /部署前要先跑一遍 index 重建才行/, "被并掉的模型原文留在 metadata 里（留退路）");
console.log("✓ 合并保留用户原话，模型转述被并掉");

// ------------------------------------------------------------ 老库补列
// v0.3 之前的库没有 origin / trust 两列。开库时要补上，而且旧行读出来必须是 user/1.0 ——
// 旧的写入路径只消化用户自己的话，这是回溯正确，不是猜一个默认值。
const legacyFile = path.join(tmp, "legacy.db");
const legacy = new DatabaseSync(legacyFile);
legacy.exec(`CREATE TABLE memories (
  id TEXT PRIMARY KEY, content TEXT NOT NULL, summary TEXT, type TEXT NOT NULL, scope TEXT NOT NULL,
  scope_id TEXT, topic TEXT, importance REAL DEFAULT 0.5, decay_score REAL DEFAULT 1.0,
  state TEXT DEFAULT 'active', created_at INTEGER NOT NULL, last_accessed INTEGER,
  access_count INTEGER DEFAULT 0, source TEXT, metadata TEXT)`);
legacy.prepare(`INSERT INTO memories (id, content, type, scope, scope_id, created_at) VALUES (?,?,?,?,?,?)`).run("old1", "很老的一条记忆", "fact", "project", "P", 1);
legacy.close();

const reopened = openDb(legacyFile);
const old = getMemory(reopened, "old1")!;
assert.equal(old.origin, "user", "老记忆是用户原话（旧的写入路径只消化用户自己的话）");
assert.equal(old.trust, TRUST_USER, "老记忆不被当成推断，否则整库会突然全带标记");
assert.ok(buildInjectionBlock([old]).includes("很老的一条记忆"));
const cols = (reopened.db.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>).map((c) => c.name);
assert.ok(cols.includes("origin") && cols.includes("trust"), "缺列要补上（SQLite 的 ADD COLUMN）");
reopened.close();
console.log("✓ 老库自动补列，旧记忆读成 user/1.0");

project.close();
global.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n全部通过");
