/**
 * 清空所有记忆库 —— 测试用。
 *
 * 跑法：`node scripts/wipe.ts`（或 `npm run wipe`）
 *
 * 三件必须做对的事，少一件都会留下“看起来删干净了”的脏数据：
 *  1. **先整份备份**（.db + -wal + -shm）到 `~/.pi/agent/reflective-storage-wiped-<时间戳>/`。
 *     删错了还能捞回来，所以这个脚本不需要二次确认。
 *  2. `memory_fts` 是 external content 表（`content='memories'`）：只删主表会留幽灵索引，
 *     召回能捞出已经不存在的行。删完要 `'delete-all'`。
 *  3. 向量表是 vec0 虚拟表，**删它需要 sqlite-vec 扩展**。普通 sqlite 进程会报
 *     `no such module: vec0`，所以这里必须走仓库自己的 `openDb()`（它会 loadExtension）。
 *
 * 配置（config.json / ui-auth.json / ui.json）**不动**：那里面是端点和凭据，不是记忆。
 */

import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.ts";
import { openDb } from "../src/storage/db.ts";

const TABLES = [
  "memories", "memory_relations", "reflection_traces", "memory_tree_links",
  "project_registry", "review_queue", "feedback_logs", "memory_embeddings",
];

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const backup = path.join(path.dirname(ROOT), `reflective-storage-wiped-${stamp}`);

function dbFiles(): string[] {
  const projects = path.join(ROOT, "projects");
  const list = fs.existsSync(projects)
    ? fs.readdirSync(projects).filter((f) => f.endsWith(".db")).map((f) => path.join(projects, f))
    : [];
  return [path.join(ROOT, "global.db"), ...list];
}

const files = dbFiles();
fs.mkdirSync(path.join(backup, "projects"), { recursive: true });
for (const f of files) {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(f + suffix)) {
      fs.copyFileSync(f + suffix, path.join(backup, path.relative(ROOT, f) + suffix));
    }
  }
}
console.log(`备份: ${backup}`);

for (const f of files) {
  if (!fs.existsSync(f)) continue;
  const o = openDb(f);
  const before = TABLES.map((t) => {
    try { return o.db.prepare(`select count(*) c from ${t}`).get().c as number; } catch { return 0; }
  });
  o.db.exec("BEGIN");
  for (const t of TABLES) {
    try { o.db.prepare(`DELETE FROM ${t}`).run(); } catch { /* 这个库没这张表（老库/没开向量） */ }
  }
  try { o.db.prepare(`INSERT INTO memory_fts(memory_fts) VALUES('delete-all')`).run(); } catch { /* 没 fts 就跳过 */ }
  o.db.exec("COMMIT");
  o.db.exec("VACUUM");
  const fts = (() => { try { return o.db.prepare("select count(*) c from memory_fts").get().c as number; } catch { return 0; } })();
  o.close();
  const wiped = TABLES.map((t, i) => `${t} ${before[i]!}->0`).filter((s) => !s.endsWith(" 0->0"));
  console.log(`${path.relative(ROOT, f)} | ${wiped.join(" ") || "本来就是空的"} | fts ${fts}`);
}

console.log("完成。面板还开着也没事（读的时候自然是空的）；pi 会话里已注入过的块不会凭空消失，下个会话才是干净起点。");
