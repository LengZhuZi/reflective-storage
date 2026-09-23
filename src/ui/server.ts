/**
 * 本地 UI —— 一个只绑 127.0.0.1 的小网页，用来「看得见、能删、能复核」（§15 原则 7）。
 *
 * 为什么不是 Electron / Vite / React：这是单机单用户的排查面板，为一个页面拉一条构建链
 * 不划算。`node:http` + 一个内联的 HTML 字符串就够了，零依赖、零构建、开箱能跑。
 *
 * 三条安全线，一条都不能省：
 *
 *  1. **只绑 127.0.0.1**，不监听外网。
 *  2. **URL 里带一次性 token**（`/t/<token>/…`）。回环地址不等于安全：别的进程、以及浏览器里
 *     打开的任意网页都能 POST 到 localhost（CSRF）。没有 token 一律 403。
 *  3. **页面渲染记忆内容时必须转义**。记忆原文来自历史会话，是不可信输入（§15 原则 14）——
 *     一条写着 `<img onerror=…>` 的记忆不该在页面上执行。前端一律用 textContent 拼 DOM，
 *     不用 innerHTML 拼内容（标记结构可以，数据不行）。
 *
 * 服务在 `/memory ui` 时按需启动，session_shutdown 关闭 —— 不在扩展工厂里起任何长驻资源（§8.2）。
 */

import * as http from "node:http";
import * as crypto from "node:crypto";
import type { MemoryNode } from "../core/types.ts";
import {
  addTrace, countMemories, countPendingReviews, distinctTopics, getMemory, hardDelete,
  pendingReviews, queryMemories, resolveReview, setTopic, tracesFor, type OpenedDb,
} from "../storage/db.ts";
import { RESOLUTION_LABELS, applyResolution, SCOPE_WIDEN, widenScopeToGlobal } from "../pipeline/review.ts";

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

