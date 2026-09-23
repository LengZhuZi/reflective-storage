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
import { CONFIG_PATH } from "../config.ts";
import type { MemoryNode } from "../core/types.ts";
import { cosine } from "../embed/encoder.ts";
import {
  addTrace, countMemories, countPendingReviews, distinctTopics, getEmbedding, getMemory, hardDelete,
  listRegistry, pendingReviews, projectDbFile, queryMemories, recentRecalls, resolveReview, setTopic,
  tracesFor, type OpenedDb,
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
  projectDb: OpenedDb;
  globalDb: OpenedDb;
  projectId: string;
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
  const tf = (out.typesafe ?? {}) as Record<string, unknown>;
  const jd = (out.judge ?? {}) as Record<string, unknown>;
  for (const block of [tf, jd]) {
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

/** 图谱：节点 + 边。边来自四类依据：取代/冲突关系、同主题、同路径、高余弦。 */
function buildGraph(projectDb: OpenedDb, globalDb: OpenedDb, scope: "project" | "global"): { nodes: unknown[]; links: unknown[] } {
  const db = scope === "global" ? globalDb : projectDb;
  const nodes = queryMemories(db, {
    states: ["active", "cold"],
    scope: scope === "global" ? "global" : undefined,
    limit: GRAPH_NODE_LIMIT,
  });
  const ids = new Set(nodes.map((m) => m.id));
  const links: Array<{ source: string; target: string; kind: string }> = [];
  const push = (a: string, b: string, kind: string) => {
    if (a !== b && ids.has(a) && ids.has(b)) links.push({ source: a, target: b, kind });
  };

  for (const r of db.db.prepare(`SELECT from_id, to_id, relation FROM memory_relations`).all() as Array<Record<string, unknown>>) {
    push(String(r.from_id), String(r.to_id), String(r.relation));
  }
  const byKey = (key: (m: MemoryNode) => string | null, kind: string, cap = 8) => {
    const groups = new Map<string, string[]>();
    for (const m of nodes) {
      const k = key(m);
      if (!k) continue;
      groups.set(k, [...(groups.get(k) ?? []), m.id]);
    }
    for (const [, group] of groups) {
      if (group.length < 2 || group.length > cap) continue;   // 太散的组连线会变成毛球
      for (let i = 1; i < group.length; i++) push(group[i - 1]!, group[i]!, kind);
    }
  };
  byKey((m) => m.topic, "topic");
  const paths = db.db.prepare(`SELECT memory_id, path FROM memory_tree_links WHERE tree_name='path'`).all() as Array<Record<string, unknown>>;
  const byMemory = new Map<string, string>();
  for (const p of paths) byMemory.set(String(p.memory_id), String(p.path));
  byKey((m) => byMemory.get(m.id) ?? null, "path");

  const vecs = nodes.map((m) => ({ m, v: getEmbedding(db, m.id) })).filter((x) => x.v);
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
      id: m.id, label: m.content.slice(0, 70), type: m.type, topic: m.topic, scope: m.scope,
      state: m.state, importance: m.importance, access: m.accessCount,
      path: byMemory.get(m.id) ?? null, created: m.createdAt,
    })),
    links,
  };
}

