/**
 * 存储层 —— node:sqlite（Node 24 内置，零依赖）+ FTS5 + sqlite-vec。
 *
 * 规格见 DESIGN.md §7 与 §8.6。要点：
 *   - 一个项目一个库；global 一个库。作用域硬过滤在 SQL 层，不在 JEV 层（§11.3）。
 *   - 关系层是事实源，向量层随时可重建（原则 2）。
 *   - 加载 sqlite-vec 必须用 { allowExtension: true }，写成 enableLoadExtension
 *     会报 "extension loading is not allowed"（实测踩过）。
 */

import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { MemoryNode, MemoryScope, MemoryState, MemoryType } from "../core/types.ts";
import { userVisibleReason, type FallbackRoute } from "../core/governance.ts";
import { EMBED_DIM, toVecBlob } from "../embed/encoder.ts";

const require = createRequire(import.meta.url);
const ROOT = process.env.REFLECTIVE_HOME ?? path.join(os.homedir(), ".pi/agent/reflective-storage");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id              TEXT PRIMARY KEY,
  content         TEXT NOT NULL,
  summary         TEXT,
  type            TEXT NOT NULL,
  scope           TEXT NOT NULL,
  scope_id        TEXT,
  topic           TEXT,
  importance      REAL DEFAULT 0.5,
  decay_score     REAL DEFAULT 1.0,
  state           TEXT DEFAULT 'active',
  created_at      INTEGER NOT NULL,
  last_accessed   INTEGER,
  access_count    INTEGER DEFAULT 0,
  source          TEXT,
  metadata        TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, scope_id, state);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);

CREATE TABLE IF NOT EXISTS memory_relations (
  from_id         TEXT NOT NULL,
  to_id           TEXT NOT NULL,
  relation        TEXT NOT NULL,
  confidence      REAL,
  created_at      INTEGER,
  PRIMARY KEY (from_id, to_id, relation)
);

CREATE TABLE IF NOT EXISTS reflection_traces (
  id              TEXT PRIMARY KEY,
  memory_id       TEXT,
  stage           TEXT,
  gate            TEXT,
  action          TEXT,
  target_id       TEXT,
  judgment        TEXT,
  reason          TEXT,
  confidence      REAL,
  status          TEXT,
  fallback_used   TEXT,
  user_visible    TEXT,
  jev_request     TEXT,
  jev_response    TEXT,
  latency_ms      INTEGER,
  created_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_traces_created ON reflection_traces(created_at DESC);

-- J15 轻量反馈（§7.1）。Phase 1 只记录 recalled / injected；cited 与 user_feedback
-- 留空 —— 「模型有没有真用上」要等 Phase 2 的事后核对，现在编不出来。
CREATE TABLE IF NOT EXISTS feedback_logs (
  id              TEXT PRIMARY KEY,
  session_id      TEXT,
  query           TEXT,
  recalled_ids    TEXT,
  injected_ids    TEXT,
  cited_ids       TEXT,
  user_feedback   TEXT,
  effect_score    REAL,
  created_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback_logs(created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  content, summary, content='memories', content_rowid='rowid'
);
`;

export interface OpenedDb {
  db: DatabaseSync;
  file: string;
  vecEnabled: boolean;
  close(): void;
}

/** 最近一个 .git 祖先目录。 */
function gitRoot(cwd: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(cwd);
    dir = up;
  }
}

/**
 * 项目 id：git 根名 + 根下的第一层目录名。
 *
 * 两种错误做法都避开了：
 *   - cwd 的 basename：在深层目录下会解析出 "java"/"src" 这种垃圾库名（既有实践踩过）。
 *   - 只用 git 根名：本机 /code/MyProject 一个仓库里有 AIProject / GameProject /
 *     ReflectiveStorage 好几个项目，会全挤进同一个库，记忆互相污染。
 *
 * 只取一层是为了稳定：在 ReflectiveStorage/src/jev 里工作也归到同一个库。
 */
export function projectIdFor(cwd: string): string {
  const dir = path.resolve(cwd);
  const root = gitRoot(dir);
  const base = path.basename(root);
  if (dir === root) return base;
  const first = path.relative(root, dir).split(path.sep)[0];
  return first ? `${base}-${first}` : base;
}

function resolveVecPath(): string | null {
  if (process.env.REFLECTIVE_VEC_SO) {
    return fs.existsSync(process.env.REFLECTIVE_VEC_SO) ? process.env.REFLECTIVE_VEC_SO : null;
  }
  try {
    return require("sqlite-vec").getLoadablePath() as string;
  } catch {
    return null;
  }
}

export function openDb(file: string): OpenedDb {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { allowExtension: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);

  // 向量层可缺：缺了系统照样跑，只是召回少了语义那一路（原则 2：向量层可重建）。
  let vecEnabled = false;
  const vecPath = resolveVecPath();
  if (vecPath) {
    try {
      db.loadExtension(vecPath);
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(
        memory_id TEXT PRIMARY KEY,
        embedding FLOAT[${EMBED_DIM}]
      )`);
      vecEnabled = true;
    } catch {
      vecEnabled = false;
    }
  }

  return { db, file, vecEnabled, close: () => db.close() };
}

