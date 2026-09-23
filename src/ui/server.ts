/**
 * 本地 UI —— 只绑 127.0.0.1 的小面板：概览、记忆图谱、列表、待确认、近义堆、设置。
 *
 * 零依赖、零构建：node:http + 一个内联 HTML。为一个单机排查面板拉构建链不划算。
 *
 * 三条安全线：
 *  1. 只绑 127.0.0.1。
 *  2. URL 带一次性 token，没有就 403 —— 回环地址不是安全边界（别的进程、浏览器里的任意
 *     页面都能 POST 到 localhost）。
 *  3. 页面渲染一律走 Preact 的文本节点（等价于 textContent），不把记忆原文塞进 DOM：
 *     面板源码在 ui/，构建产物 ui/dist 提交进仓库；测试会断言产物里没有 innerHTML /
 *     dangerouslySetInnerHTML（记忆是不可信输入）。
 *
 * 设置页能改 config.json（包括 key）。key 只写不读：GET 只回「有没有、多长」。
 */

import * as http from "node:http";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { CONFIG_PATH } from "../config.ts";
import type { MemoryNode } from "../core/types.ts";
import { cosine } from "../embed/encoder.ts";
import {
  addTrace, countMemories, countPendingReviews, distinctTopics, getEmbedding, getMemory, hardDelete,
  listRegistry, openDb, openGlobalDb, pendingReviews, projectDbFile, queryMemories, recentRecalls,
  resolveReview, setTopic, tracesFor, type OpenedDb,
} from "../storage/db.ts";
import { RESOLUTION_LABELS, applyResolution, mergeMemories, SCOPE_WIDEN, widenScopeToGlobal } from "../pipeline/review.ts";
import { loadConfig } from "../config.ts";

/**
 * 账号密码 + 会话 cookie。页面不再靠 URL 里的 token —— token 会留在浏览器历史和日志里，
 * 而账号密码可以改、可以退出登录。
 *
 * 首次访问没有账号文件 → 强制先设账号密码（不预设固定默认密码：固定默认值等于把
 * 一台机器上的已知凭据交给所有本地进程）。之后走登录页。
 */
const AUTH_FILE = path.join(path.dirname(CONFIG_PATH), "ui-auth.json");
const SESSION_TTL_MS = 12 * 3600 * 1000;

interface AuthRecord { username: string; salt: string; hash: string }

