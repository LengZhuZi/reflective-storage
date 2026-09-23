/**
 * 本地 UI —— 只绑 127.0.0.1 的小面板：概览、记忆图谱、列表、待确认、近义堆、设置。
 *
 * 零依赖、零构建：node:http + 一个内联 HTML。为一个单机排查面板拉构建链不划算。
 *
 * 三条安全线：
 *  1. 只绑 127.0.0.1。
 *  2. URL 带一次性 token，没有就 403 —— 回环地址不是安全边界（别的进程、浏览器里的任意
 *     页面都能 POST 到 localhost）。
 *  3. 页面渲染一律用 textContent 拼 DOM，不把记忆原文塞进 innerHTML（记忆是不可信输入）。
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
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f0d;color:#d6e5dc;
font:14px/1.6 ui-sans-serif,system-ui,"PingFang SC",sans-serif}
form{width:320px;border:1px solid #22312b;border-radius:12px;padding:22px}
h1{font-size:15px;margin:0 0 4px}p{color:#7d9188;font-size:12.5px;margin:0 0 16px}
label{display:block;font-size:12.5px;color:#7d9188;margin:12px 0 4px}
input{width:100%;box-sizing:border-box;background:transparent;border:1px solid #22312b;border-radius:8px;padding:8px 10px;color:inherit;font:inherit}
button{margin-top:16px;width:100%;padding:9px;border:1px solid #39ff88;background:none;color:#39ff88;border-radius:8px;cursor:pointer;font:inherit}
.err{color:#ff5577;font-size:12.5px;margin-top:10px;min-height:1em}</style></head><body>
<form method="post" action="/api/${mode}">
  <h1>反思存储</h1>
  <p>${mode === "setup" ? "首次使用：设一个账号密码。只绑 127.0.0.1，凭据存在本机（600）。" : "本机记忆库面板"}</p>
  <label>账号</label><input name="username" autocomplete="username" autofocus>
  <label>密码</label><input name="password" type="password" autocomplete="${mode === "setup" ? "new-password" : "current-password"}">
  ${mode === "setup" ? '<label>再输一次</label><input name="password2" type="password" autocomplete="new-password">' : ""}
  <button type="submit">${mode === "setup" ? "创建并进入" : "登录"}</button>
  <div class="err">${error}</div>
</form></body></html>`;
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

const page = (username: string): string => `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>反思存储</title>
<style>
:root{color-scheme:light dark;--bg:#0b0f0d;--fg:#d6e5dc;--dim:#7d9188;--line:#22312b;--snake:#39ff88;--warn:#ffb020;--bad:#ff5577;--card:#111815}
@media (prefers-color-scheme: light){:root{--bg:#f6f8f7;--fg:#16211c;--dim:#5b6b64;--line:#dbe4e0;--snake:#0a8f4d;--card:#fff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 ui-sans-serif,system-ui,"PingFang SC",sans-serif}
header{position:sticky;top:0;z-index:5;background:color-mix(in oklab,var(--bg) 88%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:12px 20px;display:flex;gap:14px;align-items:baseline;flex-wrap:wrap}
h1{font-size:15px;margin:0;font-weight:650}
nav{display:flex;gap:6px;padding:12px 20px 0}
nav button{border:1px solid transparent;background:none;color:var(--dim);padding:6px 12px;border-radius:8px;cursor:pointer;font:inherit}
nav button.on{color:var(--fg);border-color:var(--line);background:var(--card)}
main{padding:14px 20px 40px;max-width:1280px}
section{display:none}
section.on{display:block}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 14px}
input,select,button,textarea{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:8px;padding:6px 10px}
input[type=search]{min-width:240px}
button{cursor:pointer}
button:hover{border-color:var(--fg)}
button.primary{border-color:var(--snake);color:var(--snake)}
button.danger{color:var(--bad)}
.dim{color:var(--dim);font-size:12.5px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:16px}
.card{border:1px solid var(--line);border-radius:12px;padding:12px 14px;background:var(--card)}
.card h3{margin:0 0 4px;font-size:12.5px;color:var(--dim);font-weight:500}
.card .n{font-size:22px;font-variant-numeric:tabular-nums}
.item{border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:10px;background:var(--card)}
.item h4{margin:0 0 6px;font-size:13px;font-weight:600}
.content{white-space:pre-wrap;word-break:break-word;margin:6px 0}
.meta{display:flex;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--dim)}
.pending{border-left:3px solid var(--warn)}
.traces{margin-top:8px;border-top:1px dashed var(--line);padding-top:8px;font-size:12.5px}
.traces div{white-space:pre-wrap;color:var(--dim)}
canvas{width:100%;height:560px;border:1px solid var(--line);border-radius:12px;background:var(--card);display:block}
#side{position:fixed;right:16px;top:90px;width:360px;max-height:74vh;overflow:auto;border:1px solid var(--line);border-radius:12px;background:var(--card);padding:14px;display:none;box-shadow:0 8px 28px rgba(0,0,0,.28)}
label{display:block;font-size:12.5px;color:var(--dim);margin:12px 0 4px}
label input,label select{width:100%}
fieldset{border:1px solid var(--line);border-radius:12px;padding:6px 14px 14px;margin:0 0 14px}
legend{font-size:12.5px;color:var(--dim);padding:0 6px}
code{font-size:12px;color:var(--dim)}
</style></head>
<body>
<header><h1>反思存储</h1><span class="dim" id="summary"></span><span style="flex:1"></span><span class="dim" id="who"></span><form method="post" action="/api/logout" style="display:inline"><button type="submit" class="dim">退出</button></form></header>
<nav>
  <button data-tab="overview" class="on">概览</button>
  <button data-tab="graph">图谱</button>
  <button data-tab="list">记忆</button>
  <button data-tab="pending">待确认</button>
  <button data-tab="dupes">近义堆</button>
  <button data-tab="settings">设置</button>
</nav>
<main>
  <section id="overview" class="on"><div class="cards" id="cards"></div><div id="recent"></div></section>

  <section id="graph">
    <div class="row">
      <select id="gscope"><option value="project">项目库</option><option value="global">全局库</option></select>
      <button data-kind="supersedes">取代/冲突</button>
      <button data-kind="topic">同主题</button>
      <button data-kind="path">同路径</button>
      <button data-kind="similar">相似</button>
      <span class="dim">拖节点 · 滚轮缩放 · 拖空白平移</span>
    </div>
    <canvas id="graph-canvas"></canvas>
  </section>

  <section id="list">
    <div class="row">
      <select id="scope"><option value="project">项目库</option><option value="global">全局库</option></select>
      <select id="state"><option value="">全部状态</option><option value="active">active</option><option value="cold">cold</option><option value="archived">archived</option><option value="superseded">superseded</option></select>
      <select id="topic"><option value="">全部主题</option></select>
      <input type="search" id="q" placeholder="按内容过滤">
      <button id="refresh" class="primary">刷新</button>
    </div>
    <div id="list-body"></div>
  </section>

  <section id="pending"><div id="pending-body"></div></section>
  <section id="dupes"><div id="dupes-body"></div></section>

  <section id="settings">
    <div class="row"><button id="save" class="primary">保存</button><span class="dim" id="save-hint">改动下次会话生效（判断引擎和端口要重启 pi）</span></div>
    <form id="cfg" autocomplete="off"></form>
  </section>
</main>
<div id="side"></div>
<script>
const USER = ${JSON.stringify(username)};
const MUT = { headers: { 'x-csrf': '1' } };
const api = (p, opt) => {
  const o = opt && (opt.method === 'POST' || opt.method === 'DELETE') ? { ...opt, ...MUT } : (opt || {});
  return fetch(p, o).then(r => r.ok ? r.json() : r.text().then(t => { throw new Error(t); }));
};
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const pct = (n) => (n * 100).toFixed(0) + '%';
const time = (ms) => new Date(Number(ms)).toLocaleString();
let cache = [], graph = { nodes: [], links: [] }, hidden = new Set();

document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  document.querySelectorAll('nav button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('main section').forEach(s => s.classList.toggle('on', s.id === b.dataset.tab));
  if (b.dataset.tab === 'graph') drawGraph();
});

// ---------------------------------------------------------------- 概览
async function loadOverview() {
  const o = await api('/api/overview');
  document.getElementById('summary').textContent =
    o.project.count + ' 条（项目） · ' + o.global.count + ' 条（全局） · 待确认 ' + o.pending +
    ' · 近义堆 ' + o.dupes + ' · 引擎 ' + o.engine.provider + (o.engine.ready ? '' : '（不可用）');
  const cards = document.getElementById('cards');
  cards.replaceChildren();
  const card = (t, n, sub) => { const c = el('div','card'); c.appendChild(el('h3',null,t)); c.appendChild(el('div','n',String(n))); if (sub) c.appendChild(el('div','dim',sub)); return c; };
  cards.appendChild(card('记忆总数', o.project.count + o.global.count, '项目 ' + o.project.count + ' / 全局 ' + o.global.count));
  cards.appendChild(card('主题', o.project.topics.length, o.project.topics.slice(0,3).join(' / ') || '还没有'));
  cards.appendChild(card('路径节点', o.project.paths, '代码树'));
  cards.appendChild(card('待确认', o.pending, '合并 / 冲突 / 起主题'));
  cards.appendChild(card('近义堆', o.dupes, '余弦 ≥ ' + o.dupeCosine));
  cards.appendChild(card('召回命中率', o.hitRate == null ? '—' : pct(o.hitRate), o.citedTotal + ' / ' + o.injectedTotal + ' 条确凿用上'));
  cards.appendChild(card('状态分布', Object.keys(o.project.byState).length, Object.entries(o.project.byState).map(([k,v]) => k + ' ' + v).join(' · ')));
  cards.appendChild(card('类型分布', Object.keys(o.project.byType).length, Object.entries(o.project.byType).map(([k,v]) => k + ' ' + v).join(' · ')));
  const box = document.getElementById('recent');
  box.replaceChildren();
  box.appendChild(el('h4', null, '最近召回'));
  for (const r of o.recalls) {
    const d = el('div','item');
    d.appendChild(el('div','content', r.query));
    d.appendChild(el('div','meta', '候选 ' + r.recalled + ' · 注入 ' + r.injected + ' · 确凿用上 ' + r.cited + (r.effect == null ? '' : ' · ' + pct(r.effect)) + ' · ' + time(r.at)));
    box.appendChild(d);
  }
  box.appendChild(el('h4', null, '最近判断'));
  for (const t of o.traces) {
    const d = el('div','item');
    d.appendChild(el('div','meta', t.stage + ' · ' + t.gate + ' · ' + t.action + (t.status ? ' · ' + t.status : '')));
    d.appendChild(el('div','content', t.userVisible || t.reason || ''));
    box.appendChild(d);
  }
  box.appendChild(el('h4', null, '项目注册表'));
  for (const p of o.registry) {
    const d = el('div','item');
    d.appendChild(el('div','content', p.projectId + ' · ' + p.count + ' 条' + (p.dir ? ' · ' + p.dir : '')));
    if (p.topics.length) d.appendChild(el('div','dim', '主题：' + p.topics.join(' / ')));
    box.appendChild(d);
  }
}

// ---------------------------------------------------------------- 谱图
function drawGraph() {
  const c = document.getElementById('graph-canvas');
  const ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth, H = c.clientHeight;
  if (c.width !== W * dpr) { c.width = W * dpr; c.height = H * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const links = graph.links.filter(l => !hidden.has(l.kind));
  const deg = new Map();
  for (const l of links) { deg.set(l.source, (deg.get(l.source)||0)+1); deg.set(l.target, (deg.get(l.target)||0)+1); }
  const nodes = graph.nodes;
  let view = graph.view || (graph.view = { x: 0, y: 0, k: 1 });
  let alpha = graph.alpha == null ? 1 : Math.min(1, graph.alpha + 0.3);
  const cx = W/2, cy = H/2, R = Math.min(W,H) * 0.36;
  if (!graph.placed) {
    nodes.forEach((n, i) => { const a = (i / Math.max(1,nodes.length)) * Math.PI * 2; n.x = cx + Math.cos(a)*R*(0.6+((i*37)%40)/100); n.y = cy + Math.sin(a)*R*(0.6+((i*53)%40)/100); });
    graph.placed = true;
  }
  const step = () => {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i+1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = b.x-a.x, dy = b.y-a.y, d2 = dx*dx+dy*dy || 0.01;
        if (d2 > 90000) continue;
        const f = 1400 / d2;
        const d = Math.sqrt(d2);
        dx /= d; dy /= d;
        a.x -= dx*f*alpha; a.y -= dy*f*alpha; b.x += dx*f*alpha; b.y += dy*f*alpha;
      }
      a.x += (cx-a.x)*0.02*alpha; a.y += (cy-a.y)*0.02*alpha;
    }
    const byId = new Map(nodes.map(n => [n.id, n]));
    for (const l of links) {
      const a = byId.get(l.source), b = byId.get(l.target);
      if (!a || !b) continue;
      const dx = b.x-a.x, dy = b.y-a.y, d = Math.sqrt(dx*dx+dy*dy) || 0.01;
      const f = (d - 90) * 0.02 * alpha;
      a.x += dx/d*f; a.y += dy/d*f; b.x -= dx/d*f; b.y -= dy/d*f;
    }
  };
  for (let i = 0; i < 3; i++) step();
  graph.alpha = alpha * 0.72;

  ctx.clearRect(0,0,W,H);
  ctx.save();
  ctx.translate(view.x, view.y); ctx.scale(view.k, view.k);
  const colors = { supersedes:'#ff5577', contradicts:'#ff5577', extends:'#5bc0eb', depends_on:'#5bc0eb', topic:'#39ff88', path:'#c084fc', similar:'#ffb020' };
  for (const l of links) {
    const a = nodes.find(n => n.id === l.source), b = nodes.find(n => n.id === l.target);
    if (!a || !b) continue;
    ctx.strokeStyle = colors[l.kind] || '#556';
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const n of nodes) {
    const r = 4 + Math.min(10, (deg.get(n.id)||0) * 1.6) + (n.importance||0) * 3;
    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI*2);
    ctx.fillStyle = n.state === 'cold' ? '#4b5b54' : n.scope === 'global' ? '#5bc0eb' : '#39ff88';
    ctx.fill();
    if (view.k > 0.75) {
      ctx.fillStyle = '#8fa39a';
      ctx.font = '10px ui-sans-serif';
      ctx.fillText(n.label.slice(0, 18), n.x + r + 3, n.y + 3);
    }
  }
  ctx.restore();
  if (graph.alpha > 0.02) requestAnimationFrame(drawGraph);
}

async function loadGraph() {
  const scope = document.getElementById('gscope').value;
  const g = await api('/api/graph?scope=' + scope);
  graph = { nodes: g.nodes, links: g.links };
  const c = document.getElementById('graph-canvas');
  c.onwheel = (e) => { e.preventDefault(); const v = graph.view; v.k = Math.max(0.3, Math.min(3, v.k * (e.deltaY < 0 ? 1.1 : 0.9))); drawGraph(); };
  let drag = null;
  c.onmousedown = (e) => {
    const v = graph.view, rect = c.getBoundingClientRect();
    const mx = (e.clientX - rect.left - v.x) / v.k, my = (e.clientY - rect.top - v.y) / v.k;
    const hit = graph.nodes.find(n => Math.hypot(n.x-mx, n.y-my) < 14);
    drag = hit ? { node: hit } : { pan: true, sx: e.clientX - v.x, sy: e.clientY - v.y };
    if (hit) showDetail(hit.id);
  };
  c.onmousemove = (e) => {
    if (!drag) return;
    const v = graph.view, rect = c.getBoundingClientRect();
    if (drag.pan) { v.x = e.clientX - drag.sx; v.y = e.clientY - drag.sy; }
    else { drag.node.x = (e.clientX - rect.left - v.x) / v.k; drag.node.y = (e.clientY - rect.top - v.y) / v.k; }
    drawGraph();
  };
  c.onmouseup = () => { drag = null; };
  document.querySelectorAll('#graph .row button[data-kind]').forEach(b => {
    b.style.opacity = hidden.has(b.dataset.kind) ? 0.45 : 1;
    b.onclick = () => { hidden.has(b.dataset.kind) ? hidden.delete(b.dataset.kind) : hidden.add(b.dataset.kind); loadGraph(); };
  });
  drawGraph();
}

async function showDetail(id) {
  const scope = document.getElementById('gscope').value;
  const d = await api('/api/memory/' + id + '/detail?scope=' + scope);
  const side = document.getElementById('side');
  side.replaceChildren();
  side.style.display = 'block';
  const close = el('button', null, '关闭');
  close.onclick = () => { side.style.display = 'none'; };
  side.appendChild(close);
  const m = d.memory;
  side.appendChild(el('div','content', m.content));
  side.appendChild(el('div','meta', m.type + ' · ' + m.scope + ' · ' + m.state + ' · 重要度 ' + Number(m.importance).toFixed(2) + ' · 访问 ' + m.accessCount + ' 次'));
  if (d.paths.length) side.appendChild(el('div','dim', '路径：' + d.paths.join(' / ')));
  if (d.topic) side.appendChild(el('div','dim', '主题：' + d.topic));
  side.appendChild(el('div','dim', '建于 ' + time(m.createdAt)));
  side.appendChild(el('h4', null, '为什么记住'));
  for (const t of d.traces) side.appendChild(el('div','traces', (t.userVisible || '') + ' [' + t.gate + ' ' + t.action + ' ' + (t.status||'?') + '] ' + (t.reason||'')));
  const del = el('button','danger','删除');
  del.onclick = async () => { if (!confirm('硬删除？不可撤销。')) return; await api('/api/memory/' + id + '?scope=' + scope, { method:'DELETE' }); side.style.display='none'; refresh(); loadGraph(); };
  side.appendChild(del);
}

// ---------------------------------------------------------------- 列表
async function loadList() {
  const scope = document.getElementById('scope').value;
  const st = document.getElementById('state').value, topic = document.getElementById('topic').value;
  const r = await api('/api/memories?scope=' + scope + '&state=' + encodeURIComponent(st) + '&topic=' + encodeURIComponent(topic));
  cache = r.items;
  const q = document.getElementById('q').value.trim();
  renderList(q ? cache.filter(m => m.content.includes(q) || (m.topic||'').includes(q)) : cache, scope);
  const sel = document.getElementById('topic'); const cur = sel.value;
  sel.length = 1;
  for (const t of r.topics) { const o = document.createElement('option'); o.value = o.textContent = t; sel.appendChild(o); }
  sel.value = cur;
}

function renderList(items, scope) {
  const box = document.getElementById('list-body');
  box.replaceChildren();
  if (!items.length) { box.appendChild(el('div','dim','没有符合条件的记忆')); return; }
  for (const m of items) {
    const d = el('div','item');
    d.appendChild(el('h4', null, m.type + ' · ' + m.scope + (m.topic ? ' · ' + m.topic : '')));
    d.appendChild(el('div','content', m.content));
    d.appendChild(el('div','meta', '状态 ' + m.state + ' · 重要度 ' + Number(m.importance).toFixed(2) + ' · 衰减 ' + Number(m.decayScore).toFixed(2) + ' · 访问 ' + m.accessCount + ' · ' + time(m.createdAt)));
    const why = el('button', null, '为什么记住'); const del = el('button','danger','删除');
    const tr = el('div','traces');
    why.onclick = async () => {
      if (tr.childElementCount) { tr.replaceChildren(); return; }
      const r = await api('/api/traces?scope=' + scope + '&id=' + m.id);
      if (!r.items.length) tr.appendChild(el('div',null,'没有判断轨迹'));
      for (const t of r.items) tr.appendChild(el('div', null, (t.userVisible||'') + ' [' + t.gate + ' ' + t.action + ' ' + (t.status||'?') + '] ' + (t.reason||'')));
    };
    del.onclick = async () => { if (!confirm('硬删除这条？\\n\\n' + m.content.slice(0,80))) return; await api('/api/memory/' + m.id + '?scope=' + scope, { method:'DELETE' }); refresh(); };
    d.append(why, del, tr);
    box.appendChild(d);
  }
}

// ---------------------------------------------------------------- 待确认 / 近义堆
async function loadPending() {
  const r = await api('/api/memories?scope=project');
  const box = document.getElementById('pending-body');
  box.replaceChildren();
  if (!r.pending.length) { box.appendChild(el('div','dim','没有待确认的事项')); return; }
  for (const it of r.pending) {
    const d = el('div','item pending');
    d.appendChild(el('div','dim', it.kind));
    d.appendChild(el('div','content', it.question));
    const row = el('div','row');
    for (const o of JSON.parse(it.options)) {
      const b = el('button', null, o);
      b.onclick = async () => { b.disabled = true; await api('/api/review/' + it.id, { method:'POST', body: JSON.stringify({ resolution: o }) }); refresh(); };
      row.appendChild(b);
    }
    d.appendChild(row);
    box.appendChild(d);
  }
}

async function loadDupes() {
  const box = document.getElementById('dupes-body');
  box.replaceChildren();
  const r = await api('/api/dupes?scope=project');
  if (!r.items.length) { box.appendChild(el('div','dim','没有余弦 ≥ ' + r.threshold + ' 的对子')); return; }
  for (const p of r.items) {
    const d = el('div','item');
    d.appendChild(el('div','dim','余弦 ' + p.sim.toFixed(3) + '（像，不代表是同一件事）'));
    d.appendChild(el('div','content','A  ' + p.aText));
    d.appendChild(el('div','content','B  ' + p.bText));
    const b = el('button','primary','合并（保留 A）');
    b.onclick = async () => { if (!confirm('合并？B 会标为已取代，原文存进 A 的 metadata。')) return; await api('/api/merge', { method:'POST', body: JSON.stringify({ keep: p.a, drop: p.b }) }); refresh(); };
    d.appendChild(b);
    box.appendChild(d);
  }
}

// ---------------------------------------------------------------- 设置
const SPEC = [
  ['typesafe', [['apiKey','JEV key（只写不读）','password'],['baseUrl','JEV 端点','text'],['model','JEV 模型','text']]],
  ['judge', [['timeoutMs','交互超时 ms','number'],['writeTimeoutMs','写入超时 ms','number'],['relevanceThreshold','相关性阈值','number']]],
  ['inject', [['maxPerSession','每会话最多注入几次','number'],['minTurnsBetween','两次注入至少隔几轮','number']]],
  ['recall', [['perSourceLimit','每一路取多少条','number'],['weights.relevance','权重：JEV 相关性','number'],['weights.vector','权重：向量','number'],['weights.topic','权重：主题/路径','number'],['weights.importance','权重：重要度','number'],['weights.recency','权重：时近性','number']]],
  ['lifecycle', [['autoCleanup','自动清理 session 记忆（勾选=开）','checkbox'],['sessionTtlDays','多少天没命中就销毁','number']]],
  ['proactive', [['enabled','主动提醒（勾选=开）','checkbox'],['maxPerSession','每会话最多提醒几次','number']]],
  ['ui', [['port','页面端口（0=自动，改后重启 pi）','number']]],
  ['proxy', [['http','代理地址','text']]],
];
const get = (o, path) => path.split('.').reduce((a,k) => (a && typeof a === 'object') ? a[k] : undefined, o);
const set = (o, path, v) => { const ks = path.split('.'); let t = o; for (const k of ks.slice(0,-1)) { t[k] = (t[k] && typeof t[k] === 'object') ? t[k] : {}; t = t[k]; } t[ks[ks.length-1]] = v; };

async function loadSettings() {
  const c = await api('/api/config');
  const form = document.getElementById('cfg');
  form.replaceChildren();
  for (const [block, fields] of SPEC) {
    const fs_ = el('fieldset'); fs_.appendChild(el('legend', null, block));
    for (const [key, label, type] of fields) {
      const cur = get(c.raw, block + '.' + key);
      const wrap = el('label', null, label + (key === 'apiKey' && get(c.raw,'typesafe.apiKeySet') ? '（已设置，' + get(c.raw,'typesafe.apiKeySet') + ' 位）' : ''));
      const inp = document.createElement('input');
      inp.type = type; inp.dataset.path = block + '.' + key;
      if (type === 'checkbox') inp.checked = cur === true;
      else inp.value = cur == null ? '' : String(cur);
      inp.placeholder = type === 'password' ? '留空 = 不改' : '';
      wrap.appendChild(inp); fs_.appendChild(wrap);
    }
    form.appendChild(fs_);
  }
  form.appendChild(el('div','dim','文件：' + c.path + '（权限 600，写入时自动设）'));

  const acc = el('fieldset'); acc.appendChild(el('legend', null, '账号'));
  for (const [name, label, type] of [['username','账号（留空 = 不改）','text'],['current','当前密码','password'],['password','新密码（至少 8 位）','password']]) {
    const w = el('label', null, label); const i = document.createElement('input');
    i.type = type; i.dataset.acc = name; i.value = name === 'username' ? USER : '';
    w.appendChild(i); acc.appendChild(w);
  }
  const btn = el('button','primary','改账号密码'); btn.type = 'button';
  btn.onclick = async () => {
    const body = {};
    for (const i of acc.querySelectorAll('input')) body[i.dataset.acc] = i.value;
    try {
      await fetch('/api/account', { method: 'POST', headers: { 'x-csrf': '1' }, body: JSON.stringify(body) });
      location.reload();
    } catch (e) { alert(String(e)); }
  };
  acc.appendChild(btn);
  form.appendChild(acc);
}

document.getElementById('save').onclick = async () => {
  const patch = {};
  for (const inp of document.querySelectorAll('#cfg input')) {
    const path = inp.dataset.path;
    let v;
    if (inp.type === 'checkbox') v = inp.checked;
    else if (inp.type === 'number') { if (inp.value.trim() === '') continue; v = Number(inp.value); }
    else { if (inp.value.trim() === '') continue; v = inp.value.trim(); }
    set(patch, path, v);
  }
  const r = await api('/api/config', { method:'POST', body: JSON.stringify(patch) });
  document.getElementById('save-hint').textContent = '已保存到 ' + r.path + '（下次会话生效）';
};

// ---------------------------------------------------------------- 入口
async function refresh() {
  await loadOverview();
  await loadList();
  await loadPending();
  await loadDupes();
}
document.getElementById('refresh').onclick = refresh;
document.getElementById('q').addEventListener('input', () => { const q = document.getElementById('q').value.trim(); renderList(q ? cache.filter(m => m.content.includes(q) || (m.topic||'').includes(q)) : cache, document.getElementById('scope').value); });
document.getElementById('scope').onchange = refresh;
document.getElementById('state').onchange = refresh;
document.getElementById('topic').onchange = refresh;
document.getElementById('gscope').onchange = loadGraph;
refresh(); loadSettings(); loadGraph();
</script>
</body></html>`;

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
          const html = page(session.user);
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          return res.end(html);
        }

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
              id: String(r.id), kind: String(r.kind), question: String(r.question), options: String(r.options), memoryId: String(r.memory_id),
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
