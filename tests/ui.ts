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

const { openDb, insertMemory, getMemory, countMemories, pendingReviews, enqueueReview } = await import("../src/storage/db.ts");
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
// 去掉尾斜杠方便拼路径
const t = base.replace(/\/$/, "");
const get = (p: string) => fetch(t + p);
const post = (p: string, body: unknown) => fetch(t + p, { method: "POST", body: JSON.stringify(body) });
const del = (p: string) => fetch(t + p, { method: "DELETE" });

// ------------------------------------------------------------ 绑定与 token
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/t\/[0-9a-f]{32}\/$/, "只绑回环 + URL 带 token");
const noToken = await fetch(`http://127.0.0.1:${new URL(base).port}/api/state`);
assert.equal(noToken.status, 403, "不带 token 一律 403（回环地址不是安全边界：别的进程/网页也能打 localhost）");
const wrongToken = await fetch(`http://127.0.0.1:${new URL(base).port}/t/deadbeef/api/state`);
assert.equal(wrongToken.status, 403);
console.log("✓ 只绑 127.0.0.1，URL 里的 token 是访问凭证，错了就 403");

// ------------------------------------------------------------ 页面本身
const pageRes = await get("/");
assert.equal(pageRes.status, 200);
const html = await pageRes.text();
assert.match(html, /textContent/, "内容必须用 textContent 拼，不许把记忆原文塞进 innerHTML");
assert.ok(!/innerHTML\s*=/.test(html), "页面里不该出现 innerHTML 赋值（记忆原文是不可信输入）");
const token = new URL(base).pathname.split("/")[2];
assert.ok(token && html.includes(token), "页面里带着自己的 token（否则前端请求全 403）");
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
const state = await (await get("/api/state")).json() as { project: number; global: number; pending: number; topics: string[] };
assert.equal(state.project, 3);
assert.equal(state.global, 1);
assert.equal(state.pending, 1);
assert.ok(state.topics.includes("安全"));
console.log("✓ 列表 / 状态 / 主题过滤都能用");

// ------------------------------------------------------------ 轨迹与复核
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