function readAuth(): AuthRecord | null {
  try {
    const r = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")) as AuthRecord;
    return r && r.username && r.salt && r.hash ? r : null;
  } catch {
    return null;
  }
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function writeAuth(username: string, password: string): void {
  const salt = crypto.randomBytes(16).toString("hex");
  fs.writeFileSync(AUTH_FILE, `${JSON.stringify({ username, salt, hash: hashPassword(password, salt) }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(AUTH_FILE, 0o600);
}

function checkAuth(rec: AuthRecord, username: string, password: string): boolean {
  if (username !== rec.username) return false;
  const a = Buffer.from(hashPassword(password, rec.salt), "hex");
  const b = Buffer.from(rec.hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function form(body: string): Record<string, string> {
  try {
    return JSON.parse(body) as Record<string, string>;
  } catch {
    return Object.fromEntries(new URLSearchParams(body)) as Record<string, string>;
  }
}

function authPage(mode: "setup" | "login", error = ""): string {
  const title = mode === "setup" ? "设置账号密码" : "登录";
  // 登录页是服务端渲染的一次性页面，不进构建链：它跟面板共用一套 token（ui/DESIGN.md），
  // 但不依赖 ui/dist，所以记忆库没构建过也能登录。
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light">
<title>${title} · 反思存储</title>
<style>
:root{--bg:#08090a;--surface:#0e1011;--surface-2:#141719;--line:#1d2124;--line-strong:#2a2f34;--fg:#e7eaec;--fg-dim:#98a1a8;--fg-faint:#6a727a;--accent:#3fbf8f;--on-accent:#04221a;--bad:#e0685f;--focus:#3fbf8f}
@media (prefers-color-scheme: light){:root{--bg:#fbfbfa;--surface:#fff;--surface-2:#f4f5f6;--line:#e6e7e9;--line-strong:#d3d5d9;--fg:#15181b;--fg-dim:#5a626b;--fg-faint:#8a9098;--accent:#0f7a5a;--on-accent:#fff;--bad:#b3261e;--focus:#0f7a5a}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
font:400 13px/20px -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
.card{width:340px;border:1px solid var(--line);border-radius:14px;background:var(--surface);padding:22px}
h1{font-size:15px;font-weight:600;margin:0 0 4px;display:flex;align-items:center;gap:8px}
h1 svg{color:var(--accent)}
p{color:var(--fg-dim);font-size:12.5px;margin:0 0 18px}
label{display:block;font-size:12px;color:var(--fg-dim);margin:12px 0 4px}
input{width:100%;background:var(--surface-2);border:1px solid var(--line-strong);border-radius:6px;padding:8px 10px;color:inherit;font:inherit}
input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(63,191,143,.16)}
button{margin-top:18px;width:100%;padding:9px;border:1px solid var(--accent);background:var(--accent);color:var(--on-accent);font-weight:550;border-radius:6px;cursor:pointer;font:inherit}
button:hover{filter:brightness(1.06)}
.err{color:var(--bad);font-size:12.5px;margin-top:10px;min-height:1em}
.foot{margin-top:14px;color:var(--fg-faint);font-size:11.5px}
</style></head><body>
<form class="card" method="post" action="/api/${mode}">
  <h1><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.8 13.5 6 8 9.2 2.5 6 8 2.8Zm5.5 5.4L8 11.4 2.5 8.2m11 2.9L8 14.4 2.5 11.1"/></svg>反思存储</h1>
  <p>${mode === "setup" ? "首次使用：设一个账号密码。" : "本机记忆库面板。"}</p>
  <label>账号</label><input name="username" autocomplete="username" autofocus required>
  <label>密码</label><input name="password" type="password" autocomplete="${mode === "setup" ? "new-password" : "current-password"}" required>
  ${mode === "setup" ? '<label>再输一次</label><input name="password2" type="password" autocomplete="new-password" required>' : ""}
  <button type="submit">${mode === "setup" ? "创建并进入" : "登录"}</button>
  <div class="err">${error}</div>
  <div class="foot">只绑 127.0.0.1。账号文件在本机，权限 600；密码只存 scrypt 散列。</div>
</form></body></html>`;
}

/* ---------------------------------------------------------------- 面板静态资源
 *
 * 面板源码在 ui/（Vite + Preact），构建产物 ui/dist 提交进仓库：
 * 使用者不需要装 node_modules 就能用面板。这里只做三件事：
 *   1. GET / 回 index.html（不缓存，保证改完就生效）
 *   2. GET /assets/* 回构建产物（长缓存，文件名带内容指纹）
 *   3. 什么都没有时给一句能照做的提示，而不是 500
 */
const UI_DIST = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../ui/dist");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function serveUiFile(res: http.ServerResponse, rel: string, cache: boolean): boolean {
  const file = path.resolve(UI_DIST, rel);
  if (!file.startsWith(UI_DIST + path.sep)) return false;      // 不许跳出去
  let body: Buffer;
  try {
    body = fs.readFileSync(file);
  } catch {
    return false;
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
    "content-length": body.length,
    "cache-control": cache ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
  return true;
}

export interface UiHandles {
  url: string;
  close(): void;
}

export interface UiDeps {
  /**
   * 带 `scope=project` 的请求落到哪个项目（测试和单会话内嵌用）。省略 = 默认看全部项目。
   * 注意这里收的是**项目 id**，不是连接 —— 面板自己按 id 开库，因为它不属于任何会话。
   */
  defaultProject?: string;
  /** 0 或省略 = 让系统挑空闲端口。 */
  port?: number;
}

/** 「近义堆」和图谱里「相似」边的余弦下限。只用来分组给你看，不用它自动合并。 */
const DUPE_COSINE = 0.85;
const GRAPH_NODE_LIMIT = 150;

const json = (res: http.ServerResponse, code: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
      if (Buffer.concat(chunks).length > 256 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const tally = (rows: Array<Record<string, unknown>>, key: string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r[key] ?? "?")] = (out[String(r[key] ?? "?")] ?? 0) + 1;
  return out;
};

/** 配置回给页面时把 key 抹掉：只报「有没有、多长」。 */
function maskedConfig(): Record<string, unknown> {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
  } catch {
    /* 文件不存在或坏了：返回空对象，页面显示「未配置」 */
  }
  const out = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  // 每个可能存 key 的块都要盖住：面板只报「有没有、多长」，不回显明文。
  for (const key of ["typesafe", "judge", "refine"]) {
    const block = (out[key] ?? {}) as Record<string, unknown>;
    const k = block.apiKey;
    if (typeof k === "string" && k) {
      block.apiKey = "";
      block.apiKeySet = k.length;
    }
  }
  return { path: CONFIG_PATH, raw: out };
}

function writeConfigPatch(patch: Record<string, unknown>): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  try {
    base = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
  } catch {
    /* 没有就新建 */
  }
  const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
    for (const [k, v] of Object.entries(b)) {
      if (v === undefined || v === null || v === "") continue;      // 空值不覆盖已有配置
      if (v && typeof v === "object" && !Array.isArray(v)) {
        a[k] = merge((a[k] ?? {}) as Record<string, unknown>, v as Record<string, unknown>);
      } else {
        a[k] = v;
      }
    }
    return a;
  };
  const next = merge(base, patch);
  fs.mkdirSync(CONFIG_PATH.replace(/\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(CONFIG_PATH, 0o600);       // 权限不达标这个文件就不会被读（config.ts 的规矩）
  return maskedConfig();
}

/** 图谱：节点 + 边。边来自四类依据：取代/冲突关系、同主题、同路径、高余弦。
 *
 *  多库合并（`scope=all`）时按 id 去重（id 是 UUID，跨库唯一）。主题边和余弦边跨库也连 ——
 *  同主题的两条记忆分别活在两个项目里，本来就是一回事，图谱不连反而是骗人。
 */
function buildGraph(sources: Array<{ db: OpenedDb; project: string | null }>, scope: "project" | "global" | "all"): { nodes: unknown[]; links: unknown[] } {
  const cap = scope === "all" ? GRAPH_NODE_LIMIT * 2 : GRAPH_NODE_LIMIT;
  const nodes: MemoryNode[] = [];
  const owner = new Map<string, OpenedDb>();
  const projectOf = new Map<string, string | null>();
  for (const src of sources) {
    const batch = queryMemories(src.db, {
      states: ["active", "cold"],
      scope: scope === "global" ? "global" : undefined,
      limit: cap,
    });
    for (const m of batch) {
      if (owner.has(m.id) || nodes.length >= cap) continue;
      owner.set(m.id, src.db);
      projectOf.set(m.id, src.project);
      nodes.push(m);
    }
  }
  const ids = new Set(nodes.map((m) => m.id));
  const links: Array<{ source: string; target: string; kind: string }> = [];
  const seenLink = new Set<string>();
  const push = (a: string, b: string, kind: string) => {
    if (a === b || !ids.has(a) || !ids.has(b)) return;
    const key = `${a < b ? `${a}|${b}` : `${b}|${a}`}|${kind}`;
    if (seenLink.has(key)) return;
    seenLink.add(key);
    links.push({ source: a, target: b, kind });
  };

  const pathOf = new Map<string, string>();
  for (const src of sources) {
    for (const r of src.db.db.prepare(`SELECT from_id, to_id, relation FROM memory_relations`).all() as Array<Record<string, unknown>>) {
      push(String(r.from_id), String(r.to_id), String(r.relation));
    }
    const paths = src.db.db.prepare(`SELECT memory_id, path FROM memory_tree_links WHERE tree_name='path'`).all() as Array<Record<string, unknown>>;
    for (const p of paths) pathOf.set(String(p.memory_id), String(p.path));
  }

  const byKey = (key: (m: MemoryNode) => string | null, kind: string, capGroup = 8) => {
    const groups = new Map<string, string[]>();
    for (const m of nodes) {
      const k = key(m);
      if (!k) continue;
      groups.set(k, [...(groups.get(k) ?? []), m.id]);
    }
    for (const [, group] of groups) {
      if (group.length < 2 || group.length > capGroup) continue;   // 太散的组连线会变成毛球
      for (let i = 1; i < group.length; i++) push(group[i - 1]!, group[i]!, kind);
    }
  };
  byKey((m) => m.topic, "topic");
  byKey((m) => pathOf.get(m.id) ?? null, "path");

  const vecs = nodes.map((m) => ({ m, v: getEmbedding(owner.get(m.id)!, m.id) })).filter((x) => x.v);
  let similar = 0;
  for (let i = 0; i < vecs.length && similar < 40; i++) {
    for (let j = i + 1; j < vecs.length && similar < 40; j++) {
      if (cosine(vecs[i]!.v!, vecs[j]!.v!) >= 0.88) {
        push(vecs[i]!.m.id, vecs[j]!.m.id, "similar");
        similar++;
      }
    }
  }
  return {
    nodes: nodes.map((m) => ({
      id: m.id, label: (m.summary ?? m.content).slice(0, 70), type: m.type, topic: m.topic, scope: m.scope,
      state: m.state, importance: m.importance, access: m.accessCount,
      path: pathOf.get(m.id) ?? null, created: m.createdAt,
      // 来源和可信度也画出来：图谱是用户核对「哪些是模型自己说的」的地方（§8.5）。
      origin: m.origin, trust: m.trust,
      // 哪条属于哪个项目：合并视图下这就是唯一的归属线索。
      project: projectOf.get(m.id) ?? null,
    })),
    links,
  };
}

export function startUi(deps: UiDeps): Promise<UiHandles> {
  const sessions = new Map<string, { user: string; exp: number }>();
  const globalDb = openGlobalDb();
  const projectDbs = new Map<string, OpenedDb>();

  /** 按 id 开项目库（缓存）。id 是垃圾就给 null，不抛 —— 一个坏参数不该把服务打挂。 */
  const openProject = (id: string): OpenedDb | null => {
    if (!id || id === "global" || id === "all") return null;
    const hit = projectDbs.get(id);
    if (hit) return hit;
    try {
      const db = openDb(projectDbFile(id));
      projectDbs.set(id, db);
      return db;
    } catch {
      return null;
    }
  };
  /** 项目库目录（ROOT/projects）。「所有项目」以磁盘上的库为准，不只看注册表。 */
  const projectsDir = path.join(path.dirname(CONFIG_PATH), "projects");
  /** 已知项目：注册表里的 + 本次已打开的 + 磁盘上真的存在的库。 */
  const knownProjects = (): string[] => {
    let onDisk: string[] = [];
    try {
      onDisk = fs.readdirSync(projectsDir).filter((f) => f.endsWith(".db")).map((f) => f.slice(0, -3));
    } catch {
      /* 目录还没建 */
    }
    return [...new Set([...listRegistry(globalDb).map((r) => r.projectId), ...projectDbs.keys(), ...onDisk])];
  };
  /** 所有项目库（合并视图用）。项目数量是人级的，不缓存开销问题。 */
  const allDbs = (): Array<{ id: string; db: OpenedDb }> =>
    knownProjects()
      .map((id) => ({ id, db: openProject(id)! }))
      .filter((x) => x.db);
  /** 选择器要的列表：id + 目录 + 条数。 */
  const projectList = (): Array<{ id: string; dir: string; count: number }> => {
    const dirs = new Map(listRegistry(globalDb).map((r) => [r.projectId, r.dir]));
    return allDbs().map((x) => ({ id: x.id, dir: dirs.get(x.id) ?? "", count: countMemories(x.db) }));
  };
  const dbFor = (scope: string): OpenedDb | null => (scope === "global" ? globalDb : openProject(scope));
  /** 一个 id 到底在哪一库里（id 是 UUID，全局唯一）。合并视图下删除/详情靠它找家。 */
  const dbOwning = (id: string): OpenedDb | null =>
    getMemory(globalDb, id) ? globalDb : (allDbs().find((x) => getMemory(x.db, id))?.db ?? null);

  const cookieOf = (req: http.IncomingMessage): string | null => {
    const raw = req.headers.cookie ?? "";
    const m = raw.match(/(?:^|;\s*)rs_ui=([^;]+)/);
    return m ? m[1]! : null;
  };
  const sessionOf = (req: http.IncomingMessage): { user: string } | null => {
    const id = cookieOf(req);
    if (!id) return null;
    const sess = sessions.get(id);
    if (!sess) return null;
    if (sess.exp < Date.now()) { sessions.delete(id); return null; }
    return { user: sess.user };
  };
  const setSession = (res: http.ServerResponse, user: string): void => {
    const id = crypto.randomUUID();
    sessions.set(id, { user, exp: Date.now() + SESSION_TTL_MS });
    res.setHeader("set-cookie", `rs_ui=${id}; HttpOnly; SameSite=Strict; Path=/`);
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const path = url.pathname;
        // scope: `all`（默认，所有项目合并）/ `global` / 项目 id。`project` 是内嵌会话用的别名。
        const rawScope = url.searchParams.get("scope") ?? "project";
        const scope = rawScope === "project" ? (deps.defaultProject ?? "all") : rawScope;
        const isAll = scope === "all";
        const db = dbFor(scope) ?? globalDb;
        const wantsHtml = (req.headers.accept ?? "").includes("text/html");
        const back = (res2: http.ServerResponse, dest: string, error = "") => {
          res2.writeHead(303, { location: error ? `${dest}?e=${encodeURIComponent(error)}` : dest });
          res2.end();
        };

        // 探活：不要求登录（其他会话靠它发现这个面板在跑），但只吐身份，不吐内容。
        if (path === "/api/health") {
          return json(res, 200, { ok: true, service: UI_SERVICE, version: uiVersion(), pid: process.pid, projects: knownProjects().length });
        }

        // 首次设置 / 登录
        if (!readAuth()) {
          if (req.method === "GET" && wantsHtml) {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            return res.end(authPage("setup", url.searchParams.get("e") ?? ""));
          }
          if (req.method === "POST" && path === "/api/setup") {
            const f = form(await readBody(req));
            const username = (f.username ?? "").trim();
            const password = f.password ?? "";
            if (username.length < 2 || password.length < 8) return back(res, "/", "账号至少 2 位、密码至少 8 位");
            if (password !== (f.password2 ?? password)) return back(res, "/", "两次输入的密码不一样");
            writeAuth(username, password);
            setSession(res, username);
            return back(res, "/");
          }
          return json(res, 401, { error: "先设置账号密码" });
        }

        if (path === "/api/login" && req.method === "POST") {
          const f = form(await readBody(req));
          const rec = readAuth()!;
          if (!checkAuth(rec, (f.username ?? "").trim(), f.password ?? "")) return back(res, "/", "账号或密码不对");
          setSession(res, rec.username);
          return back(res, "/");
        }
        if (path === "/api/logout" && req.method === "POST") {
          const id = cookieOf(req);
          if (id) sessions.delete(id);
          res.setHeader("set-cookie", "rs_ui=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
          return back(res, "/");
        }

        const session = sessionOf(req);
        if (!session) {
          if (req.method === "GET" && wantsHtml) {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            return res.end(authPage("login", url.searchParams.get("e") ?? ""));
          }
          return json(res, 401, { error: "未登录" });
        }

        // 改账号密码
        if (path === "/api/account" && req.method === "POST") {
          const f = form(await readBody(req));
          const rec = readAuth()!;
          if (!checkAuth(rec, rec.username, f.current ?? "")) return json(res, 403, { error: "当前密码不对" });
          const username = (f.username ?? "").trim() || rec.username;
          if ((f.password ?? "").length < 8) return json(res, 400, { error: "新密码至少 8 位" });
          writeAuth(username, f.password!);
          setSession(res, username);
          return json(res, 200, { ok: true, username });
        }

        // 改状态的请求要带自定义头：Cookie 会让跨站表单能打过来，而自定义头过不去
        // （跨源发它要 CORS 预检，我们不放开 CORS）。读接口不需要。
        if (req.method !== "GET" && req.headers["x-csrf"] !== "1") {
          return json(res, 403, { error: "missing x-csrf" });
        }

        if (req.method === "GET" && (path === "/" || path === "")) {
          if (serveUiFile(res, "index.html", false)) return;
          res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
          return res.end(
            `<!doctype html><meta charset="utf-8"><body style="font:14px/1.6 system-ui;padding:40px;background:#08090a;color:#e7eaec">` +
              `<h1 style="font-size:15px">面板还没构建</h1>` +
              `<p style="color:#98a1a8">面板源码在 <code>ui/</code>，构建产物要提交进仓库。缺的是：<code>${UI_DIST}/index.html</code></p>` +
              `<pre style="color:#98a1a8">cd ui &amp;&amp; npm install &amp;&amp; npm run build</pre>` +
              `<p style="color:#98a1a8">不想构建的话，命令行一样能用：<code>/memory</code>。</p></body>`,
          );
        }

        // 构建产物（文件名带内容指纹，可以长缓存）
        if (req.method === "GET" && path.startsWith("/assets/")) {
          if (serveUiFile(res, path.slice(1), true)) return;
        }

        if (req.method === "GET" && path === "/api/session") return json(res, 200, { user: session.user });

        if (req.method === "GET" && path === "/api/overview") {
          const cfg = loadConfig();
          // 一个项目库都还没有（新装机 / 刚清空）时 sources 是空的：
          // 聚合回落到全局库，页面照常打开 —— 「刚清空所以 500」是最没道理的 500。
          const sources = isAll ? allDbs().map((x) => x.db) : [db];
          const list = sources.length ? sources : [globalDb];
          const rows = list.flatMap(
            (d) => d.db.prepare(`SELECT type, scope, state, origin, trust, topic FROM memories`).all() as Array<Record<string, unknown>>,
          );
          const primary = list[0]!;
          const dupes = isAll ? 0 : (await jsonDupes(primary, scopeFilter(scope))).length;
          const recalls = recentRecalls(primary, 8).map((r) => {
            const injected = (JSON.parse(String(r.injected_ids ?? "[]")) as string[]).length;
            const cited = (JSON.parse(String(r.cited_ids ?? "[]")) as string[]).length;
            return { query: String(r.query).slice(0, 80), recalled: (JSON.parse(String(r.recalled_ids ?? "[]")) as string[]).length, injected, cited, effect: r.effect_score == null ? null : Number(r.effect_score), at: Number(r.created_at) };
          });
          const withInject = recalls.filter((r) => r.injected > 0);
          const injectedTotal = withInject.reduce((n, r) => n + r.injected, 0);
          const citedTotal = withInject.reduce((n, r) => n + r.cited, 0);
          const topics = [...new Set(list.flatMap((d) => distinctTopics(d, 40)))];
          return json(res, 200, {
            scope,
            isAll,
            project: {
              file: isAll ? `${sources.length} 个项目库` : primary.file,
              count: list.reduce((n, d) => n + countMemories(d), 0),
              byType: tally(rows, "type"), byState: tally(rows, "state"), byScope: tally(rows, "scope"),
              // 来源权重（§8.5）：多少条是用户原话、多少条是模型自己写的、其中多少条还没被确认。
              byOrigin: tally(rows, "origin"),
              unconfirmed: rows.filter((r) => Number(r.trust ?? 1) < 0.8).length,
              // 主题带条数：只给名字看不出分布，而分布才是「这个项目记住了什么」的答案。
              topicCounts: Object.entries(tally(rows, "topic"))
                .filter(([t]) => t && t !== "?" && t !== "null")
                .sort((a, b) => b[1] - a[1])
                .slice(0, 12)
                .map(([topic, n]) => ({ topic, n })),
              topics,
              paths: list.reduce(
                (n, d) => n + Number((d.db.prepare(`SELECT count(DISTINCT path) c FROM memory_tree_links WHERE tree_name='path'`).get() as { c: number }).c),
                0,
              ),
            },
            global: { file: globalDb.file, count: countMemories(globalDb) },
            pending: list.reduce((n, d) => n + countPendingReviews(d), 0),
            dupes, dupeCosine: DUPE_COSINE,
            hitRate: injectedTotal ? citedTotal / injectedTotal : null,
            injectedTotal, citedTotal,
            engine: cfg.judge,
            topics: topics.slice(0, 20),
            registry: listRegistry(globalDb),
            projects: projectList(),
            recalls,
            traces: (primary.db
              .prepare(`SELECT stage, gate, action, reason, status, user_visible FROM reflection_traces ORDER BY created_at DESC, rowid DESC LIMIT 10`)
              .all() as Array<Record<string, unknown>>)
              .map((t) => ({ stage: String(t.stage), gate: String(t.gate), action: String(t.action), reason: t.reason ?? "", status: t.status ?? "", userVisible: t.user_visible ?? "" })),
          });
        }

        if (req.method === "GET" && path === "/api/graph") {
          // 合并视图把全局库也算进来：全局记忆是所有项目共用的，「全部」少它就不叫全部。
          const sources = isAll
            ? [{ db: globalDb, project: null }, ...allDbs().map((x) => ({ db: x.db, project: x.id }))]
            : [{ db, project: scope === "global" ? null : scope }];
          return json(res, 200, buildGraph(sources, isAll ? "all" : scope === "global" ? "global" : "project"));
        }

        if (req.method === "GET" && path === "/api/memory-detail") {
          const id = url.searchParams.get("id") ?? "";
          const home = isAll ? dbOwning(id) : db;
          const m = home ? getMemory(home, id) : null;
          if (!m || !home) return json(res, 404, { error: "没有这条记忆" });
          const rows = home.db.prepare(`SELECT path FROM memory_tree_links WHERE memory_id = ?`).all(id) as Array<Record<string, unknown>>;
          return json(res, 200, {
            memory: m,
            topic: m.topic,
            paths: rows.map((r) => String(r.path)),
            traces: tracesFor(home, id).map((t) => ({
              gate: String(t.gate), action: String(t.action), reason: t.reason ?? "",
              status: t.status ?? "", userVisible: t.user_visible ?? "",
            })),
          });
        }

        if (req.method === "GET" && path === "/api/config") return json(res, 200, maskedConfig());
        if (req.method === "POST" && path === "/api/config") {
          const patch = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
          return json(res, 200, writeConfigPatch(patch));
        }

        if (req.method === "GET" && path === "/api/memories") {
          const st = url.searchParams.get("state");
          const topic = url.searchParams.get("topic");
          const states = st ? [st as MemoryNode["state"]] : undefined;
          const opts = { states, topic: topic || undefined };
          const items = isAll
            ? [
                ...queryMemories(globalDb, { ...opts, scope: "global" }).map((m) => ({ ...m, project: null })),
                ...allDbs().flatMap((x) => queryMemories(x.db, opts).map((m) => ({ ...m, project: x.id }))),
              ]
            : queryMemories(db, { ...opts, scope: scope === "global" ? "global" : undefined });
          const pending = (isAll ? allDbs().map((x) => ({ id: x.id, db: x.db })) : [{ id: scope, db }]).flatMap((x) =>
            pendingReviews(x.db, 20).map((r) => ({
              id: String(r.id), kind: String(r.kind), question: String(r.question), options: String(r.options),
              memoryId: String(r.memory_id), otherId: r.other_id == null ? null : String(r.other_id), project: x.id,
            })),
          );
          return json(res, 200, { items, topics: [...new Set((isAll ? allDbs().map((x) => x.db) : [db]).flatMap((d) => distinctTopics(d, 40)))], pending });
        }

        if (req.method === "GET" && path === "/api/dupes") {
          const sources = isAll
            ? [
                { db: globalDb, filter: "global" as const },
                ...allDbs().map((x) => ({ db: x.db, filter: null })),
              ]
            : [{ db, filter: scopeFilter(scope) }];
          const items = (await Promise.all(sources.map((s) => jsonDupes(s.db, s.filter)))).flat().sort((x, y) => y.sim - x.sim).slice(0, 50);
          return json(res, 200, { items, threshold: DUPE_COSINE });
        }

        if (req.method === "GET" && path === "/api/traces") {
          const id = url.searchParams.get("id") ?? "";
          const home = isAll ? dbOwning(id) : db;
          if (!home) return json(res, 200, { items: [] });
          return json(res, 200, {
            items: tracesFor(home, id).map((r) => ({
              gate: String(r.gate), action: String(r.action), reason: r.reason ?? null,
              status: r.status ?? null, userVisible: r.user_visible ?? null, judgment: r.judgment ?? null,
            })),
          });
        }

        if (req.method === "DELETE" && path.startsWith("/api/memory/")) {
          const id = decodeURIComponent(path.slice("/api/memory/".length));
          const home = isAll ? dbOwning(id) : db;
          if (!home || !getMemory(home, id)) return json(res, 404, { error: "没有这条记忆" });
          addTrace(home, { memoryId: id, stage: "governance", gate: "J12", action: "delete", reason: "本地 UI 手动删除" });
          hardDelete(home, id);
          return json(res, 200, { ok: true });
        }

        if (req.method === "POST" && path === "/api/merge") {
          const body = JSON.parse((await readBody(req)) || "{}") as { keep?: string; drop?: string };
          if (!body.keep || !body.drop) return json(res, 400, { error: "缺少 keep / drop" });
          // 合并要改库：合并视图下按 keep id 找家（id 全局唯一，找得到就说明是同一库里的两条）。
          const home = isAll ? dbOwning(body.keep) : db;
          if (!home) return json(res, 404, { error: "找不到这条记忆" });
          return json(res, 200, { ok: true, result: mergeMemories(home, body.keep, body.drop, "本地 UI 手动合并") });
        }

        if (req.method === "POST" && path.startsWith("/api/review/")) {
          const id = decodeURIComponent(path.slice("/api/review/".length));
          const body = JSON.parse((await readBody(req)) || "{}") as { resolution?: string };
          const home = isAll ? allDbs().find((x) => pendingReviews(x.db, 100).some((r) => String(r.id) === id)) : { id: scope, db };
          if (!home) return json(res, 404, { error: "这条待确认已经不在了" });
          const item = pendingReviews(home.db, 100).find((r) => String(r.id) === id);
          if (!item) return json(res, 404, { error: "这条待确认已经不在了" });
          const kind = String(item.kind);
          const resolution = body.resolution ?? "";

          if (kind === "topic") {
            if (resolution && resolution !== "先不起主题") {
              const target = getMemory(home.db, String(item.memory_id)) ?? getMemory(globalDb, String(item.memory_id));
              if (target) setTopic(target.scope === "global" ? globalDb : home.db, String(item.memory_id), resolution);
            }
            resolveReview(home.db, id, resolution ? `topic:${resolution}` : "topic:skipped");
            return json(res, 200, { ok: true, resolution });
          }
          if (kind === "scope") {
            resolveReview(home.db, id, resolution === SCOPE_WIDEN ? "scope:widen" : "scope:keep");
            return json(res, 200, { ok: true, result: resolution === SCOPE_WIDEN ? widenScopeToGlobal(home.db, globalDb, String(item.memory_id)) : "保持项目级" });
          }
          const label = Object.entries(RESOLUTION_LABELS).find(([, l]) => l === resolution)?.[0] ?? "keep_both";
          return json(res, 200, { ok: true, result: applyResolution(home.db, item, label as never) });
        }

        return json(res, 404, { error: "not found" });
      } catch (e) {
        return json(res, 500, { error: (e as Error).message });
      }
    })();
  });

  /** 近义堆：余弦 ≥ 阈值的两两组合。同库里才算 —— 跨库两条相似不一定是重复（见 DESIGN §J11）。 */
  const jsonDupes = async (d: OpenedDb, scopeFilter: "global" | null): Promise<Array<{ a: string; b: string; sim: number; aText: string; bText: string }>> => {
    const items = queryMemories(d, { scope: scopeFilter ?? undefined, limit: 300 })
      .filter((m) => m.state === "active" || m.state === "cold");
    const vecs = items.map((m) => ({ m, v: getEmbedding(d, m.id) })).filter((x) => x.v);
    const pairs: Array<{ a: string; b: string; sim: number; aText: string; bText: string }> = [];
    for (let i = 0; i < vecs.length; i++) {
      for (let j = i + 1; j < vecs.length; j++) {
        const sim = cosine(vecs[i]!.v!, vecs[j]!.v!);
        if (sim >= DUPE_COSINE) pairs.push({ a: vecs[i]!.m.id, b: vecs[j]!.m.id, sim, aText: vecs[i]!.m.content, bText: vecs[j]!.m.content });
      }
    }
    return pairs.sort((x, y) => y.sim - x.sim);
  };

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => server.close() });
    });
  });
}

