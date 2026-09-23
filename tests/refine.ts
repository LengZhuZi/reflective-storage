/**
 * 提炼层自检：OpenAI 兼容客户端的走线、提炼口径、主题提议、失败姿态。
 *
 * 跑法：node tests/refine.ts
 * 不联网：起一个本机假端点当「模型」，验证的是协议、解析、上限和降级，不是模型质量。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reflect-refine-"));
process.env.REFLECTIVE_HOME = tmp;

// ------------------------------------------------------------ 假模型端点
interface Seen { body: string; auth?: string }
const seen: Seen[] = [];
let reply = '{"summary": "缓存走本机 SQLite，没有 Redis 这一层。", "topic": "缓存策略"}';
let status = 200;
let delayMs = 0;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ body, auth: req.headers.authorization as string | undefined });
    setTimeout(() => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 200 ? JSON.stringify({ choices: [{ message: { content: reply } }] }) : "boom");
    }, delayMs);
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const baseUrl = `http://127.0.0.1:${port}/v1`;

process.env.REFLECTIVE_REFINE_PROVIDER = "custom";
process.env.REFLECTIVE_REFINE_BASE_URL = baseUrl;
process.env.REFLECTIVE_REFINE_MODEL = "test-model";
process.env.REFLECTIVE_REFINE_API_KEY = "test-key-not-a-real-one";

const { loadConfig, REFINE_PROVIDERS } = await import("../src/config.ts");
const { createRefiner, labelAll, parseRefinement, parseLabel, splitSections } = await import("../src/refine/refine.ts");
const { ChatClient } = await import("../src/refine/client.ts");
const { openDb, insertMemory, pendingReviews, distinctTopics } = await import("../src/storage/db.ts");
const { writeFlow, buildCandidate } = await import("../src/pipeline/write.ts");

// ------------------------------------------------------------ 配置
const cfg = loadConfig().refine;
assert.equal(cfg.provider, "custom");
assert.equal(cfg.baseUrl, baseUrl, "环境变量覆盖 baseUrl");
assert.deepEqual(cfg.problems, [], "配齐了就不该报问题");
assert.ok(REFINE_PROVIDERS.hunyuan?.baseUrl.includes("api.hunyuan.cloud.tencent.com"), "混元是登记过的 provider（OpenAI 兼容端点）");
assert.equal(REFINE_PROVIDERS.hunyuan?.model, "hunyuan-lite");
assert.equal(REFINE_PROVIDERS.ollama?.keyless, true, "本机 ollama 不需要 key");

// 没配 provider 就是关的：默认不调任何外部模型
const saved = { ...process.env };
for (const k of Object.keys(process.env)) if (k.startsWith("REFLECTIVE_REFINE_")) delete process.env[k];
const off = loadConfig().refine;
assert.equal(off.provider, "off");
assert.equal(createRefiner(off).available, false, "不配就是关的");
// 配了 provider 但缺 key：要能说出缺什么，而不是静默不干活
process.env.REFLECTIVE_REFINE_PROVIDER = "hunyuan";
const missing = loadConfig().refine;
assert.ok(missing.problems.some((p) => /key/.test(p)), `缺 key 要说出来，实际：${missing.problems.join(" / ")}`);
Object.assign(process.env, saved);
console.log("✓ 配置：provider 表 + 环境变量优先 + 不配就是关的（缺 key 会说）");

// ------------------------------------------------------------ 解析
assert.deepEqual(parseRefinement('```json\n{"summary":"S","topic":"T"}\n```'), { summary: "S", topic: "T" }, "包一层代码块也要能解析");
assert.deepEqual(parseRefinement("模型说了句废话。{\"summary\":\"S\",\"topic\":\"\"}"), { summary: "S", topic: "" });
assert.deepEqual(parseRefinement("完全不是 JSON"), { summary: "", topic: "" }, "解析不了当空，不当崩溃");

// ------------------------------------------------------------ 提炼
const refiner = createRefiner(cfg);
assert.equal(refiner.available, true);
const raw = "查完了：这个项目的缓存统一走本机 SQLite，没有 Redis。顺手把 config.json 的 timeoutMs 从 3 秒改成 8 秒，因为原来那个值在代理下会偶发超时。";
const first = await refiner.refine(raw, { project: "ReflectiveStorage", existingTopics: ["提交流程", "作用域"], maxChars: 120 });
assert.equal(first.status, "ok");
assert.equal(first.summary, "缓存走本机 SQLite，没有 Redis 这一层。");
assert.equal(first.topic, "缓存策略");
assert.equal(seen.length, 1);
const sent = JSON.parse(seen[0]!.body) as { model: string; messages: Array<{ role: string; content: string }>; temperature: number };
assert.equal(sent.model, "test-model");
assert.equal(seen[0]!.auth, "Bearer test-key-not-a-real-one", "OpenAI 兼容的鉴权头");
assert.equal(sent.temperature, 0, "提练要确定性的输出");
assert.match(sent.messages[0]!.content, /必须原样用它/, "提示里要写明「已有主题优先复用」（主题现在由模型直接定，不再问用户）");
// 提炼口径：一句话总结 = 下次问细节时只能看到一句抽象结论。要点式 + 具体名字/路径才对得上原文。
assert.match(sent.messages[0]!.content, /要点式/, "提示要要求要点式，不是一句话总结");
assert.match(sent.messages[0]!.content, /文件名、路径、接口名、版本号/, "要求写出细节：具体名字是这条记忆的值");
assert.match(sent.messages[1]!.content, /项目：ReflectiveStorage/, "取主题要结合项目");
assert.match(sent.messages[1]!.content, /提交流程 \/ 作用域/, "已有主题要传进去");
assert.match(sent.messages[1]!.content, /缓存统一走本机 SQLite/, "原文是输入");
console.log("✓ 提炼：一次调用拿 summary + topic，项目名 + 已有主题都进提示");

// 不听话的模型：超长截断、主题名不像名字就不认
reply = `{"summary":"${"很长的一句话。".repeat(60)}","topic":"这个主题名字实在太长了不像主题名"}`;
const clamped = await refiner.refine(raw, { existingTopics: [], maxChars: 60 });assert.ok(clamped.summary && clamped.summary.length <= 60, `超长要截断，实际 ${clamped.summary?.length}`);
assert.equal(clamped.topic, null, "不像主题名的提议直接丢掉");
// 回归：提示词明确要求「已有主题带了项目名前缀就原样用」，所以 19 字带前缀的主题是合规的。
// 旧的 12 字上限把它当垃圾丢掉，库里的 topic 就全空了（实测 tobacco-atlas 两条记忆都是 null）。
reply = '{"summary": "说了点事。", "topic": "tobacco-atlas掺配板设计"}';
const prefixed = await refiner.refine(raw, { existingTopics: [], maxChars: 120 });
assert.equal(prefixed.topic, "tobacco-atlas掺配板设计", "带项目名前缀的长主题要收下");
assert.match(prefixed.reason, /tobacco-atlas掺配板设计/, "收下的主题要写在 reason 里");
reply = '{"summary": "说了点事。", "topic": "一个带：冒号的坏名字"}';
const bad = await refiner.refine(raw, { existingTopics: [], maxChars: 120 });
assert.equal(bad.topic, null, "带标点的不是主题名");
assert.match(bad.reason, /不合规，弃用/, "弃用的提议也要在 reason 里看得见（否则分不清模型没给还是被挡了）");
reply = '{"summary": "", "topic": "缓存策略"}';
const empty = await refiner.refine(raw, { existingTopics: [], maxChars: 120 });
assert.equal(empty.status, "empty");
assert.equal(empty.summary, null, "模型说没有可保留的信息就不填");
console.log("✓ 提炼：超长截断、主题名校验、空结果不硬填");

// ------------------------------------------------------------ 切分：程序按结构切，模型只做标注
const secA = `## 一、缓存\n${"缓存统一走本机 SQLite，没有 Redis 这一层。".repeat(20)}`;
const secB = `## 二、提交\n${"提交一律一个模块一个提交，不要混在一起。".repeat(20)}`;
const secC = `## 三、发布\n${"发布先灰度 5% 再全量，别一次推完。".repeat(20)}`;
const doc = `${secA}\n\n${secB}\n\n${secC}`;
const blocks = splitSections(doc);
assert.equal(blocks.length, 3, "按 markdown 标题切成三段");
assert.equal(blocks.map((b) => b.length).join(","), [secA, secB, secC].map((b) => b.length).join(","), "切出来的就是原文逐字片段");
assert.equal(splitSections("## 只有一个标题\n内容很短").length, 1, "只有一节就不切");
// 没标题 → 按空行分段
const noHead = Array.from({ length: 4 }, (_, i) => `第 ${i + 1} 段。${"内容。".repeat(50)}`).join("\n\n");
assert.equal(splitSections(noHead, { maxChars: 200 }).length, 4, "无标题按空行分段（每段 < 上限就一段一块）");
assert.ok(splitSections(noHead, { maxChars: 200 }).join("").replace(/\s/g, "") === noHead.replace(/\s/g, ""), "空行切也不丢字");
// 超长单段 → 句子边界硬切，不丢字
const oneLine = "这句话没有换行。".repeat(200);
const hard = splitSections(oneLine, { maxChars: 100 });
assert.ok(hard.length > 1, "超长单段要硬切");
assert.equal(hard.join("").replace(/\s/g, "").length, oneLine.length, "硬切不许丢字（只允许丢空白）");
// 太短的碎片并回上一块（半行的小节不该单独成一条记忆）
const mixed = `## 一、长的一节\n${"内容内容内容。".repeat(40)}\n\n## 二、短的一节\n半行。`;
assert.equal(splitSections(mixed).length, 1, "短小节并回上一块");

// 块数上限：尾部合并，同样不丢字
const many = Array.from({ length: 9 }, (_, i) => `## ${i}\n${"内容内容内容。".repeat(20)}`).join("\n");
assert.equal(splitSections(many, { maxParts: 4 }).length, 4, "超过上限就合并尾部");
assert.equal(splitSections(many, { maxParts: 4 }).join("").replace(/\s/g, ""), many.replace(/\s/g, ""), "合并也不丢字");

// 模型侧：给切好的段写标注（一次调用）
reply = JSON.stringify({
  items: [
    { i: 1, summary: "缓存走本机 SQLite。", topic: "缓存策略" },
    { i: 2, summary: "提交一个模块一个。", topic: "提交流程" },
    { i: 3, summary: "", topic: "无所谓的名字" },
  ],
});
const lb = await refiner.label(blocks, { project: "P", existingTopics: ["提交流程"], maxChars: 120 });
assert.equal(lb.status, "ok");
assert.equal(lb.items.length, 3, "每段一条");
assert.equal(lb.items[0]!.summary, "缓存走本机 SQLite。");
assert.equal(lb.items[1]!.topic, "提交流程", "复用已有主题");
assert.equal(lb.items[2]!.summary, null, "模型说这段没价值就是 null（那一段原文照样存）");
assert.equal(lb.items[2]!.topic, null, "summary 为空的段不带主题");
const sentLabel = JSON.parse(seen.at(-1)!.body) as { messages: Array<{ content: string }> };
assert.match(sentLabel.messages[0]!.content, /已经被程序按结构切成 3 段/, "提示里要说清「分段是既定的」");
assert.match(sentLabel.messages[1]!.content, /【第 2 段】/, "段要编号送进去");
assert.match(sentLabel.messages[1]!.content, /提交一律一个模块一个提交/, "原文进提示（模型只看不改）");
// 解析容错：i 越界/缺项/乱序都按段号对齐
assert.deepEqual(parseLabel('{"items":[{"i":9,"summary":"x"},{"i":2,"summary":"y","topic":"t"}]}', 3, 120), [
  { summary: null, topic: null },
  { summary: "y", topic: "t" },
  { summary: null, topic: null },
]);
assert.deepEqual(parseLabel("不是 JSON", 2, 120), [{ summary: null, topic: null }, { summary: null, topic: null }]);
// H1 也起块；代码围栏里的 `# 注释` 不算标题
const h1doc = `# 一、大标题\n${"正文内容内容内容。".repeat(12)}\n\n## 二、小标题\n${"正文内容内容内容。".repeat(12)}`;
assert.deepEqual(splitSections(h1doc).map((b) => b.split("\n")[0]), ["# 一、大标题", "## 二、小标题"]);
const fenced = "## 一\n```bash\n# 这不是标题\necho hi\n```\n后面。";
assert.equal(splitSections(fenced).length, 1, "代码块里的 # 注释不当标题");

// 模型漏段要补问：整批 → 缺的那几段 → 还缺就一段一段
function fakeLabelRefiner(replies: Array<Array<{ summary: string | null; topic: string | null }>>) {
  let n = 0;
  return {
    available: true, model: "fake", problems: [],
    refine: async () => ({ summary: null, topic: null, status: "empty", model: "fake", latencyMs: 0, reason: "" }),
    label: async (bs: readonly string[]) => {
      const items = replies[Math.min(n++, replies.length - 1)] ?? bs.map(() => ({ summary: null, topic: null }));
      return { items, status: "ok", model: "fake", latencyMs: 1, reason: `fake(${bs.length})` };
    },
  } as never;
}
const four = ["a".repeat(200), "b".repeat(200), "c".repeat(200), "d".repeat(200)];
// 第一次只回第 1 段；补问只收到缺的第 2、3 段（回 1 条）；最后一段单独问
const ref = fakeLabelRefiner([
  // 第 1 批：4 段只回 1 条
  [{ summary: "s1", topic: "t1" }, { summary: null, topic: null }, { summary: null, topic: null }, { summary: null, topic: null }],
  // 补问那 3 段：只回 1 条（第 2 段）
  [{ summary: "s2", topic: "t2" }, { summary: null, topic: null }, { summary: null, topic: null }],
  // 剩下两段一段一段问
  [{ summary: "s3", topic: "t3" }],
  [{ summary: "s4", topic: "t4" }],
]);
const got = await labelAll(ref, four, { existingTopics: [], maxChars: 60 });
assert.deepEqual(got.items.map((i) => i.summary), ["s1", "s2", "s3", "s4"], "四段全补回来了");
assert.match(got.reason, /缺 3 段，补问拿回 3 段/, "补问结果要写进轨迹文案");
// 全缺 = 后端没在干活：不再重复问同一批
const idle = fakeLabelRefiner([four.map(() => ({ summary: null, topic: null }))]);
const none = await labelAll(idle, four, { existingTopics: [], maxChars: 60 });
assert.equal(none.items.filter((i) => i.summary).length, 0);
assert.ok(!/补问/.test(none.reason), "全缺就不补问（同一批输入再问一遍也不会变）");
// 一节里并排放着好几个「**名字** — 说明」时，要按它们切开（用户实测的痛点：
// 「## 4. 模块职责」里四个模块被压成一条 2400 字的记忆）
const mods = ["tobacco-datadistribution", "tobacco-calculation", "tobacco-hbaseinterface", "tobacco-visualsense"]
  .map((m, i) => `**${m}** — 第 ${i + 1} 个模块的说明。${"细节细节细节。".repeat(30)}`);
const dutyDoc = `## 4. 模块职责\n\n${mods.join("\n\n")}\n\n## 5. 数据管道\n\n${"管道说明。".repeat(40)}`;
const duty = splitSections(dutyDoc).filter((b) => b.includes("**tobacco-"));
assert.equal(duty.length, 4, "四个模块要拆成四条");
assert.ok(duty.every((b) => b.length < 800), "每条都是单个模块，不再是四合一");
// 行内加粗不算小标题（「问题清单」里一行一个问题，不能一行一条）
const inline = `## 问题清单\n\n${Array.from({ length: 4 }, (_, i) => `**高** ${i + 1}. 这里是第 ${i + 1} 个问题的描述，写长一点。${"细节。".repeat(30)}`).join("\n")}`;
assert.equal(splitSections(inline).length, 1, "行内加粗（后面跟正文）不算小节标题");
// 块数上限给得高：详细的分析不该被尾部合并揉成一条
const manySecs = Array.from({ length: 12 }, (_, i) => `## 第 ${i + 1} 节\n\n${"内容内容内容。".repeat(30)}`).join("\n\n");
assert.equal(splitSections(manySecs).length, 12, "12 节就是 12 条（上限 20）");
console.log("✓ 切分：结构切（H1–H4 / 小节内加粗标题 / 空行 / 句子边界，不丢字），模型标注漏段会补问");

// 端点挂了 → fail-open（存原文），而且要留下原因// 端点挂了 → fail-open（存原文），而且要留下原因
status = 500;
const failed = await refiner.refine(raw, { existingTopics: [], maxChars: 120 });
assert.equal(failed.status, "unavailable");
assert.equal(failed.summary, null, "提炼失败不能丢原文（调用方存原文）");
assert.match(failed.reason, /HTTP 500/);
status = 200;
const dead = await new ChatClient({ apiKey: "k", baseUrl: "http://127.0.0.1:1/v1", model: "m", timeoutMs: 400 }).complete([{ role: "user", content: "x" }]).then(() => "ok").catch((e: Error) => e.message);
assert.match(dead, /连不上|超时/, `连不上要报清楚，实际：${dead}`);
// 提炼默认**不超时**（timeoutMs = 0）：慢的端点也得等出摘要来 —— 超时 = 静默存原文，
// 表现就像“提炼得真烂”（实测 6465 字全文 glm-4-flash 要 11.2s，旧的 8s 全部超时）。
delayMs = 300;
const patient = new ChatClient({ apiKey: "k", baseUrl, model: "m", timeoutMs: 0 });
assert.match(await patient.complete([{ role: "user", content: "x" }]), /summary/, "timeoutMs=0 表示不设上限，慢也要等出结果");
delayMs = 0;
console.log("✓ 失败姿态：提炼挂了照样写原文，错误原因落轨迹");

// ------------------------------------------------------------ 写进库：提炼版放 summary，原文进 content，主题由模型直接定
const project = openDb(path.join(tmp, "proj.db"));
const global = openDb(path.join(tmp, "global.db"));
const session = { sessionId: "s1", cwd: tmp, projectId: "P", injectedIds: new Set<string>() };
const topicsSeen: string[] = [];
function fakeAdapter(topic: string | null) {
  return {
    async judgeWrite(_c: string, _ctx: string, _cands: unknown, topics: string[] = []) {
      topicsSeen.push(...topics);
      return {
        worthKeeping: { noul: 0.9 },
        type: { choice: "fact", confidence: 0.9, probabilities: {} },
        scope: { choice: "project", confidence: 0.9, probabilities: {} },
        relation: { choice: "none", confidence: 0.8, probabilities: {} },
        targetId: null,
        topic,
        meta: { gate: "J1+J2+J3", fallbackUsed: "none", status: "ok", latencyMs: 5 },
      };
    },
  } as never;
}

// (a) 全新主题名 → 直接落库，不进复核队列（主题由模型定，不再让用户点）
const res1 = await writeFlow(project, global, fakeAdapter(null), session, {
  userTexts: [raw], context: "", origin: "agent", agentVerified: true,
  refinement: { summary: "缓存走本机 SQLite。", topic: "缓存策略" },
});
assert.ok(res1.memory);
assert.equal(res1.memory.summary, "缓存走本机 SQLite。", "提炼版进 summary");
// content 走的是 buildCandidate（按句拼回），但**信息一点不少** —— 提炼不许覆盖原文。
assert.equal(res1.memory.content, buildCandidate({ userTexts: [raw], context: "", origin: "agent", agentVerified: true }), "content 必须还是原文");
assert.ok(res1.memory.content.includes("timeoutMs"), "原文里的细节不能因为提炼就没了");
assert.equal(res1.memory.topic, "缓存策略", "模型给的主题直接落库");
const queued = pendingReviews(project, 10).filter((r) => r.kind === "topic");
assert.equal(queued.length, 0, "主题不再进复核队列");
assert.ok(distinctTopics(project).includes("缓存策略"), "主题表里真的有了这个名字");

// (b) 提议的名字已经在主题表里 → 复用同一个名字（不会碎出第二个）
insertMemory(project, { content: "提交按模块拆，一个提交一件事。", type: "preference", scope: "project", scopeId: "P", topic: "提交流程" });
const res2 = await writeFlow(project, global, fakeAdapter(null), session, {
  userTexts: ["提交一律一个模块一个提交，不要混。"], context: "", origin: "agent", agentVerified: true,
  refinement: { summary: "提交一个模块一个。", topic: "提交流程" },
});
assert.ok(res2.memory);
assert.equal(res2.memory.topic, "提交流程", "已有的主题名直接复用");
assert.equal(pendingReviews(project, 10).filter((r) => r.kind === "topic").length, 0);

// (c) 引擎自己挑出了主题 → 提炼的主题提议不参与
// (c) 主题一律由模型生成：提炼层给了名字就用它的，引擎只兜底
const res3 = await writeFlow(project, global, fakeAdapter("引擎选的主题"), session, {
  userTexts: ["命名空间统一用 rs_ 前缀。"], context: "", origin: "agent", agentVerified: true,
  refinement: { summary: "命名空间统一 rs_ 前缀。", topic: "另一个名字" },
});
assert.equal(res3.memory!.topic, "另一个名字", "模型生成优先于引擎挑选");
const res3b = await writeFlow(project, global, fakeAdapter("引擎选的主题"), session, {
  userTexts: ["缓存键带上项目名，别用全局 key。"], context: "", origin: "agent", agentVerified: true,
  refinement: { summary: "缓存键带项目名。" },
});
assert.equal(res3b.memory!.topic, "引擎选的主题", "提炼层没给主题时，引擎挑的那个兜底");

// (d) 没配提炼（没有 refinement 字段）→ 行为跟以前一样：summary 空，content 是原文
const res4 = await writeFlow(project, global, fakeAdapter(null), session, {
  userTexts: ["日志用 logback，不用 log4j2。"], context: "", origin: "agent", agentVerified: true,
});
assert.equal(res4.memory!.summary, null, "没提炼就 summary 空");
assert.equal(res4.memory!.content, "日志用 logback，不用 log4j2。");
assert.ok(topicsSeen.length > 0, "已有主题要传给引擎（J4 只能在已有主题里挑）");

// (e) 用户侧的记忆也要主题：引擎挑不出来 → 提炼层现场生成一个（只问名字）
const asked: string[] = [];
const res5 = await writeFlow(project, global, fakeAdapter(null), session, {
  userTexts: ["以后回答都先给结论，再展开。"], context: "",
  topicProposer: async (c) => { asked.push(c); return "回答风格"; },
});
assert.equal(res5.memory!.topic, "回答风格", "用户侧靠提炼层现场生成主题");
assert.equal(res5.memory!.summary, null, "用户侧不提炼 summary（原文就是内容）");
assert.equal(asked.length, 1, "proposer 调一次");
const topicTrace = project.db.prepare(`SELECT gate, action FROM reflection_traces WHERE gate = 'refine' AND action = 'topic'`).get() as Record<string, unknown> | undefined;
assert.ok(topicTrace, "现场生成的主题要留痕");
// 引擎自己挑到了就不该再花一次提炼调用
const asked2: string[] = [];
const res6 = await writeFlow(project, global, fakeAdapter("提交流程"), session, {
  userTexts: ["这条引擎自己挑得到主题。"], context: "",
  topicProposer: async (c) => { asked2.push(c); return "不该用它"; },
});
assert.equal(res6.memory!.topic, "提交流程");
assert.equal(asked2.length, 0, "引擎挑到了就不调提炼层（省一次调用）");
// 提议挂了不影响落库
const res7 = await writeFlow(project, global, fakeAdapter(null), session, {
  userTexts: ["提炼层挂了也要把这条存下来。"], context: "",
  topicProposer: async () => { throw new Error("boom"); },
});
assert.equal(res7.action, "stored");
assert.equal(res7.memory!.topic, null, "拿不到名字就留空，不当失败");
console.log("✓ 落库：提炼进 summary、原文进 content、主题直接落库（不进队列）");

// ------------------------------------------------------------ 注入按提炼算预算
const { buildInjectionBlock, fitBudget, estimateTokens } = await import("../src/pipeline/inject.ts");
const fatMemory = insertMemory(project, { content: "x".repeat(2000), summary: "短提炼", type: "fact", scope: "project", scopeId: "P", importance: 0.5 });
const block = buildInjectionBlock([fatMemory]);
assert.match(block, /短提炼/, "注入块用提炼版");
assert.ok(!block.includes("x".repeat(50)), "注入块不该把长原文倒进去");
assert.equal(fitBudget([{ memory: fatMemory }], 20).length, 1, "预算按提炼算：2000 字原文提炼成 3 个字就该装得下");
assert.ok(estimateTokens(fatMemory.summary!) < 20);
console.log("✓ 注入：默认给提炼版，token 预算按提炼算（否则长记忆会被预算误杀）");

server.close();
project.close();
global.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n全部通过");