export function openProjectDb(cwd: string): OpenedDb {
  return openDb(path.join(ROOT, "projects", `${projectIdFor(cwd)}.db`));
}
export function openGlobalDb(): OpenedDb {
  return openDb(path.join(ROOT, "global.db"));
}

type Row = Record<string, unknown>;

function toNode(r: Row): MemoryNode {
  return {
    id: r.id as string,
    content: r.content as string,
    summary: (r.summary as string) ?? null,
    type: r.type as MemoryType,
    scope: r.scope as MemoryScope,
    scopeId: (r.scope_id as string) ?? null,
    topic: (r.topic as string) ?? null,
    importance: Number(r.importance ?? 0.5),
    decayScore: Number(r.decay_score ?? 1),
    state: (r.state as MemoryState) ?? "active",
    createdAt: Number(r.created_at),
    lastAccessed: r.last_accessed == null ? null : Number(r.last_accessed),
    accessCount: Number(r.access_count ?? 0),
    source: (r.source as string) ?? null,
    metadata: (r.metadata as string) ?? null,
  };
}

export interface InsertMemory {
  content: string;
  type: MemoryType;
  scope: MemoryScope;
  scopeId: string | null;
  importance?: number;
  summary?: string | null;
  topic?: string | null;
  source?: string | null;
}

