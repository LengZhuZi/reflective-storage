/**
 * 记忆树 + 项目注册表自检。
 *
 * 跑法：node tests/tree.ts
 * 不联网、不调引擎：树是**纯本地结构**（路径来自 tool call 的文件名），注册表是派生数据。
 * 这两层不花一次判断调用 —— 这也是它们能先做的原因。
 *
 * 为什么树用文件路径而不是主题名：给记忆起名是生成文本（§15 原则 1 不让引擎干），
 * 让用户起名又会问到他烦；而 pi 的 tool call 自带文件路径，零生成、零追问、
 * 跟代码结构天然一致。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reflect-tree-"));
process.env.REFLECTIVE_HOME = tmp;

const {
  openDb, insertMemory, linkPath, memoriesUnderPath, allTreePaths, pathsFor,
  refreshRegistry, listRegistry, putEmbedding, distinctTopics, setTopic,
} = await import("../src/storage/db.ts");
const {
  toTreePath, pickTreePaths, attachPaths, mentionsPath, pathCandidates, MAX_PATHS_PER_MEMORY, MAX_PATH_DEPTH,
} = await import("../src/pipeline/tree.ts");
const { recallFlow } = await import("../src/pipeline/recall.ts");
const { embed } = await import("../src/embed/encoder.ts");

const CWD = "/code/P/app";
const project = openDb(path.join(tmp, "proj.db"));
const globalDb = openDb(path.join(tmp, "global.db"));

// ------------------------------------------------------------ 路径规整
assert.equal(toTreePath("/code/P/app/src/backend/auth/login.ts", CWD), "/src/backend/auth/login", "绝对路径要相对化 + 去扩展名");
assert.equal(toTreePath("src/a/b/x.ts", CWD), "/src/a/b/x", "相对路径照走");
assert.equal(toTreePath("/code/other/x.ts", CWD), null, "项目外的文件不进这棵树");
assert.equal(toTreePath("node_modules/pkg/x.ts", CWD), null, "依赖不进树");
assert.equal(toTreePath(".git/config", CWD), null);
assert.equal(toTreePath("a/b/c/d/e/f.ts", CWD), "/a/b/c/d", "深度要截断（太深的节点没有分组价值）");
assert.ok(MAX_PATH_DEPTH >= 3 && MAX_PATH_DEPTH <= 6);
const picked = pickTreePaths(["src/a/b/x.ts", "src/a/b/y.ts", "src/c.ts", "src/d.ts", "src/e.ts"], CWD);
assert.ok(picked.length <= MAX_PATHS_PER_MEMORY, "一次最多挂几个路径");
assert.deepEqual(picked.filter((p) => p === "/src/a/b/x"), ["/src/a/b/x"]);
console.log("✓ 路径规整：相对化、去扩展名、项目外/依赖不进树、深度与数量都有上限");

// ------------------------------------------------------------ 挂载与子树查询
const loginMem = insertMemory(project, { content: "登录校验必须走 OIDC，别自己写 token 解析", type: "fact", scope: "project", scopeId: "P" });
const btnMem = insertMemory(project, { content: "这个按钮的样式用主色描边", type: "fact", scope: "project", scopeId: "P" });
attachPaths(project, loginMem.id, ["src/backend/auth/login.ts"], CWD);
attachPaths(project, btnMem.id, ["src/frontend/components/Button.tsx"], CWD);
assert.deepEqual(pathsFor(project, loginMem.id), ["/src/backend/auth/login"]);
assert.deepEqual(memoriesUnderPath(project, "/src/backend").map((m) => m.id), [loginMem.id], "子树查询（物化路径 + LIKE）");
assert.deepEqual(memoriesUnderPath(project, "/src/backend/auth/login").map((m) => m.id), [loginMem.id], "同一个节点下也算");
assert.equal(memoriesUnderPath(project, "/src/other").length, 0);
assert.ok(allTreePaths(project).includes("/src/frontend/components/Button"));
linkPath(project, loginMem.id, "/src/backend/auth/login");
assert.deepEqual(pathsFor(project, loginMem.id).length, 1, "同一个路径重复挂只留一条");
console.log("✓ 挂载 + 子树查询（物化路径，不需要递归也不需要中间空节点）");

// ------------------------------------------------------------ 提问里提到路径
assert.equal(mentionsPath("帮我改一下 login.ts 的校验", "/src/backend/auth/login"), true);
assert.equal(mentionsPath("src/backend 那边顺手也改下", "/src/backend/auth/login"), true);
assert.equal(mentionsPath("改个按钮", "/src/backend/auth/login"), false, "没提路径就不许硬捞");
assert.equal(mentionsPath("影子太黑怎么调", "/src/backend/auth/login"), false);
const cands = pathCandidates(project, "帮我改一下 login.ts 的校验", allTreePaths(project));
assert.deepEqual(cands.map((m) => m.id), [loginMem.id]);
assert.deepEqual(pathCandidates(project, "帮我把按钮改圆角", allTreePaths(project)), [], "只说「按钮」不算提路径");

// 真召回链路：路径那一路要把记忆捞进候选（中文提问 + 一个文件名）
putEmbedding(project, loginMem.id, await embed(loginMem.content));
const seen: string[] = [];
const stub = {
  relevanceThreshold: 0.5,
  async judgeRelevance(_q: string, c: Array<{ id: string }>) {
    seen.push(...c.map((x) => x.id));
    return { relevance: new Map(c.map((x) => [x.id, 0.9])), blocked: new Set(), meta: { gate: "J7", fallbackUsed: "none", status: "ok", latencyMs: 0 } };
  },
  async judgeInjection(_q: string, c: Array<{ id: string }>) {
    return { decisions: new Map(c.map((x) => [x.id, "inject" as const])), meta: { gate: "J8", fallbackUsed: "none", status: "ok", latencyMs: 0 } };
  },
} as never;
const res = await recallFlow("login.ts 里的校验逻辑要改", {
  projectDb: project, globalDb, session: { sessionId: "s", cwd: CWD, projectId: "P", injectedIds: new Set() },
  adapter: stub, budget: { maxTokens: 800 },
});
assert.ok(seen.includes(loginMem.id), "提到 login.ts 就该把那个子树下的记忆捞进候选");
assert.ok(res.candidates.some((c) => c.memory.id === loginMem.id));
console.log("✓ 路径那一路参与召回（第六路），只认「像路径的东西」");

// ------------------------------------------------------------ 项目注册表（跨项目的入口）
setTopic(project, loginMem.id, "认证");
refreshRegistry(globalDb, project, "P", CWD);
const rows = listRegistry(globalDb);
assert.equal(rows.length, 1);
assert.equal(rows[0].projectId, "P");
assert.equal(rows[0].count, 2, "条数是派生出来的");
assert.deepEqual(rows[0].topics, ["认证"], "主题清单也是派生的");
assert.ok(rows[0].recent.length >= 1 && rows[0].recent.every((x) => x.length > 0), "最近几条标题要带上（给上层判断用的线索）");

// 刷新是幂等的：同一个项目不会长出第二行，内容跟着更新
insertMemory(project, { content: "又记了一条", type: "event", scope: "project", scopeId: "P" });
refreshRegistry(globalDb, project, "P", CWD);
assert.equal(listRegistry(globalDb).length, 1, "一个项目一行");
assert.equal(listRegistry(globalDb)[0].count, 3, "刷新会更新条数");
// 别的项目各占一行 —— 这就是跨项目那一层的候选来源
const other = openDb(path.join(tmp, "other.db"));
insertMemory(other, { content: "另一个项目的东西", type: "fact", scope: "project", scopeId: "Q" });
refreshRegistry(globalDb, other, "Q", "/code/Q/app");
assert.deepEqual(listRegistry(globalDb).map((r) => r.projectId), ["P", "Q"]);
console.log("✓ 项目注册表：一行一个项目、派生字段、刷新幂等（跨项目那一层的候选来源）");

// ------------------------------------------------------------ 孤儿路径先留着，不自动迁移
// 目录改名后老路径会成为孤儿。猜着迁移比留着更坏 —— 所以只保证「留得下、查得到」。
const stale = insertMemory(project, { content: "旧目录结构下的约定", type: "fact", scope: "project", scopeId: "P" });
attachPaths(project, stale.id, ["src/old/legacy/thing.ts"], CWD);
// 只断言现象：路径还在，没人会去猜它搬哪儿 —— 保留是为了排查，不是为了自动修
linkPath(project, stale.id, "/src/old/legacy/thing");
assert.ok(pathsFor(project, stale.id).includes("/src/old/legacy/thing"), "目录改名后老路径保留（孤儿要看得见，不猜着迁移）");
console.log("✓ 目录改名后的孤儿路径保留（不做自动迁移）");

project.close();
other.close();
globalDb.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n全部通过");
