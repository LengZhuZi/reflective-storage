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
import type { MemoryNode, MemoryOrigin, MemoryScope, MemoryState, MemoryType } from "../core/types.ts";
import { TRUST_CAP } from "../core/types.ts";
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
  origin          TEXT DEFAULT 'user',
  trust           REAL DEFAULT 1.0,
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

-- 记忆树链接（DESIGN §7.1）。目前只用 path 这一棵树：pi 的 tool call 自带文件路径，
-- 直接拿它当树的路径，零生成、零追问、跟代码结构天然一致。
CREATE TABLE IF NOT EXISTS memory_tree_links (
  memory_id       TEXT NOT NULL,
  tree_name       TEXT NOT NULL,
  parent_id       TEXT,
  path            TEXT,
  position        INTEGER,
  PRIMARY KEY (memory_id, tree_name, parent_id)
);
CREATE INDEX IF NOT EXISTS idx_tree_path ON memory_tree_links(tree_name, path);

-- 项目注册表（跨项目的入口层）。放 global.db —— 所有项目的会话都能看到它。
-- 内容是**派生**出来的（主题清单 / 条数 / 最近几条标题），不需要引擎生成，
-- 所以刷新它不花一次判断调用。
CREATE TABLE IF NOT EXISTS project_registry (
  project_id      TEXT PRIMARY KEY,
  dir             TEXT,
  topics          TEXT,
  memory_count    INTEGER,
  recent          TEXT,
  updated_at      INTEGER
);