export function startUi(deps: UiDeps): Promise<UiHandles> {
  const sessions = new Map<string, { user: string; exp: number }>();
  const dbFor = (scope: string): OpenedDb => (scope === "global" ? deps.globalDb : deps.projectDb);

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
        const scopeParam = url.searchParams.get("scope") === "global" ? "global" : "project";
        const db = dbFor(scopeParam);
        const wantsHtml = (req.headers.accept ?? "").includes("text/html");
        const back = (res2: http.ServerResponse, dest: string, error = "") => {
          res2.writeHead(303, { location: error ? `${dest}?e=${encodeURIComponent(error)}` : dest });
          res2.end();
        };

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
          const rows = db.db.prepare(`SELECT type, scope, state FROM memories`).all() as Array<Record<string, unknown>>;
          const dupes = (await jsonDupes("project")).length;
          const recalls = recentRecalls(db, 8).map((r) => {
            const injected = (JSON.parse(String(r.injected_ids ?? "[]")) as string[]).length;
            const cited = (JSON.parse(String(r.cited_ids ?? "[]")) as string[]).length;
            return { query: String(r.query).slice(0, 80), recalled: (JSON.parse(String(r.recalled_ids ?? "[]")) as string[]).length, injected, cited, effect: r.effect_score == null ? null : Number(r.effect_score), at: Number(r.created_at) };
          });
          const withInject = recalls.filter((r) => r.injected > 0);
          const injectedTotal = withInject.reduce((n, r) => n + r.injected, 0);
          const citedTotal = withInject.reduce((n, r) => n + r.cited, 0);
          return json(res, 200, {
            project: {
              file: deps.projectDb.file, count: countMemories(deps.projectDb),
              byType: tally(rows, "type"), byState: tally(rows, "state"), byScope: tally(rows, "scope"),
              topics: distinctTopics(deps.projectDb, 40),
              paths: Number((deps.projectDb.db.prepare(`SELECT count(DISTINCT path) c FROM memory_tree_links WHERE tree_name='path'`).get() as { c: number }).c),
            },
            global: { file: deps.globalDb.file, count: countMemories(deps.globalDb) },
            pending: countPendingReviews(deps.projectDb),
            dupes, dupeCosine: DUPE_COSINE,
            hitRate: injectedTotal ? citedTotal / injectedTotal : null,
            injectedTotal, citedTotal,
            engine: cfg.judge,
            topics: distinctTopics(deps.projectDb, 20),
            registry: listRegistry(deps.globalDb),
            recalls,
            traces: (deps.projectDb.db
              .prepare(`SELECT stage, gate, action, reason, status, user_visible FROM reflection_traces ORDER BY created_at DESC, rowid DESC LIMIT 10`)
              .all() as Array<Record<string, unknown>>)
              .map((t) => ({ stage: String(t.stage), gate: String(t.gate), action: String(t.action), reason: t.reason ?? "", status: t.status ?? "", userVisible: t.user_visible ?? "" })),
          });
        }

        if (req.method === "GET" && path === "/api/graph") return json(res, 200, buildGraph(deps.projectDb, deps.globalDb, scopeParam));

        if (req.method === "GET" && path === "/api/memory-detail") {
          const id = url.searchParams.get("id") ?? "";
          const m = getMemory(db, id);
          if (!m) return json(res, 404, { error: "没有这条记忆" });
          const rows = db.db.prepare(`SELECT path FROM memory_tree_links WHERE memory_id = ?`).all(id) as Array<Record<string, unknown>>;
          return json(res, 200, {
            memory: m,
            topic: m.topic,
            paths: rows.map((r) => String(r.path)),
            traces: tracesFor(db, id).map((t) => ({
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
          const items = queryMemories(db, {
            states: st ? [st as MemoryNode["state"]] : undefined,
            scope: scopeParam === "global" ? "global" : undefined,
            topic: topic || undefined,
          });
          return json(res, 200, {
            items,
            topics: distinctTopics(db, 40),
            pending: pendingReviews(deps.projectDb, 20).map((r) => ({
              id: String(r.id), kind: String(r.kind), question: String(r.question), options: String(r.options),
              memoryId: String(r.memory_id), otherId: r.other_id == null ? null : String(r.other_id),
            })),
          });
        }

        if (req.method === "GET" && path === "/api/dupes") {
          const items = (await jsonDupes(scopeParam)).slice(0, 50);
          return json(res, 200, { items, threshold: DUPE_COSINE });
        }

        if (req.method === "GET" && path === "/api/traces") {
          const id = url.searchParams.get("id") ?? "";
          return json(res, 200, {
            items: tracesFor(db, id).map((r) => ({
              gate: String(r.gate), action: String(r.action), reason: r.reason ?? null,
              status: r.status ?? null, userVisible: r.user_visible ?? null, judgment: r.judgment ?? null,
            })),
          });
        }

        if (req.method === "DELETE" && path.startsWith("/api/memory/")) {
          const id = decodeURIComponent(path.slice("/api/memory/".length));
          if (!getMemory(db, id)) return json(res, 404, { error: "没有这条记忆" });
          addTrace(db, { memoryId: id, stage: "governance", gate: "J12", action: "delete", reason: "本地 UI 手动删除" });
          hardDelete(db, id);
          return json(res, 200, { ok: true });
        }

        if (req.method === "POST" && path === "/api/merge") {
          const body = JSON.parse((await readBody(req)) || "{}") as { keep?: string; drop?: string };
          if (!body.keep || !body.drop) return json(res, 400, { error: "缺少 keep / drop" });
          return json(res, 200, { ok: true, result: mergeMemories(deps.projectDb, body.keep, body.drop, "本地 UI 手动合并") });
        }

        if (req.method === "POST" && path.startsWith("/api/review/")) {
          const id = decodeURIComponent(path.slice("/api/review/".length));
          const body = JSON.parse((await readBody(req)) || "{}") as { resolution?: string };
          const item = pendingReviews(deps.projectDb, 100).find((r) => String(r.id) === id);
          if (!item) return json(res, 404, { error: "这条待确认已经不在了" });
          const kind = String(item.kind);
          const resolution = body.resolution ?? "";

          if (kind === "topic") {
            if (resolution && resolution !== "先不起主题") {
              const target = getMemory(deps.projectDb, String(item.memory_id)) ?? getMemory(deps.globalDb, String(item.memory_id));
              if (target) setTopic(target.scope === "global" ? deps.globalDb : deps.projectDb, String(item.memory_id), resolution);
            }
            resolveReview(deps.projectDb, id, resolution ? `topic:${resolution}` : "topic:skipped");
            return json(res, 200, { ok: true, resolution });
          }
          if (kind === "scope") {
            resolveReview(deps.projectDb, id, resolution === SCOPE_WIDEN ? "scope:widen" : "scope:keep");
            return json(res, 200, { ok: true, result: resolution === SCOPE_WIDEN ? widenScopeToGlobal(deps.projectDb, deps.globalDb, String(item.memory_id)) : "保持项目级" });
          }
          const label = Object.entries(RESOLUTION_LABELS).find(([, l]) => l === resolution)?.[0] ?? "keep_both";
          return json(res, 200, { ok: true, result: applyResolution(deps.projectDb, item, label as never) });
        }

        return json(res, 404, { error: "not found" });
      } catch (e) {
        return json(res, 500, { error: (e as Error).message });
      }
    })();
  });

  /** 近义堆：余弦 ≥ 阈值的两两组合。 */
  const jsonDupes = async (scope: string): Promise<Array<{ a: string; b: string; sim: number; aText: string; bText: string }>> => {
    const d = dbFor(scope);
    const items = queryMemories(d, { scope: scope === "global" ? "global" : undefined, limit: 300 })
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