export { projectDbFile };

/* ---------------------------------------------------------------- 常驻面板
 *
 * 面板不再属于某个会话：会话退了它还在，所以别的会话进来看到的是同一个页面、同一份数据。
 * 「已经在跑」靠 `ui.json` + `/api/health` 认 service 字段，不靠端口能不能连 ——
 * 端口上坐着别的进程时，猜错的代价是给用户一个别人的页面。
 */
export const UI_SERVICE = "reflective-storage-ui";
export const UI_MARKER = path.join(path.dirname(CONFIG_PATH), "ui.json");

function uiVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0";
  } catch {
    return "0";
  }
}

/** 记下实际端口和 pid：端口 0（系统挑）时这是唯一的发现方式。 */
export function writeUiMarker(port: number): void {
  fs.mkdirSync(path.dirname(UI_MARKER), { recursive: true });
  fs.writeFileSync(UI_MARKER, `${JSON.stringify({ port, pid: process.pid, version: uiVersion() }, null, 2)}\n`, { mode: 0o600 });
}

export function readUiMarker(): { port: number; pid: number; version: string } | null {
  try {
    const m = JSON.parse(fs.readFileSync(UI_MARKER, "utf8")) as { port?: number; pid?: number; version?: string };
    return typeof m.port === "number" && m.port > 0 ? { port: m.port, pid: Number(m.pid ?? 0), version: String(m.version ?? "") } : null;
  } catch {
    return null;
  }
}