export function insertMemory(o: OpenedDb, m: InsertMemory): MemoryNode {
  const node: MemoryNode = {
    id: randomUUID(),
    content: m.content,
    summary: m.summary ?? null,
    type: m.type,
    scope: m.scope,
    scopeId: m.scopeId,
    topic: m.topic ?? null,
    importance: m.importance ?? 0.5,
    decayScore: 1,
    state: "active",
    createdAt: Date.now(),
    lastAccessed: null,
    accessCount: 0,
    source: m.source ?? null,
    metadata: null,
  };
  o.db
    .prepare(
      `INSERT INTO memories (id, content, summary, type, scope, scope_id, topic, importance,
                             decay_score, state, created_at, last_accessed, access_count, source, metadata)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      node.id, node.content, node.summary, node.type, node.scope, node.scopeId, node.topic,
      node.importance, node.decayScore, node.state, node.createdAt, node.lastAccessed,
      node.accessCount, node.source, node.metadata,
    );
  // FTS5 外部内容表需要手动同步
  o.db.prepare(`INSERT INTO memory_fts (rowid, content, summary) VALUES (
      (SELECT rowid FROM memories WHERE id = ?), ?, ?)`).run(node.id, node.content, node.summary ?? "");
  return node;
}

export function putEmbedding(o: OpenedDb, memoryId: string, vec: number[]): boolean {
  if (!o.vecEnabled) return false;
  o.db.prepare(`DELETE FROM memory_embeddings WHERE memory_id = ?`).run(memoryId);
  o.db.prepare(`INSERT INTO memory_embeddings (memory_id, embedding) VALUES (?, ?)`).run(memoryId, toVecBlob(vec));
  return true;
}

/**
 * 作用域硬过滤（DESIGN.md §11.2）。JEV 的判断是建议，这行 SQL 才是门禁：
 * 它必须在自己这一层挡住跨项目记忆，不能先跨项目召回再逐条让 JEV 判断。
 */
export function listInScope(o: OpenedDb, scope: MemoryScope, scopeId: string | null, limit = 200): MemoryNode[] {
  const rows = o.db
    .prepare(
      `SELECT * FROM memories
        WHERE state IN ('active','cold')
          AND ((scope = ? AND scope_id IS ?) OR scope = 'global')
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(scope, scopeId, limit) as Row[];
  return rows.map(toNode);
}

/** 向量 kNN 召回。返回 [记忆, 距离]，距离越小越近。 */
export function searchByVector(o: OpenedDb, vec: number[], k = 20): Array<[MemoryNode, number]> {
  if (!o.vecEnabled) return [];
  const hits = o.db
    .prepare(
      `SELECT memory_id, distance FROM memory_embeddings
        WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
    )
    .all(toVecBlob(vec), k) as Row[];
  const out: Array<[MemoryNode, number]> = [];
  for (const h of hits) {
    const row = o.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(h.memory_id as string) as Row | undefined;
    if (row) out.push([toNode(row), Number(h.distance)]);
  }
  return out;
}

/** 关键词召回。trigram 对中文是字符三元组，只是粗筛（DESIGN.md §7.3）。 */
export function searchByKeyword(o: OpenedDb, query: string, k = 20): MemoryNode[] {
  const q = query.replace(/["']/g, " ").trim();
  if (q.length < 3) return [];
  try {
    const rows = o.db
      .prepare(
        `SELECT m.* FROM memory_fts f JOIN memories m ON m.rowid = f.rowid
          WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts) LIMIT ?`,
      )
      .all(`"${q}"`, k) as Row[];
    return rows.map(toNode);
  } catch {
    return [];
  }
}

export function getMemory(o: OpenedDb, id: string): MemoryNode | null {
  const row = o.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as Row | undefined;
  return row ? toNode(row) : null;
}

export function markAccessed(o: OpenedDb, ids: string[]): void {
  if (ids.length === 0) return;
  const stmt = o.db.prepare(`UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?`);
  const now = Date.now();
  for (const id of ids) stmt.run(now, id);
}

export function setState(o: OpenedDb, id: string, state: MemoryState): void {
  o.db.prepare(`UPDATE memories SET state = ? WHERE id = ?`).run(state, id);
}

export function hardDelete(o: OpenedDb, id: string): void {
  o.db.prepare(`INSERT INTO memory_fts (memory_fts, rowid, content, summary) VALUES (
      'delete', (SELECT rowid FROM memories WHERE id = ?),
      (SELECT content FROM memories WHERE id = ?), (SELECT summary FROM memories WHERE id = ?))`)
    .run(id, id, id);
  o.db.prepare(`DELETE FROM memory_relations WHERE from_id = ? OR to_id = ?`).run(id, id);
  if (o.vecEnabled) o.db.prepare(`DELETE FROM memory_embeddings WHERE memory_id = ?`).run(id);
  o.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
}

export function addRelation(o: OpenedDb, fromId: string, toId: string, relation: string, confidence: number): void {
  o.db
    .prepare(`INSERT OR REPLACE INTO memory_relations (from_id, to_id, relation, confidence, created_at) VALUES (?,?,?,?,?)`)
    .run(fromId, toId, relation, confidence, Date.now());
}

export interface TraceInput {
  memoryId?: string | null;
  stage: string;
  gate: string;
  action: string;
  targetId?: string | null;
  reason?: string | null;
  confidence?: number | null;
  status?: string | null;
  fallbackUsed?: string | null;
  latencyMs?: number | null;
  /** J14b 的路由结果，由调用方给；不给就不过滤。 */
  route?: FallbackRoute;
  /** J14c 的一句人话；不给就用模板拼。 */
  userVisible?: string;
}

export function addTrace(o: OpenedDb, t: TraceInput): void {
  o.db
    .prepare(
      `INSERT INTO reflection_traces (id, memory_id, stage, gate, action, target_id, judgment,
                                      reason, confidence, status, fallback_used, user_visible,
                                      latency_ms, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      randomUUID(), t.memoryId ?? null, t.stage, t.gate, t.action, t.targetId ?? null,
      t.route ?? null, t.reason ?? null, t.confidence ?? null, t.status ?? null,
      t.fallbackUsed ?? null,
      t.userVisible ?? userVisibleReason({ stage: t.stage, action: t.action, status: t.status, route: t.route, reason: t.reason }),
      t.latencyMs ?? null, Date.now(),
    );
}

/** J15：一次召回登记一条。只记事实（召回了什么、注入了什么），不推断效果。 */
export interface RecallLog {
  sessionId: string;
  query: string;
  recalledIds: string[];
  injectedIds: string[];
}

export function recordRecall(o: OpenedDb, log: RecallLog): void {
  o.db
    .prepare(
      `INSERT INTO feedback_logs (id, session_id, query, recalled_ids, injected_ids, cited_ids,
                                 user_feedback, effect_score, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(randomUUID(), log.sessionId, log.query, JSON.stringify(log.recalledIds), JSON.stringify(log.injectedIds),
      null, null, null, Date.now());
}

/** 最近几次召回，给 /memory 看「为什么这次没注入」。 */
export function recentRecalls(o: OpenedDb, limit = 3): Row[] {
  return o.db
    .prepare(`SELECT query, recalled_ids, injected_ids, created_at FROM feedback_logs ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as Row[];
}

export function countMemories(o: OpenedDb): number {
  return Number((o.db.prepare(`SELECT count(*) c FROM memories`).get() as Row).c);
}

/** 某条记忆的判断轨迹，用于回答「为什么记住的」。按时间正序，最早的判断在最前面。 */
export function tracesFor(o: OpenedDb, memoryId: string): Row[] {
  return o.db
    .prepare(
      `SELECT gate, action, reason, status, fallback_used, confidence, judgment, user_visible, created_at
         FROM reflection_traces WHERE memory_id = ? ORDER BY created_at`,
    )
    .all(memoryId) as Row[];
}