const json = (res: http.ServerResponse, code: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

const page = (token: string): string => `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>反思存储 · 记忆库</title>
<style>
  :root { color-scheme: light dark; --line: color-mix(in oklab, currentColor 18%, transparent); --dim: color-mix(in oklab, currentColor 55%, transparent); }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.55 ui-sans-serif, system-ui, "PingFang SC", "Noto Sans CJK SC", sans-serif; }
  header { position: sticky; top: 0; backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); padding: 14px 20px; display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
  h1 { font-size: 15px; margin: 0; font-weight: 650; letter-spacing: .01em; }
  main { padding: 20px; max-width: 1100px; }
  .dim { color: var(--dim); font-size: 13px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 0 0 16px; }
  input, select, button { font: inherit; padding: 6px 10px; border: 1px solid var(--line); background: transparent; color: inherit; border-radius: 6px; }
  input[type=search] { min-width: 260px; }
  button { cursor: pointer; }
  button:hover { border-color: currentColor; }
  button.danger { color: color-mix(in oklab, red 70%, currentColor); }
  .card { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin: 0 0 10px; }
  .card h3 { margin: 0 0 6px; font-size: 14px; font-weight: 600; }
  .meta { display: flex; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--dim); }
  .content { white-space: pre-wrap; word-break: break-word; margin: 6px 0; }
  .traces { margin-top: 8px; border-top: 1px dashed var(--line); padding-top: 8px; font-size: 12.5px; }
  .traces div { white-space: pre-wrap; }
  .pending { border-left: 3px solid color-mix(in oklab, orange 70%, currentColor); padding-left: 12px; }
  .empty { color: var(--dim); padding: 24px 0; }
  code { font-size: 12px; }
</style></head>
<body>
<header>
  <h1>反思存储 · 记忆库</h1>
  <span class="dim" id="summary"></span>
</header>
<main>
  <div class="row">
    <select id="scope"><option value="project">项目库</option><option value="global">全局库</option></select>
    <select id="state"><option value="">全部状态</option><option value="active">active</option><option value="cold">cold</option><option value="archived">archived</option><option value="superseded">superseded</option></select>
    <select id="topic"><option value="">全部主题</option></select>
    <input type="search" id="q" placeholder="按内容过滤（本地过滤，不走网络）">
    <button id="refresh">刷新</button>
  </div>
  <section id="pending"></section>
  <section id="list"></section>
</main>
<script>
const TOKEN = ${JSON.stringify(token)};
const api = (p, opt) => fetch('/t/' + TOKEN + p, opt).then(r => r.ok ? r.json() : r.text().then(t => { throw new Error(t); }));
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
let cache = [];

async function loadState() {
  const s = await api('/api/state');
  document.getElementById('summary').textContent =
    '项目库 ' + s.project + ' 条 · 全局库 ' + s.global + ' 条 · 待确认 ' + s.pending + ' 条 · ' + s.engine;
  const sel = document.getElementById('topic');
  sel.length = 1;
  for (const t of s.topics) { const o = document.createElement('option'); o.value = o.textContent = t; sel.appendChild(o); }
  return s;
}

function renderPending(items, scopeOf) {
  const box = document.getElementById('pending');
  box.replaceChildren();
  for (const it of items) {
    const card = el('div', 'card pending');
    card.appendChild(el('div', 'dim', it.kind === 'merge' ? '合并提议' : it.kind === 'conflict' ? '低置信冲突' : it.kind === 'topic' ? '起个主题' : '作用域待确认'));
    card.appendChild(el('div', 'content', it.question));
    const row = el('div', 'row');
    const opts = JSON.parse(it.options);
    const choices = it.kind === 'topic' ? ['先不起主题'] : opts;
    for (const o of choices) {
      const b = el('button', null, o);
      b.onclick = async () => {
        b.disabled = true;
        const res = await api('/api/review/' + it.id, { method: 'POST', body: JSON.stringify({ resolution: o, scope: scopeOf(it) }) });
        await refresh();
        console.log(res);
      };
      row.appendChild(b);
    }
    if (it.kind === 'topic') {
      const input = document.createElement('input');
      input.placeholder = '或直接输入主题名';
      const b = el('button', null, '起名');
      b.onclick = async () => { b.disabled = true; await api('/api/review/' + it.id, { method: 'POST', body: JSON.stringify({ resolution: input.value, scope: 'project' }) }); await refresh(); };
      row.append(input, b);
    }
    card.appendChild(row);
    box.appendChild(card);
  }
}

function renderList(items, scope) {
  const list = document.getElementById('list');
  list.replaceChildren();
  if (!items.length) { list.appendChild(el('div', 'empty', '没有符合条件的记忆')); return; }
  for (const m of items) {
    const card = el('div', 'card');
    card.appendChild(el('h3', null, m.type + ' · ' + m.scope + (m.topic ? ' · ' + m.topic : '')));
    card.appendChild(el('div', 'content', m.content));
    const meta = el('div', 'meta');
    for (const t of [ '状态 ' + m.state, '重要度 ' + Number(m.importance).toFixed(2), '衰减 ' + Number(m.decayScore).toFixed(2), '访问 ' + m.accessCount + ' 次',
      '建于 ' + new Date(Number(m.createdAt)).toLocaleString(), 'id ' + String(m.id).slice(0, 8) ]) meta.appendChild(el('span', null, t));
    card.appendChild(meta);
    const row = el('div', 'row');
    const why = el('button', null, '为什么记住');
    const traces = el('div', 'traces');
    why.onclick = async () => {
      if (traces.childElementCount) { traces.replaceChildren(); return; }
      const r = await api('/api/traces?scope=' + scope + '&id=' + m.id);
      if (!r.items.length) traces.appendChild(el('div', 'dim', '没有判断轨迹'));
      for (const t of r.items) traces.appendChild(el('div', null, (t.userVisible || '') + '  [' + t.gate + ' ' + t.action + ' ' + (t.status || '?') + '] ' + (t.reason || '')));
    };
    const del = el('button', 'danger', '删除');
    del.onclick = async () => {
      if (!confirm('硬删除这条记忆？不可撤销。\\n\\n' + m.content.slice(0, 80))) return;
      del.disabled = true;
      await api('/api/memory/' + m.id + '?scope=' + scope, { method: 'DELETE' });
      await refresh();
    };
    row.append(why, del);
    card.append(row, traces);
    list.appendChild(card);
  }
}

async function refresh() {
  const state = await loadState();
  const scope = document.getElementById('scope').value;
  const stateFilter = document.getElementById('state').value;
  const topic = document.getElementById('topic').value;
  const q = document.getElementById('q').value.trim();
  const r = await api('/api/memories?scope=' + scope + '&state=' + encodeURIComponent(stateFilter) + '&topic=' + encodeURIComponent(topic));
  cache = r.items.filter(m => !q || m.content.includes(q) || (m.topic || '').includes(q));
  renderPending(r.pending, () => scope);
  renderList(cache, scope);
}

document.getElementById('refresh').onclick = refresh;
document.getElementById('scope').onchange = refresh;
document.getElementById('state').onchange = refresh;
document.getElementById('topic').onchange = refresh;
document.getElementById('q').addEventListener('input', () => renderList(cache.filter(m => !document.getElementById('q').value.trim() || m.content.includes(document.getElementById('q').value.trim())), document.getElementById('scope').value));
refresh();
</script>
</body></html>`;

export function startUi(deps: UiDeps): Promise<UiHandles> {
  const token = crypto.randomUUID().replace(/-/g, "");
  const dbFor = (scope: string): OpenedDb => (scope === "global" ? deps.globalDb : deps.projectDb);

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const prefix = `/t/${token}`;
        // token 不对一律 403：回环地址不是安全边界（别的进程/网页也能打 localhost）。
        if (!url.pathname.startsWith(prefix)) return json(res, 403, { error: "forbidden" });
        const path = url.pathname.slice(prefix.length);

        if (req.method === "GET" && (path === "/" || path === "")) {
          const html = page(token);
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          return res.end(html);
        }

        if (req.method === "GET" && path === "/api/state") {
          return json(res, 200, {
            project: countMemories(deps.projectDb),
            global: countMemories(deps.globalDb),
            pending: countPendingReviews(deps.projectDb),
            topics: [...new Set([...distinctTopics(deps.projectDb), ...distinctTopics(deps.globalDb)])],
            projectId: deps.projectId,
            engine: "local-ui",
          });
        }

        if (req.method === "GET" && path === "/api/memories") {
          const scope = url.searchParams.get("scope") === "global" ? "global" : "project";
          const st = url.searchParams.get("state");
          const topic = url.searchParams.get("topic");
          const items = queryMemories(dbFor(scope), {
            states: st ? [st as MemoryNode["state"]] : undefined,
            // 项目库视图列**整个文件**（含 session 作用域的记忆）；全局库只列 scope='global'
            scope: scope === "global" ? "global" : undefined,
            topic: topic || undefined,
          });
          return json(res, 200, {
            items: items.map((m) => ({ ...m })),
            pending: pendingReviews(dbFor(scope), 20).map((r) => ({
              id: String(r.id), kind: String(r.kind), question: String(r.question), options: String(r.options), memoryId: String(r.memory_id),
            })),
          });
        }

        if (req.method === "GET" && path === "/api/traces") {
          const scope = url.searchParams.get("scope") === "global" ? "global" : "project";
          const id = url.searchParams.get("id") ?? "";
          const rows = tracesFor(dbFor(scope), id);
          return json(res, 200, {
            items: rows.map((r) => ({
              gate: String(r.gate), action: String(r.action), reason: r.reason ?? null,
              status: r.status ?? null, userVisible: r.user_visible ?? null, judgment: r.judgment ?? null,
            })),
          });
        }

        if (req.method === "DELETE" && path.startsWith("/api/memory/")) {
          const id = decodeURIComponent(path.slice("/api/memory/".length));
          const scope = url.searchParams.get("scope") === "global" ? "global" : "project";
          const db = dbFor(scope);
          if (!getMemory(db, id)) return json(res, 404, { error: "没有这条记忆" });
          // 删除不可逆：先留痕再删（删完就查不到了）。
          addTrace(db, { memoryId: id, stage: "governance", gate: "J12", action: "delete", reason: "本地 UI 手动删除" });
          hardDelete(db, id);
          return json(res, 200, { ok: true });
        }

        if (req.method === "POST" && path.startsWith("/api/review/")) {
          const id = decodeURIComponent(path.slice("/api/review/".length));
          const body = JSON.parse((await readBody(req)) || "{}") as { resolution?: string; scope?: string };
          const db = deps.projectDb;
          const item = pendingReviews(db, 100).find((r) => String(r.id) === id);
          if (!item) return json(res, 404, { error: "这条待确认已经不在了" });
          const kind = String(item.kind);
          const resolution = body.resolution ?? "";

          if (kind === "topic") {
            if (resolution && resolution !== "先不起主题") {
              const target = getMemory(db, String(item.memory_id)) ?? getMemory(deps.globalDb, String(item.memory_id));
              if (target) setTopic(target.scope === "global" ? deps.globalDb : db, String(item.memory_id), resolution);
            }
            resolveReview(db, id, resolution ? `topic:${resolution}` : "topic:skipped");
            return json(res, 200, { ok: true, resolution });
          }
          if (kind === "scope") {
            resolveReview(db, id, resolution === SCOPE_WIDEN ? "scope:widen" : "scope:keep");
            return json(res, 200, { ok: true, result: resolution === SCOPE_WIDEN ? widenScopeToGlobal(db, deps.globalDb, String(item.memory_id)) : "保持项目级" });
          }
          const label = Object.entries(RESOLUTION_LABELS).find(([, l]) => l === resolution)?.[0] ?? "keep_both";
          return json(res, 200, { ok: true, result: applyResolution(db, item, label as never) });
        }

        return json(res, 404, { error: "not found" });
      } catch (e) {
        return json(res, 500, { error: (e as Error).message });
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/t/${token}/`,
        close: () => server.close(),
      });
    });
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
      if (Buffer.concat(chunks).length > 64 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
