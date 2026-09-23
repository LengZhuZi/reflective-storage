/**
 * 记忆树（DESIGN §7.1 的 `memory_tree_links`）—— 目前只用 **path 这一棵树**。
 *
 * 为什么路径来源是**文件路径**而不是主题名：
 *   - 给记忆起主题名会碎成同义词（实测），现在交给提炼层定（见 §8.7）；而**路径**不该走模型 ——
 *     它要的是跟代码结构一致，不是语义。
 *   - 而 pi 的 tool call 自带文件路径（`src/backend/auth/login.ts`）。拿它当路径：
 *     零生成、零追问、跟代码结构天然一致，深度由代码决定而不是靠人起名。
 *
 * 物化路径 + LIKE 前缀查询就够，不需要递归 CTE，也不需要给中间节点建空行：
 * 子树 = `WHERE path LIKE '/src/backend/%'`。
 *
 * 已知代价（写在 DESIGN 里）：目录改名会让老路径变孤儿。现在的处理是**保留孤儿**并在
 * `/memory ui` 里能看见，不做自动迁移 —— 猜错了移错地方比留着更坏。
 */

import * as path from "node:path";
import type { MemoryNode } from "../core/types.ts";
import { linkPath, memoriesUnderPath, pathsFor, type OpenedDb } from "../storage/db.ts";

/** 一次最多给一条记忆挂几个路径（挂太多等于没挂：候选会变噪声）。 */
export const MAX_PATHS_PER_MEMORY = 3;
/** 路径只留到这一层，再深就截断（`/src/a/b/c/d.ts` → `/src/a/b`）。 */
export const MAX_PATH_DEPTH = 4;

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|py|go|java|kt|rs|rb|php|cs|vue|svelte|html|css|scss|sql|sh)$/i;

/**
 * 把绝对/相对路径规整成树路径：`/code/P/app/src/a/b.ts` + cwd `/code/P/app` → `/src/a/b`。
 * 去掉扩展名（同一个文件改名不该换节点）、统一 `/`、深度截断。
 */
export function toTreePath(file: string, cwd: string): string | null {
  if (!file || file.startsWith("/tmp/") || file.includes("node_modules/") || file.startsWith(".git/")) return null;
  const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
  const rel = path.relative(cwd, abs);
  if (rel.startsWith("..")) return null;                 // 项目外的文件不进这棵树
  const noExt = rel.replace(CODE_EXT, "");
  const parts = noExt.split(path.sep).filter((p) => p && p !== ".");
  if (parts.length === 0) return null;
  return "/" + parts.slice(0, MAX_PATH_DEPTH).join("/");
}

/** 从一批被碰过的文件里挑出该挂的树路径（去重、限量、浅的优先）。 */
export function pickTreePaths(files: readonly string[], cwd: string): string[] {
  const out: string[] = [];
  for (const f of files) {
    const p = toTreePath(f, cwd);
    if (!p || out.includes(p)) continue;
    out.push(p);
    if (out.length >= MAX_PATHS_PER_MEMORY) break;
  }
  return out.sort((a, b) => a.split("/").length - b.split("/").length);
}

/** 把路径挂到记忆上（写路径用）。 */
export function attachPaths(o: OpenedDb, memoryId: string, files: readonly string[], cwd: string): string[] {
  const picked = pickTreePaths(files, cwd);
  for (const p of picked) linkPath(o, memoryId, p);
  return picked;
}

/**
 * 提问里提到的路径 —— 这是路径那一路的召回入口。
 * 只认**像路径的东西**：带 `/` 的片段，或带代码后缀的文件名（`login.ts`）。
 * 中文自然语言里不会误触发，所以不需要判断引擎。
 */
export function mentionsPath(query: string, treePath: string): boolean {
  const q = query.toLowerCase();
  const p = treePath.toLowerCase();
  if (p.length < 3) return false;
  const tokens = q.match(/[a-z0-9_\-./]+/g) ?? [];
  for (const t of tokens) {
    if (t.length < 3) continue;
    if (t.includes("/") && (p.includes(t) || t.includes(p))) return true;
    if (CODE_EXT.test(t) && p.includes(t.replace(CODE_EXT, ""))) return true;
  }
  return false;
}

/** 路径那一路的候选：提问里提到路径时，把该子树下的记忆捞进来。 */
export function pathCandidates(o: OpenedDb, query: string, allPaths: readonly string[], limit = 30): MemoryNode[] {
  const out = new Map<string, MemoryNode>();
  for (const p of allPaths) {
    if (!mentionsPath(query, p)) continue;
    for (const m of memoriesUnderPath(o, p, limit)) out.set(m.id, m);
  }
  return [...out.values()];
}

export { pathsFor };