-- 待确认队列（§6 的「<0.5 交用户确认」+ §9.3 的合并）。
-- 引擎不确定的事不替用户拍，也不装没看见：排队，等用户过一遍。
CREATE TABLE IF NOT EXISTS review_queue (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,          -- merge / conflict
  memory_id       TEXT NOT NULL,          -- 新记的那条
  other_id        TEXT,                   -- 已有的那条
  question        TEXT NOT NULL,
  options         TEXT NOT NULL,          -- JSON 数组
  status          TEXT NOT NULL,          -- pending / resolved
  resolution      TEXT,
  created_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_review_status ON review_queue(status, created_at DESC);

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

/** 老库缺列就补上 —— SQLite 没有 ADD COLUMN IF NOT EXISTS。 */
function ensureColumn(db: DatabaseSync, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
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
  // 两个 pi 实例同时开（比如两个终端）会各自持一个连接。没有 busy_timeout 的话，
  // 撞上对方正在写就直接 SQLITE_BUSY 报错；等一会儿基本都能过去。
  db.exec("PRAGMA busy_timeout = 3000");
  db.exec(SCHEMA);
  // v0.3 之前入库的记忆都是用户原话（旧的写入路径只消化用户自己的话），
  // 所以补列时给它们 user/1.0 —— 这是回溯正确，不是猜。
  ensureColumn(db, "memories", "origin", "TEXT DEFAULT 'user'");
  ensureColumn(db, "memories", "trust", "REAL DEFAULT 1.0");

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

/** 某个项目库的文件路径（跨项目引用时按 id 打开用）。 */
export function projectDbFile(projectId: string): string {
  return path.join(ROOT, "projects", `${projectId}.db`);
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
    origin: (r.origin as MemoryOrigin) ?? "user",
    trust: r.trust == null ? 1 : Number(r.trust),
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
  origin?: MemoryOrigin;
  trust?: number;
}

export function insertMemory(o: OpenedDb, m: InsertMemory): MemoryNode {
  const node: MemoryNode = {
    id: randomUUID(),
    content: m.content,
    summary: m.summary ?? null,
    type: m.type,
    scope: m.scope,
    scopeId: m.scopeId ?? null,
    topic: m.topic ?? null,
    importance: m.importance ?? 0.5,
    decayScore: 1,
    state: "active",
    createdAt: Date.now(),
    lastAccessed: null,
    accessCount: 0,
    source: m.source ?? null,
    origin: m.origin ?? "user",
    trust: m.trust ?? 1,
    metadata: null,
  };
  o.db
    .prepare(
      `INSERT INTO memories (id, content, summary, type, scope, scope_id, topic, importance,
                             decay_score, state, created_at, last_accessed, access_count, source, origin, trust, metadata)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      node.id, node.content, node.summary, node.type, node.scope, node.scopeId, node.topic,
      node.importance, node.decayScore, node.state, node.createdAt, node.lastAccessed,
      node.accessCount, node.source, node.origin, node.trust, node.metadata,
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
 *
 * 排序都带 rowid 兜底：同一毫秒内插入的多条记忆 created_at 完全相同，只按时间排的话
 * 「最近 N 条」是不确定的（实测让一条本该落选的记忆随机挤进候选）。
 */
export function listInScope(o: OpenedDb, scope: MemoryScope, scopeId: string | null, limit = 200): MemoryNode[] {
  const rows = o.db
    .prepare(
      `SELECT * FROM memories
        WHERE state IN ('active','cold')
          AND ((scope = ? AND scope_id IS ?) OR scope = 'global')
        ORDER BY created_at DESC, rowid DESC LIMIT ?`,
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

/**
 * 调 trust（clamp 到 [0, cap]）。引擎判不了「这条对不对」—— 它只能看到文本。
 * 所以 trust 不靠引擎打分，靠两件可观测的事：用户后来在同一个话题上说话又没推翻它
 * （升），或者撞上了反证（降）。返回新值，条不见了返回 null。
 */
export function adjustTrust(o: OpenedDb, id: string, delta: number, cap = TRUST_CAP): number | null {
  const row = o.db.prepare(`SELECT trust FROM memories WHERE id = ?`).get(id) as Row | undefined;
  if (!row) return null;
  // 抹到两位小数：不抹的话 0.7+0.1 = 0.7999999999999999，跟 0.8 比大小会得到
  // 「还没过标记线」，标记永远去不掉（实测撞到）。
  const next = Math.round(Math.max(0, Math.min(cap, Number(row.trust ?? 1) + delta)) * 100) / 100;
  setTrust(o, id, next);
  return next;
}

/** 直接置 trust。不用 adjustTrust 是因为它的上限是 TRUST_CAP —— 合并时需要能拿到 1.0。 */
export function setTrust(o: OpenedDb, id: string, value: number): void {
  o.db.prepare(`UPDATE memories SET trust = ? WHERE id = ?`).run(Math.max(0, Math.min(1, value)), id);
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
    // rowid 兜底：同一毫秒内可能插了好几行（before_agent_start 和 memory_search 挨着跑），
    // 只按 created_at 排的话「最近一次」是不确定的。
    .prepare(`SELECT query, recalled_ids, injected_ids, cited_ids, effect_score, created_at FROM feedback_logs ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(limit) as Row[];
}

/** 本会话最近一次「真的注入过」的召回 —— J15 的事后核对要对着它算。 */
export function latestRecallWithInjection(o: OpenedDb, sessionId: string): Row | null {
  return (o.db
    .prepare(
      `SELECT id, recalled_ids, injected_ids FROM feedback_logs
        WHERE session_id = ? AND injected_ids != '[]' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(sessionId) as Row | undefined) ?? null;
}

/** 事后核对的结果写回那一行 —— J15 只记录，不因为分数低就删记忆。 */
export function updateRecallOutcome(o: OpenedDb, id: string, citedIds: string[], effectScore: number | null): void {
  o.db
    .prepare(`UPDATE feedback_logs SET cited_ids = ?, effect_score = ? WHERE id = ?`)
    .run(JSON.stringify(citedIds), effectScore, id);
}

/** 主题（J4）：只用来分组和遍历，不是判断依据。起名由用户或引擎选，系统不造词。 */
export function setTopic(o: OpenedDb, id: string, topic: string | null): void {
  o.db.prepare(`UPDATE memories SET topic = ? WHERE id = ?`).run(topic, id);
}

/** 现有主题，按用得多的排前面。给 J2 的选项列表和 /memory 用。 */
export function distinctTopics(o: OpenedDb, limit = 30): string[] {
  const rows = o.db
    .prepare(
      `SELECT topic, count(*) n FROM memories
        WHERE topic IS NOT NULL AND topic != '' AND state IN ('active','cold')
        GROUP BY topic ORDER BY n DESC, topic ASC LIMIT ?`,
    )
    .all(limit) as Row[];
  return rows.map((r) => String(r.topic));
}

/**
 * 某个主题下的记忆（J6 的「同主题」那一路召回）。
 *
 * 主题是**人起的名字**（引擎只能从已有主题里选，见 review.ts），所以按主题捞是一次
 * 确定性的分组查询 —— 它跟向量那 0.046 的弱区分度正好互补：说「auth 那套要不要动」
 * 时，挂在「认证」主题下的记忆可能向量检索漏掉，但按主题一捞就全在。
 * 捞多了不怕：J7 会按相关性再筛一遍，候选生成本来就该宁可多捞。
 */
export function memoriesByTopic(o: OpenedDb, topic: string, limit = 30): MemoryNode[] {
  const rows = o.db
    .prepare(
      `SELECT * FROM memories
        WHERE topic = ? AND state IN ('active','cold')
        ORDER BY COALESCE(last_accessed, created_at) DESC, rowid DESC LIMIT ?`,
    )
    .all(topic, limit) as Row[];
  return rows.map(toNode);
}

// ---------------------------------------------------------------- 待确认队列（§6 / §9.3）

export interface ReviewRow extends Row {
  id: string;
  kind: string;
  memory_id: string;
  other_id: string | null;
  question: string;
  options: string;
  status: string;
}

export interface EnqueueReview {
  kind: string;
  memoryId: string;
  otherId: string | null;
  question: string;
  options: string[];
}

/**
 * 排队问用户。同一个（kind, memory, other）已经有 pending 的就不同重复排 ——
 * 同一件事被问第二遍比不问更惹人烦。返回新行 id，重复时返回 null。
 */
export function enqueueReview(o: OpenedDb, r: EnqueueReview): string | null {
  const dupe = o.db
    .prepare(`SELECT id FROM review_queue WHERE status = 'pending' AND kind = ? AND memory_id = ? AND other_id IS ?`)
    .get(r.kind, r.memoryId, r.otherId) as Row | undefined;
  if (dupe) return null;
  const id = randomUUID();
  o.db
    .prepare(
      `INSERT INTO review_queue (id, kind, memory_id, other_id, question, options, status, resolution, created_at)
       VALUES (?,?,?,?,?,?, 'pending', NULL, ?)`,
    )
    .run(id, r.kind, r.memoryId, r.otherId, r.question, JSON.stringify(r.options), Date.now());
  return id;
}

export function pendingReviews(o: OpenedDb, limit = 20): ReviewRow[] {
  return o.db
    .prepare(`SELECT * FROM review_queue WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC LIMIT ?`)
    .all(limit) as ReviewRow[];
}

export function countPendingReviews(o: OpenedDb): number {
  return Number((o.db.prepare(`SELECT count(*) c FROM review_queue WHERE status = 'pending'`).get() as Row).c);
}

export function resolveReview(o: OpenedDb, id: string, resolution: string): void {
  o.db.prepare(`UPDATE review_queue SET status = 'resolved', resolution = ? WHERE id = ?`).run(resolution, id);
}

export function countMemories(o: OpenedDb): number {
  return Number((o.db.prepare(`SELECT count(*) c FROM memories`).get() as Row).c);
}

/**
 * 生命周期扫描用：按状态取一段。排序把「最久没碰的」放前面（从没碰过的最前），
 * 这样有上限时先处理最该处理的那些。
 */
export function listByStates(o: OpenedDb, states: readonly MemoryState[], limit = 200): MemoryNode[] {
  const marks = states.map(() => "?").join(",");
  const rows = o.db
    .prepare(
      `SELECT * FROM memories WHERE state IN (${marks})
        ORDER BY last_accessed ASC NULLS FIRST, created_at ASC, rowid ASC LIMIT ?`,
    )
    .all(...states, limit) as Row[];
  return rows.map(toNode);
}

/**
 * 找出「很久没被召回命中过」的 session 记忆的 id。
 *
 * 只看 `scope='session'`：global / project 记忆走归档那条软路，不在这里销毁。
 * 「没命中过」的判据是 `last_accessed`（召回注入时才会更新），从没命中过就用 `created_at`。
 */
export function staleSessionMemories(o: OpenedDb, days: number, now: number): string[] {
  const cutoff = now - days * 86400000;
  const rows = o.db
    .prepare(
      `SELECT id FROM memories
        WHERE scope = 'session' AND state != 'deleted'
          AND COALESCE(last_accessed, created_at) < ?
        ORDER BY COALESCE(last_accessed, created_at) ASC`,
    )
    .all(cutoff) as Row[];
  return rows.map((r) => String(r.id));
}

// ---------------------------------------------------------------- 记忆树 / 项目注册表

/** 给一条记忆挂上树路径（同一棵树、同一个路径不重复挂）。 */
export function linkPath(o: OpenedDb, memoryId: string, path: string, treeName = "path"): void {
  o.db
    .prepare(`INSERT OR IGNORE INTO memory_tree_links (memory_id, tree_name, parent_id, path, position) VALUES (?,?,?,?,?)`)
    .run(memoryId, treeName, path, path, 0);
}

/** 某个路径前缀下的记忆（子树查询：物化路径 + LIKE，不用递归）。 */
export function memoriesUnderPath(o: OpenedDb, prefix: string, limit = 30): MemoryNode[] {
  const rows = o.db
    .prepare(
      `SELECT m.* FROM memory_tree_links l JOIN memories m ON m.id = l.memory_id
        WHERE l.tree_name = 'path' AND (l.path = ? OR l.path LIKE ?) AND m.state IN ('active','cold')
        ORDER BY COALESCE(m.last_accessed, m.created_at) DESC, m.rowid DESC LIMIT ?`,
    )
    .all(prefix === "/" ? "/%" : prefix, `${prefix === "/" ? "" : prefix}/%`, limit) as Row[];
  return rows.map(toNode);
}

/** 库里现有的所有树路径（路径那一路召回的匹配对象）。 */
export function allTreePaths(o: OpenedDb, limit = 200): string[] {
  const rows = o.db
    .prepare(`SELECT DISTINCT path FROM memory_tree_links WHERE tree_name = 'path' ORDER BY length(path) ASC LIMIT ?`)
    .all(limit) as Row[];
  return rows.map((r) => String(r.path));
}

/** 顶层树节点（`/src/a/b` → `/src`）—— 逐层下钻的第一层。 */
export function topLevelPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((p) => "/" + p.split("/").filter(Boolean)[0]).filter((x) => x !== "/"))].sort();
}

/**
 * 某个节点的**直接子节点**。注意子节点是**从更深的路径里切出来的**：
 * 中间层往往没有记忆（没有行），所以 `/src` 的子节点是 `/src/backend`、`/src/frontend`，
 * 哪怕库里根本没有 `/src/backend` 这条路径。
 */
export function childPaths(paths: readonly string[], parent: string): string[] {
  const prefix = parent === "/" ? "/" : `${parent}/`;
  const depth = parent.split("/").filter(Boolean).length + 1;
  const out = new Set<string>();
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const segs = p.split("/").filter(Boolean).slice(0, depth);
    if (segs.length === depth) out.add("/" + segs.join("/"));
  }
  return [...out].sort();
}

export function pathsFor(o: OpenedDb, memoryId: string): string[] {
  const rows = o.db
    .prepare(`SELECT path FROM memory_tree_links WHERE memory_id = ? AND tree_name = 'path'`)
    .all(memoryId) as Row[];
  return rows.map((r) => String(r.path));
}

/**
 * 刷新一个项目的注册表行（派生：条数 / 主题 / 最近几条标题）。
 * `registryDb` 是放注册表的那个库（global.db），`projectDb` 是被描述的项目库 ——
 * 两个库不一样：注册表全项目共用，而条数和主题必须从**那个项目自己的库**里数。
 */
export function refreshRegistry(registryDb: OpenedDb, projectDb: OpenedDb, projectId: string, dir: string): void {
  const count = countMemories(projectDb);
  const topics = distinctTopics(projectDb, 20);
  const recent = (projectDb.db
    .prepare(`SELECT content FROM memories WHERE state IN ('active','cold') ORDER BY created_at DESC, rowid DESC LIMIT 3`)
    .all() as Row[]).map((r) => String(r.content).slice(0, 60));
  registryDb.db
    .prepare(
      `INSERT INTO project_registry (project_id, dir, topics, memory_count, recent, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(project_id) DO UPDATE SET dir=excluded.dir, topics=excluded.topics,
         memory_count=excluded.memory_count, recent=excluded.recent, updated_at=excluded.updated_at`,
    )
    .run(projectId, dir, JSON.stringify(topics), count, JSON.stringify(recent), Date.now());
}

export function listRegistry(o: OpenedDb): Array<{ projectId: string; dir: string; topics: string[]; count: number; recent: string[]; updatedAt: number }> {
  const rows = o.db
    .prepare(`SELECT project_id, dir, topics, memory_count, recent, updated_at FROM project_registry ORDER BY project_id`)
    .all() as Row[];
  return rows.map((r) => ({
    projectId: String(r.project_id),
    dir: String(r.dir ?? ""),
    topics: JSON.parse(String(r.topics ?? "[]")) as string[],
    count: Number(r.memory_count ?? 0),
    recent: JSON.parse(String(r.recent ?? "[]")) as string[],
    updatedAt: Number(r.updated_at ?? 0),
  }));
}

/** 读回某条记忆的向量（合并判重时算余弦用）。向量层没开或没存过就返回 null。 */
export function getEmbedding(o: OpenedDb, id: string): number[] | null {
  if (!o.vecEnabled) return null;
  try {
    const row = o.db.prepare(`SELECT embedding FROM memory_embeddings WHERE memory_id = ?`).get(id) as Row | undefined;
    if (!row || !(row.embedding instanceof Uint8Array)) return null;
    return Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4));
  } catch {
    return null;
  }
}

/** 本地 UI 用：按条件列记忆（条件都可选）。排序用 rowid 兜底，避免同毫秒不确定。 */
export function queryMemories(
  o: OpenedDb,
  opts: { states?: MemoryState[]; scope?: MemoryScope; topic?: string; limit?: number } = {},
): MemoryNode[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.states?.length) {
    where.push(`state IN (${opts.states.map(() => "?").join(",")})`);
    args.push(...opts.states);
  }
  if (opts.scope) {
    where.push(`scope = ?`);
    args.push(opts.scope);
  }
  if (opts.topic) {
    where.push(`topic = ?`);
    args.push(opts.topic);
  }
  const sql = `SELECT * FROM memories ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_at DESC, rowid DESC LIMIT ?`;
  return (o.db.prepare(sql).all(...args, opts.limit ?? 300) as Row[]).map(toNode);
}

/** 生命周期只改这三个字段，单独开一个写入口，免得 SQL 散在各个 pipeline 里。 */
export function updateLifecycle(
  o: OpenedDb,
  id: string,
  fields: { decayScore: number; state: MemoryState; importance?: number },
): void {
  if (fields.importance === undefined) {
    o.db.prepare(`UPDATE memories SET decay_score = ?, state = ? WHERE id = ?`).run(fields.decayScore, fields.state, id);
    return;
  }
  o.db
    .prepare(`UPDATE memories SET decay_score = ?, state = ?, importance = ? WHERE id = ?`)
    .run(fields.decayScore, fields.state, fields.importance, id);
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
