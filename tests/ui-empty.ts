/**
 * 空库自检：一个项目库都没有的时候，面板也必须能打开。
 *
 * 跑法：node tests/ui-empty.ts
 *
 * 为什么要单独一个文件：`REFLECTIVE_HOME` 在模块加载时就定死了（`config.ts` / `db.ts` 的 ROOT
 * 是模块级常量），所以「空库」这件事没法在 tests/ui.ts 里造 —— 那边已经带着数据了。
 * 而空库恰恰是**最常遇到**的一种状态：新装机、刚清空、或者还没在任何项目里跑过 pi。
 * 之前这里会 500（`sources[0]!.db` 直接炸），页面白屏比「没有记忆」难受得多。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reflect-ui-empty-"));
process.env.REFLECTIVE_HOME = tmp;

const { startUi } = await import("../src/ui/server.ts");

const projectDir = path.join(tmp, "projects");
fs.mkdirSync(projectDir, { recursive: true });
assert.deepEqual(fs.readdirSync(projectDir), [], "前提：一个项目库都没有");

const ui = await startUi({});
const origin = new URL(ui.url).origin;
await fetch(`${origin}/api/setup`, { method: "POST", redirect: "manual", body: new URLSearchParams({ username: "me", password: "s3cret-pass" }) });
const login = await fetch(`${origin}/api/login`, { method: "POST", redirect: "manual", body: new URLSearchParams({ username: "me", password: "s3cret-pass" }) });
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
const get = (p: string) => fetch(origin + p, { headers: { cookie } });

for (const p of ["/api/overview?scope=all", "/api/overview", "/api/graph?scope=all", "/api/memories?scope=all", "/api/dupes?scope=all"]) {
  const r = await get(p);
  assert.equal(r.status, 200, `${p} 在空库下也要是 200，实际 ${r.status}：${(await r.text()).slice(0, 120)}`);
}

const ov = (await (await get("/api/overview?scope=all")).json()) as { isAll: boolean; project: { count: number; topics: string[] }; global: { count: number }; projects: unknown[] };
assert.equal(ov.isAll, true);
assert.equal(ov.project.count, 0, "空库就是 0 条，不许编");
assert.equal(ov.global.count, 0);
assert.deepEqual(ov.project.topics, []);
assert.deepEqual(ov.projects, [], "选择器在空库下是空列表，不是报错");

const graph = (await (await get("/api/graph?scope=all")).json()) as { nodes: unknown[]; links: unknown[] };
assert.deepEqual(graph, { nodes: [], links: [] });

// 数据目录只应该被「开库」这一步建出来，不该被写进什么乱七八糟的东西
assert.ok(fs.existsSync(path.join(tmp, "global.db")), "读一次就该把全局库建好（空表）");

ui.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("✓ 空库：概览 / 图谱 / 列表 / 近义堆都是 200，数字是 0 不是 500");
console.log("\n全部通过");
