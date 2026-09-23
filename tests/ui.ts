/**
 * 本地 UI 自检：页面能起、API 能查能删能复核，以及三条安全线。
 *
 * 跑法：node tests/ui.ts
 * 不联网（只打 127.0.0.1），不起浏览器。
 *
 * 最该钉的是第三条：**记忆原文是不可信输入**（§15 原则 14）。一条写着
 * `<img src=x onerror=alert(1)>` 的记忆，在页面上只能当文字显示，不许变成 DOM。
 * 所以页面里所有内容都用 textContent 拼，不用 innerHTML 拼数据。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reflect-ui-"));
process.env.REFLECTIVE_HOME = tmp;

import * as fss from "node:fs";
const { openDb, insertMemory, getMemory, countMemories, pendingReviews, enqueueReview } = await import("../src/storage/db.ts");
void fss;
const { startUi } = await import("../src/ui/server.ts");
const { queueTopicNaming } = await import("../src/pipeline/review.ts");

const project = openDb(path.join(tmp, "proj.db"));
const global = openDb(path.join(tmp, "global.db"));

const attack = insertMemory(project, { content: '正常内容 <img src=x onerror="alert(1)"> 后面还有', type: "fact", scope: "project", scopeId: "P", topic: "安全" });
insertMemory(project, { content: "认证走 OIDC", type: "fact", scope: "project", scopeId: "P" });
insertMemory(global, { content: "用户喜欢简洁回答", type: "preference", scope: "global", scopeId: null });
insertMemory(project, { content: "上一轮的临时状态", type: "event", scope: "session", scopeId: "s-old" });
enqueueReview(project, { kind: "merge", memoryId: attack.id, otherId: attack.id, question: "要合并吗", options: ["保留两条（并存）", "用新的取代旧的"] });

const ui = await startUi({ projectDb: project, globalDb: global, projectId: "P" });
const base = ui.url;
const authFile = path.join(tmp, "ui-auth.json");
const readAuthFile = () => { try { return JSON.parse(fs.readFileSync(authFile, "utf8")) as Record<string, unknown>; } catch { return null; } };

// ------------------------------------------------------------ 认证
const origin = new URL(base).origin;
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/$/, "只绑回环，地址里不再带 token");
const noSession = await fetch(origin + "/api/overview");
assert.equal(noSession.status, 401, "没登录就 401");
const setupPage = await fetch(origin + "/", { headers: { accept: "text/html" } });
assert.equal(setupPage.status, 200);
assert.match(await setupPage.text(), /设置账号密码/, "首次访问是设置页，不是面板");

// 表单 POST 会 303 回首页；测试里手动跟随，否则 fetch 自己跟了就拿不到原始状态码
const bad = await fetch(origin + "/api/setup", { method: "POST", redirect: "manual", body: new URLSearchParams({ username: "me", password: "short" }) });
assert.equal(bad.status, 303, "密码太短 → 退回设置页");
assert.equal(readAuthFile(), null, "不合格的密码不落盘");

const setup = await fetch(origin + "/api/setup", { method: "POST", redirect: "manual", body: new URLSearchParams({ username: "me", password: "s3cret-pass" }) });
assert.equal(setup.status, 303);
const cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0]!;
assert.match(cookie, /^rs_ui=/);
assert.equal(fs.statSync(authFile).mode & 0o777, 0o600, "账号文件必须 600");
assert.ok(!fs.readFileSync(authFile, "utf8").includes("s3cret-pass"), "不许明文存密码");

const authedGet = (p: string) => fetch(origin + p, { headers: { cookie } });
const authedPost = (p: string, body: unknown) => fetch(origin + p, { method: "POST", headers: { cookie, "x-csrf": "1" }, body: JSON.stringify(body) });
assert.equal((await authedGet("/api/overview")).status, 200, "带会话就能用");

// Cookie 会让跨站表单打过来，所以改状态的请求必须带自定义头（跨源发它要过 CORS 预检）
assert.equal((await fetch(origin + "/api/config", { method: "POST", headers: { cookie }, body: "{}" })).status, 403, "改状态的请求必须带 x-csrf");

const loginPage = await fetch(origin + "/", { headers: { accept: "text/html" } });
assert.equal(loginPage.status, 200);
const loginHtml = await loginPage.text();
assert.match(loginHtml, /登录/);
const wrong = await fetch(origin + "/api/login", { method: "POST", redirect: "manual", body: new URLSearchParams({ username: "me", password: "nope" }) });
assert.equal(wrong.status, 303);
assert.ok(!(wrong.headers.get("set-cookie") ?? "").includes("rs_ui="), "错密码不给会话");
assert.match(String(wrong.headers.get("location")), /^\/\?e=/, "退回登录页并带上原因");

const relogin = await fetch(origin + "/api/login", { method: "POST", redirect: "manual", body: new URLSearchParams({ username: "me", password: "s3cret-pass" }) });
const cookie2 = (relogin.headers.get("set-cookie") ?? "").split(";")[0]!;
assert.match(cookie2, /^rs_ui=/);
console.log("✓ 首次设置 → 登录 → 会话 cookie（密码 scrypt 加盐、文件 600、改状态要 x-csrf）");

const get = (p: string) => fetch(origin + p, { headers: { cookie: cookie2 } });
const post = (p: string, body: unknown) => fetch(origin + p, { method: "POST", headers: { cookie: cookie2, "x-csrf": "1" }, body: JSON.stringify(body) });
const del = (p: string) => fetch(origin + p, { method: "DELETE", headers: { cookie: cookie2, "x-csrf": "1" } });

// ------------------------------------------------------------ 页面本身
const pageRes = await get("/");
assert.equal(pageRes.status, 200);
const html = await pageRes.text();
assert.match(html, /textContent/, "内容必须用 textContent 拼，不许把记忆原文塞进 innerHTML");
assert.ok(!/innerHTML\s*=/.test(html), "页面里不该出现 innerHTML 赋值（记忆原文是不可信输入）");
assert.ok(!/\/t\//.test(html), "页面不再走 URL token（改成账号密码 + 会话）");
assert.ok(html.includes("me"), "页面里带当前账号名");
console.log("✓ 页面渲染只认 textContent，不把不可信的记忆原文当 DOM");

// ------------------------------------------------------------ 列表与过滤
const list = await (await get("/api/memories?scope=project")).json() as { items: Array<{ id: string; scope: string }> };
assert.equal(list.items.length, 3, "项目库视图列整个文件（含 session 作用域）");
assert.ok(list.items.some((m) => m.id === attack.id));
const onlyActive = await (await get("/api/memories?scope=project&state=active")).json() as { items: unknown[] };
assert.equal(onlyActive.items.length, 3, "都还是 active");
const byTopic = await (await get("/api/memories?scope=project&topic=安全")).json() as { items: Array<{ id: string }> };
assert.deepEqual(byTopic.items.map((m) => m.id), [attack.id]);
const glist = await (await get("/api/memories?scope=global")).json() as { items: Array<{ scope: string }> };
assert.equal(glist.items.length, 1);
assert.equal(glist.items[0].scope, "global");
const state = await (await get("/api/overview")).json() as { project: { count: number; topics: string[] }; global: { count: number }; pending: number };
assert.equal(state.project.count, 3);
assert.equal(state.global.count, 1);
assert.equal(state.pending, 1);
assert.ok(state.project.topics.includes("安全"));
console.log("✓ 列表 / 状态 / 主题过滤都能用");

// ------------------------------------------------------------ 轨迹与复核
// 概览 / 图谱 / 设置这三块是这轮新加的
const ov = await (await get("/api/overview")).json() as Record<string, any>;
assert.equal(ov.project.count, 3);
assert.equal(ov.project.byType.fact, 2);
assert.equal(ov.pending, 1);
assert.equal(ov.dupeCosine, 0.85);
assert.ok(Array.isArray(ov.registry) && Array.isArray(ov.recalls) && Array.isArray(ov.traces));

const graph = await (await get("/api/graph?scope=project")).json() as { nodes: Array<{ id: string }>; links: Array<{ source: string; target: string; kind: string }> };
assert.ok(graph.nodes.length >= 3, "图谱要有节点");
assert.ok(graph.nodes.every((n) => typeof n.id === "string"));

const cfgGet = await (await get("/api/config")).json() as { path: string; raw: Record<string, any> };
assert.equal(cfgGet.path, path.join(tmp, "config.json"));
assert.ok(!JSON.stringify(cfgGet).match(/sk-[A-Za-z0-9]{8,}/), "配置回给页面时不许带 key 的值");
fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ typesafe: { apiKey: "sk-abcdefgh12345", model: "jev-latest" } }), { mode: 0o600 });
fs.chmodSync(path.join(tmp, "config.json"), 0o600);
const masked = await (await get("/api/config")).json() as { raw: Record<string, any> };
assert.equal(masked.raw.typesafe.apiKey, "", "key 抹成空串");
assert.equal(masked.raw.typesafe.apiKeySet, 16, "只报长度");
const saved = await (await post("/api/config", { inject: { maxPerSession: 2 }, typesafe: { apiKey: "sk-new-key-123456" } })).json() as { raw: Record<string, any> };
assert.equal(saved.raw.typesafe.apiKey, "", "保存的响应也不回 key");
const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, "config.json"), "utf8")) as Record<string, any>;
assert.equal(onDisk.typesafe.apiKey, "sk-new-key-123456", "key 要真的写进文件");
assert.equal(onDisk.typesafe.model, "jev-latest", "没提到的字段不许被清掉");
assert.equal(onDisk.inject.maxPerSession, 2);
assert.equal(fs.statSync(path.join(tmp, "config.json")).mode & 0o777, 0o600, "写配置后权限必须是 600");
await post("/api/config", { typesafe: { apiKey: "" } });
assert.equal((JSON.parse(fs.readFileSync(path.join(tmp, "config.json"), "utf8")) as Record<string, any>).typesafe.apiKey, "sk-new-key-123456", "空值不覆盖已有配置");
assert.match(html, /textContent/, "内容必须用 textContent 拼");
console.log("✓ 概览 / 图谱 / 设置（key 只写不读、写回 600、空值不覆盖）");

const traces = await (await get(`/api/traces?scope=project&id=${attack.id}`)).json() as { items: unknown[] };
assert.equal(traces.items.length, 0, "手工插的没有轨迹");

const pending = (await (await get("/api/memories?scope=project")).json() as { pending: Array<{ id: string }> }).pending;
assert.equal(pending.length, 1);
const resolved = await (await post(`/api/review/${pending[0].id}`, { resolution: "保留两条（并存）" })).json() as { ok: boolean };
assert.equal(resolved.ok, true);
assert.equal(pendingReviews(project, 5).length, 0, "复核完就出队列");

// 起个主题（文本框那条路）
queueTopicNaming(project, insertMemory(project, { content: "灰度比例按 5% 起步", type: "procedure", scope: "project", scopeId: "P", importance: 0.9 }), []);
const topicItem = pendingReviews(project, 5)[0];
await post(`/api/review/${String(topicItem.id)}`, { resolution: "发布流程" });
const named = project.db.prepare(`SELECT topic FROM memories WHERE id = ?`).get(String(topicItem.memory_id)) as Record<string, unknown>;
assert.equal(named.topic, "发布流程", "页面起名要真的写进 topic");
console.log("✓ 复核与起名都能从页面走通");

// ------------------------------------------------------------ 节点详情（图谱点击）
const detail = await (await get(`/api/memory-detail?scope=project&id=${attack.id}`)).json() as { memory: { id: string }; paths: string[]; traces: unknown[] };
assert.equal(detail.memory.id, attack.id);
assert.ok(Array.isArray(detail.paths) && Array.isArray(detail.traces));
assert.equal((await get("/api/memory-detail?scope=project&id=nope")).status, 404);
console.log("✓ 节点详情：内容 + 路径 + 轨迹");

// ------------------------------------------------------------ 近义堆 + 手动合并
const { putEmbedding, getMemory: getM } = await import("../src/storage/db.ts");
const { embed, cosine } = await import("../src/embed/encoder.ts");
const twinA = insertMemory(project, { content: "日志统一用 logback，不要用 log4j2", type: "fact", scope: "project", scopeId: "P" });
const twinB = insertMemory(project, { content: "日志统一用 logback，不要用 log4j2 这个库", type: "fact", scope: "project", scopeId: "P" });
for (const m of [twinA, twinB]) putEmbedding(project, m.id, await embed(m.content));
const dupes = await (await get("/api/dupes?scope=project")).json() as { items: Array<{ a: string; b: string; sim: number }> };
const pair = dupes.items.find((p) => (p.a === twinA.id && p.b === twinB.id) || (p.a === twinB.id && p.b === twinA.id));
assert.ok(pair, `近义堆要能认出这一对，实际 ${JSON.stringify(dupes.items.map((p) => p.sim.toFixed(3)))}`);
assert.ok(pair!.sim >= 0.85);

const merged = await (await post("/api/merge", { keep: twinA.id, drop: twinB.id })).json() as { ok: boolean; result: string };
assert.equal(merged.ok, true);
assert.equal(getM(project, twinB.id)!.state, "superseded", "被合并的标成已取代");
assert.match(getM(project, twinA.id)!.metadata ?? "", /mergedFrom/, "旧原文存进保留那条的 metadata");
assert.match(getM(project, twinA.id)!.metadata ?? "", /不要用 log4j2 这个库/, "存的是 B 的原文");
console.log("✓ 近义堆能列出来，一键合并保留了旧原文（可查可回滚）");

// ------------------------------------------------------------ 删除（不可逆，要留痕）
const before = countMemories(project);
assert.equal((await del(`/api/memory/${attack.id}?scope=project`)).status, 200);
assert.equal(getMemory(project, attack.id), null);
assert.equal(countMemories(project), before - 1);
const delTrace = project.db.prepare(`SELECT reason FROM reflection_traces WHERE action = 'delete'`).get() as Record<string, unknown>;
assert.match(String(delTrace.reason), /本地 UI 手动删除/);
assert.equal((await del(`/api/memory/不存在?scope=project`)).status, 404);

// 跨库：全局库那条只能从 global 视图删
assert.equal((await del(`/api/memory/${String(global.db.prepare(`SELECT id FROM memories`).get()!.id)}?scope=global`)).status, 200);
assert.equal(countMemories(global), 0);
console.log("✓ 删除走对库、留痕、找不到就 404");

ui.close();
project.close();
global.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n全部通过");