/**
 * 探活。只认自己的面板（service 对得上），别人的服务占着端口不算。
 *
 * 用 node:http 而不是 fetch：配了代理的环境里（`http_proxy` + `NODE_USE_ENV_PROXY`）
 * fetch 会把 127.0.0.1 的请求也发给代理，探活于是永远失败。http.get 直连，不受代理影响。
 */
export function probeUi(port: number, timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(false);
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => {
        try {
          resolve((JSON.parse(body) as { service?: string }).service === UI_SERVICE);
        } catch {
          resolve(false);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

export interface UiStatus {
  url: string;
  /** true = 这次刚拉起来（第一次 `/memory ui`），false = 复用已经在跑的那个。 */
  started: boolean;
  pid: number;
}

/** 有就跑着，没有就 detached 起一个。起了就不归这个会话管了（会话退了它还在）。 */
export async function ensureUi(opts: { port?: number } = {}): Promise<UiStatus> {
  const alive = readUiMarker();
  if (alive && (await probeUi(alive.port))) {
    return { url: `http://127.0.0.1:${alive.port}/`, started: false, pid: alive.pid };
  }
  if (alive) fs.rmSync(UI_MARKER, { force: true });      // 标记还在、进程没了

  const script = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../scripts/ui-server.ts");
  // 子进程的输出落到 ui.log：detached 进程起不来时，没有日志就只能猜（用户也能看）。
  let out: number | "ignore" = "ignore";
  try {
    const logFile = path.join(path.dirname(CONFIG_PATH), "ui.log");
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    out = fs.openSync(logFile, "a");
  } catch {
    /* 打不开就还是扔掉 */
  }
  const child = spawn(process.execPath, [script, String(opts.port ?? 0)], { detached: true, stdio: ["ignore", out, out] });
  child.unref();
  if (typeof out === "number") fs.closeSync(out);
  // 起来要几十毫秒。轮询等它写标记，比固定 sleep 靠谱（慢了会误判成失败）。
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const m = readUiMarker();
    if (m && m.pid === child.pid && (await probeUi(m.port, 500))) {
      return { url: `http://127.0.0.1:${m.port}/`, started: true, pid: m.pid };
    }
  }
  throw new Error("面板进程没起来（手动跑一次：node scripts/ui-server.ts，看它报什么）");
}

/** 停掉常驻面板。端口被别的东西占了也该能用这个收拾干净。 */
export async function stopUi(): Promise<boolean> {
  const m = readUiMarker();
  if (!m?.pid) return false;
  try {
    process.kill(m.pid, "SIGTERM");
  } catch {
    /* 已经不在了 */
  }
  fs.rmSync(UI_MARKER, { force: true });
  return true;
}

/** 近义堆和全局过滤的 scope 口径：除了 global 库，其他都是「本库全部」。 */
function scopeFilter(scope: string): "global" | null {
  return scope === "global" ? "global" : null;
}
