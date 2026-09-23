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

const { openDb, countMemories, listInScope, insertMemory, putEmbedding, getMemory } = await import("../src/storage/db.ts");
const { embed } = await import("../src/embed/encoder.ts");
const { writeFlow, worthEvaluating, buildCandidate, splitForWrite, MAX_WRITES_PER_TURN, redact, KEEP_THRESHOLD } = await import("../src/pipeline/write.ts");

const project = openDb(path.join(tmp, "proj.db"));
const global = openDb(path.join(tmp, "global.db"));
const session = { sessionId: "s1", cwd: tmp, projectId: "P", injectedIds: new Set<string>() };

/** 假 adapter：只实现 writeFlow 用到的那一个方法。 */
function fakeAdapter(worth: number, opts: { scope?: "global" | "project" | "session"; relation?: string; fail?: boolean; confidence?: number; type?: string; seen?: string[]; seenTopics?: string[]; topic?: string | null; importance?: number } = {}) {
  return {
    async judgeWrite(_content: string, _context: string, candidates: Array<{ content: string }>, topics: string[] = []) {
      opts.seen?.push(...candidates.map((c) => c.content));
      opts.seenTopics?.push(...topics);
      return {
        worthKeeping: { noul: worth },
        type: { choice: opts.type ?? "event", confidence: opts.confidence ?? 0.9, probabilities: {} },
        scope: { choice: opts.scope ?? "project", confidence: opts.confidence ?? 0.9, probabilities: {} },
        relation: { choice: opts.relation ?? "none", confidence: 0.8, probabilities: {} },
        targetId: null,
        topic: opts.topic ?? null,
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
// 真跑 pi 发现：用户的一句问句被 J1 判成值得存（1.00），问题本身变成了记忆。
assert.equal(worthEvaluating("这个仓库提交的时候要怎么拆？只按你已知的信息答").ok, false, "问句不是记忆");
assert.equal(worthEvaluating("这个仓库提交的时候要怎么拆？").ok, false);
assert.equal(worthEvaluating("Why is the build failing?").ok, false);
assert.equal(worthEvaluating("记住：上线前为什么要先跑一遍 index 重建？").ok, true, "带明确要求的问题句必须留");
assert.equal(worthEvaluating("以后这个仓库的提交都必须一个模块一个提交").ok, true, "陈述句照常");
// 一句话里夹问句：提问要剔掉，陈述要留下（实测这样存出来的记忆才干净）
assert.equal(
  buildCandidate({ userTexts: ["这个仓库提交的时候要怎么拆？另外以后提交都必须一个模块一个提交"], context: "" }),
  "另外以后提交都必须一个模块一个提交",
  "夹在陈述里的提问不该被存进记忆",
);
assert.equal(buildCandidate({ userTexts: ["怎么拆？"], context: "" }), "", "整句都是提问就什么都不存");
assert.equal(
  buildCandidate({ userTexts: ["记住：上线前为什么要先跑一遍 index 重建？"], context: "" }),
  "记住：上线前为什么要先跑一遍 index 重建？",
  "带明确要求的问题句照样留",
);
console.log("✓ 本地预筛挡掉短输入和纯确认（这一步免费，JEV 才是花钱的）");

// 一轮里几句话就分几条记忆：整段写会把项目约定和用户偏好挤进同一条，
// 类型/作用域只能选一个 —— 用户偏好被锁进单个项目就再也跟不走了（真跑 pi 撞到）
assert.deepEqual(
  splitForWrite(["以后提交都必须一个模块一个提交。另外我一般喜欢先给结论再给理由。"]),
  ["以后提交都必须一个模块一个提交。", "另外我一般喜欢先给结论再给理由。"],
);
assert.deepEqual(splitForWrite(["只有一句"]), ["只有一句"]);
assert.deepEqual(splitForWrite(["这个怎么拆？另外以后都用 Flyway。"]), ["另外以后都用 Flyway。"], "纯提问的句子仍然剔掉");
const many = splitForWrite([Array.from({ length: 6 }, (_, i) => `第 ${i} 句都要记住的话。`).join("")]);
assert.equal(many.length, MAX_WRITES_PER_TURN, "最多 3 条，多的并进最后一条，别爆炸");
console.log("✓ 一轮多句 → 拆成多条记忆（类型/作用域各自算），上限 3 条");

// ------------------------------------------------------------ 脱敏
const dirty = "配置写到 sk-abcdefghijklmnop 里，apikey_TESTFIXTURE0000001 也是，password: hunter2";
const clean = redact(dirty);
assert.ok(!clean.includes("sk-abcdefghijklmnop"), "sk- 形态的密钥必须被洗掉");
assert.ok(!clean.includes("apikey_TESTFIXTURE0000001"), "apikey_ 形态的密钥必须被洗掉");
assert.ok(!clean.includes("hunter2"), "password: 后面的值必须被洗掉");
console.log("✓ 落盘前脱敏（记忆库会被注入到每一次对话里，凭据进去就洗不干净）");

// 真跑 pi 存进过库的两种形态（见 redact 的注释）：DSN 里的明文口令、中文口语写法。
assert.equal(
  redact("现在这台是 postgresql://readonly:S3cr3tP%40ss@10.0.0.5:5432/prod"),
  "现在这台是 postgresql://readonly:***@10.0.0.5:5432/prod",
  "连接串里的明文口令必须洗掉，主机和库名要留着（那是这条记忆有用的部分）",
);
assert.equal(redact("mysql://root:hunter2@10.1.2.3:3306/db"), "mysql://root:***@10.1.2.3:3306/db");
assert.equal(redact("redis://:s3cret@10.1.2.3:6379"), "redis://:***@10.1.2.3:6379", "用户名可以为空");
assert.equal(redact("密码是 hunter2"), "***", "中文口语写法（是）也要认");
assert.equal(redact("口令：hunter2"), "***");
assert.equal(redact("这台机器上 pnpm 装依赖"), "这台机器上 pnpm 装依赖", "没有凭据的正常句子不许动");
assert.equal(redact("数据库连接串从 DB_URL 读"), "数据库连接串从 DB_URL 读", "提到环境变量名不是凭据");
// 洗到标点就停：中文没有空格，「密码是hunter2，其它照旧」不能把后半句一起吃掉
assert.equal(redact("密码是hunter2，其它照旧"), "***，其它照旧");
assert.equal(redact("token是abc123；部署到 pre"), "***；部署到 pre");
assert.equal(redact("https://github.com/org/repo 这个仓库"), "https://github.com/org/repo 这个仓库", "没有口令的普通链接不许动");
assert.equal(
  redact("提交前先跑 tests/lifecycle.ts"),
  "提交前先跑 tests/lifecycle.ts",
  "/ 和 . 不能被当成 DSN",
);
console.log("✓ 脱敏覆盖 DSN 明文口令与中文写法，且不误伤正常句子");

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

// 真跑 pi 时发现的：引擎挂了、规则兜底给 0.2，记忆就被静默丢了 —— 那是 fail-closed。
const r6 = await writeFlow(project, global, fakeAdapter(0.2, { fail: true }), session, {
  userTexts: ["以后提交之前都先跑一遍测试再提"], context: "",
});
assert.equal(r6.action, "stored", "引擎不可用时不许卡写入闸（§6.1 fail-open：丢记忆 > 存噪声）");
assert.ok(r6.memory!.importance <= 0.35, "照存但要压低重要性，否则噪声会盖过正常记住的东西");
console.log("✓ 引擎不可用时照存（fail-open 不被阈值吃掉），重要性压到 0.3");

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

// ------------------------------------------------------------ J14b：作用域只许收窄
const p0 = countMemories(project);
const g0 = countMemories(global);
const low = await writeFlow(project, global, fakeAdapter(0.8, { scope: "global", confidence: 0.55 }), session, {
  userTexts: ["迁移前必须先备份整个库再执行"],
  context: "",
});
assert.equal(low.memory?.scope, "project", "引擎说 global 但只有 0.55 置信度：必须收窄，否则这条会跑去别的项目");
assert.equal(countMemories(global), g0, "低置信的 global 不许进全局库");
assert.equal(countMemories(project), p0 + 1);
const lowTrace = project.db.prepare(`SELECT judgment, user_visible FROM reflection_traces WHERE memory_id = ?`).get(low.memory!.id) as Record<string, unknown>;
assert.equal(lowTrace.judgment, "rule", "走的是规则复核，要留痕");
assert.match(String(lowTrace.user_visible), /规则复核/);

const high = await writeFlow(project, global, fakeAdapter(0.8, { scope: "global", confidence: 0.99 }), session, {
  userTexts: ["我平时喜欢先看结论再看细节"],
  context: "",
});
assert.equal(high.memory?.scope, "global", "置信度够高就原样采用，不能把用户偏好也收窄掉");
assert.equal(countMemories(global), g0 + 1);
const highTrace = global.db.prepare(`SELECT judgment, user_visible FROM reflection_traces WHERE memory_id = ?`).get(high.memory!.id) as Record<string, unknown>;
assert.equal(highTrace.judgment, "auto");
assert.equal(highTrace.user_visible, "记住了这条（引擎判断）");
console.log("✓ J14b 置信度分级：0.55 的 global 收窄到 project，0.99 的原样进全局库");

// ------------------------------------------------------------ J15：每次召回登记一条
const projectDb = await import("../src/storage/db.ts");
projectDb.recordRecall(project, { sessionId: "s1", query: "迁移工具", recalledIds: ["a"], injectedIds: ["a"] });
const logged = projectDb.recentRecalls(project, 5) as Array<Record<string, unknown>>;
assert.equal(logged.length, 1, "召回过就该有记录（J15 轻量反馈）");
assert.equal(logged[0].query, "迁移工具");
assert.deepEqual(JSON.parse(String(logged[0].injected_ids)), ["a"]);
assert.equal(logged[0].cited_ids, null, "刚登记时 cited 还是空的（要等 agent_end 事后核对）");
console.log("✓ J15 召回日志：只记事实，cited / user_feedback 留空");

// ------------------------------------------- J3 候选要「最相关」而不是「最近入库的 20 条」
const oldShadow = insertMemory(project, { content: "影子强度按立面高度算，不要按海拔调", type: "fact", scope: "project", scopeId: "P" });
// 真实写入路径会给每条记忆算 embedding（write.ts 里的 putEmbedding），这里要照着做：
// 没有向量的记忆只能靠「最近」排序，那不是这条断言要测的东西。
putEmbedding(project, oldShadow.id, await embed(oldShadow.content));
for (let i = 0; i < 25; i++) {
  insertMemory(project, { content: `第 ${i} 条构建日志：esbuild 打包参数与缓存命中情况 -${i}`, type: "event", scope: "project", scopeId: "P" });
}
const seen: string[] = [];
await writeFlow(project, global, fakeAdapter(0.9, { seen }), session, {
  userTexts: ["影子强度以后都按立面高度算"], context: "",
});
assert.ok(
  seen.some((c) => c.includes("影子强度按立面高度算")),
  "很久以前的那条相关记忆必须进候选 —— 按「最近 20 条」取的话它早被 25 条日志挤出去了（实测过）",
);
assert.ok(seen.length <= 20, "候选还是压在 20 条以内（§4.1 实测的高区分度区间）");

// global 记忆也要参与冲突判断（原来候选只查项目库，global 从来没进过 J3 的视野）
const gPref = insertMemory(global, { content: "用户偏好：回答先给结论，再给理由", type: "preference", scope: "global", scopeId: null });
putEmbedding(global, gPref.id, await embed(gPref.content));
const seenGlobal: string[] = [];
await writeFlow(project, global, fakeAdapter(0.9, { seen: seenGlobal }), session, {
  userTexts: ["回答都先给结论再解释，别绕"], context: "",
});
assert.ok(seenGlobal.some((c) => c.includes("先给结论")), "global 库里的记忆也要进候选");
console.log("✓ J3 候选按相关性取（很旧的相关记忆也进得来），且 global 库参与冲突判断");

// ------------------------------------------------------------ J4：主题
// 引擎只能在**已有主题**里挑（不许生成新词），所以现有主题要送进 state
const firstTopics: string[] = [];
const withTopic = await writeFlow(project, global, fakeAdapter(0.9, { topic: "提交与发布", seenTopics: firstTopics }), session, {
  userTexts: ["发布先灰度 5% 再全量，别一次推完"], context: "",
});
assert.equal(withTopic.memory?.topic, "提交与发布", "引擎选的主题要落库");
assert.ok(!firstTopics.includes("提交与发布"), "第一次写的时候这个主题还不存在（主题表是写入前读的）");
const secondTopics: string[] = [];
await writeFlow(project, global, fakeAdapter(0.9, { topic: "提交与发布", seenTopics: secondTopics }), session, {
  userTexts: ["发布前的检查清单必须先跑一遍"], context: "",
});
assert.ok(secondTopics.includes("提交与发布"), "之后写的时候，已有主题要出现在给引擎的选项里");
// 引擎挑不出主题（none）且足够重要 → 排一条「要不要起个主题」给用户
const naming = await writeFlow(project, global, fakeAdapter(0.95, { importance: 0.95, topic: null }), session, {
  userTexts: ["灰度发布的比例以后都按 5% 起步"], context: "",
});
assert.ok(JSON.stringify(naming.review ?? []).includes("起个主题"), "没主题又重要的记忆，要问用户起名（引擎不许造词）");
console.log("✓ J4 主题：引擎在已有主题里挑、落库、不重复问用户");


// ------------------------------------------------------------ 断言常量
assert.ok(KEEP_THRESHOLD > 0.2 && KEEP_THRESHOLD < 0.86, "阈值必须落在实测的无关(0.2)和明确要求(0.86)之间");

// ------------------------------------------------------------ 精确查重（真跑 pi 发现的）
// 实测：模型在对话里调了 memory_add，agent_end 又把用户原话存一次 —— 同一条约定两行。
// 重复会白占注入预算，所以归一化后完全相同的就不再存，也不花钱调 JEV。
const beforeDup = countMemories(project);
const dup1 = await writeFlow(project, global, fakeAdapter(0.9), session, {
  userTexts: ["部署前必须先跑一遍 index 重建"],
  context: "",
});
const dup2 = await writeFlow(project, global, fakeAdapter(0.9), session, {
  userTexts: ["部署前必须先跑一遍  index 重建！"],
  context: "",
});
assert.equal(dup1.action, "stored");
assert.equal(dup2.action, "duplicate", "只有空白和标点不同的一句话不该再存一遍");
assert.equal(countMemories(project), beforeDup + 1);
const dupTrace = project.db.prepare(`SELECT action, reason FROM reflection_traces WHERE gate = 'dedup'`).get() as Record<string, unknown>;
assert.equal(dupTrace.action, "duplicate");
assert.ok(String(dupTrace.reason).includes(dup1.memory!.id.slice(0, 8)), "留痕要指向被撞上的那条");
console.log("✓ 精确查重：归一化后相同就不第二遍存，也不花 JEV 调用");

// ------------------------- >0.8 的取代自动执行（贪吃蛇 demo 验出来的）
// 「音效不做」→「音效加上」这类改口，够确信就该把旧的标掉，否则两条并存、召回给哪条看运气。
const oldRule = insertMemory(project, { content: "这个 demo 不要音效", type: "preference", scope: "project", scopeId: "P" });
const changed = await writeFlow(project, global, {
  async judgeWrite() {
    return {
      worthKeeping: { noul: 0.9 },
      type: { choice: "preference", confidence: 0.9, probabilities: {} },
      scope: { choice: "project", confidence: 0.9, probabilities: {} },
      relation: { choice: "supersedes", confidence: 0.92, probabilities: {} },
      targetId: oldRule.id,
      topic: null,
      meta: { gate: "J1+J2+J3", fallbackUsed: "none", status: "ok", latencyMs: 5 },
    };
  },
} as never, session, { userTexts: ["音效改成吃到食物叮一声"], context: "" });
assert.equal(changed.action, "stored");
assert.equal(getMemory(project, oldRule.id)!.state, "superseded", ">0.8 的取代直接把旧那条标掉（§6 的「直接执行」）");
assert.equal((changed.review ?? []).filter((x) => x.kind === "conflict" || x.kind === "merge").length, 0, "自动执行了就不该再问冲突/合并（主题那条问不问是另一回事）");
const sup = project.db.prepare(`SELECT action FROM reflection_traces WHERE action = 'superseded'`).get() as Record<string, unknown>;
assert.equal(sup.action, "superseded", "自动取代要留痕");
console.log("✓ >0.8 的取代自动标掉旧记忆（不再两条并存）");

// -------------------------------------- J11 自动合并（引擎判定同一件事才合）
// 触发用本地判据（连续片段 ≥6 或余弦 ≥0.85），**决定**交给引擎 —— 实测只差一个项目名的
// 两条记忆余弦 0.953，比真重复（模型转述 0.797）还高，所以余弦只能当触发器。
const nearDup = insertMemory(project, { content: "部署前必须先跑一遍 index 重建", type: "procedure", scope: "project", scopeId: "P" });
const withMerge = (score: number, onlyId?: string) => ({
  async judgeWrite() {
    return {
      worthKeeping: { noul: 0.9 }, type: { choice: "procedure", confidence: 0.9, probabilities: {} },
      scope: { choice: "project", confidence: 0.9, probabilities: {} },
      relation: { choice: "none", confidence: 0.9, probabilities: {} }, targetId: null, topic: null,
      meta: { gate: "J1+J2+J3", fallbackUsed: "none", status: "ok", latencyMs: 3 },
    };
  },
  async judgeMerge(_m: unknown, cands: Array<{ id: string }>) {
    const out = new Map(cands.map((c) => [c.id, onlyId && c.id !== onlyId ? 0.02 : score]));
    return Object.assign(out, { meta: { gate: "J11", fallbackUsed: "none", status: "ok", latencyMs: 3 } });
  },
} as never);

const auto = await writeFlow(project, global, withMerge(0.96, nearDup.id), session, {
  // 换个说法（不是只改标点）：只改标点会被精确查重先挡掉，就走不到 J11 这条路了
  userTexts: ["部署前要先跑一遍 index 重建才行"], context: "",
});
assert.equal(auto.merged, 1, "引擎说 0.96 是同一件事 → 自动合并");
assert.equal(getMemory(project, nearDup.id)!.state, "superseded", "旧的标成已取代");
const survivorMeta = getMemory(project, auto.memory!.id)!.metadata ?? "";
assert.match(survivorMeta, /mergedFrom/, "旧原文存进新的 metadata（合并不可逆，要留退路）");
assert.match(survivorMeta, /部署前必须先跑一遍 index 重建/, "旧原文真的在里面");
const mergeTrace = project.db.prepare(`SELECT action FROM reflection_traces WHERE gate = 'J11' AND action = 'merge'`).get() as Record<string, unknown>;
assert.equal(mergeTrace.action, "merge", "自动合并要留痕");

// 中间档（0.7–0.9）不自动合并，问用户
const midNear = insertMemory(project, { content: "灰度发布比例先从 5% 起步，再逐步放量", type: "procedure", scope: "project", scopeId: "P" });
const mid = await writeFlow(project, global, withMerge(0.8, midNear.id), session, {
  userTexts: ["灰度发布比例先从 5% 起步再放量"], context: "",
});
assert.equal(mid.merged, 0, "0.8 这一档不自动合并");
assert.equal(getMemory(project, midNear.id)!.state, "active", "中间档不许动数据");
assert.ok((mid.review ?? []).some((r) => r.kind === "merge"), "中间档要问用户（合并提议）");
console.log("✓ J11 自动合并：≥0.9 自动合（旧原文留 metadata），0.7–0.9 问用户");

project.close();
global.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n全部通过");
