/** 面板与 /api/* 的唯一接口层。接口形状由 src/ui/server.ts 定义，这里不改动它。 */

export type Scope = "project" | "global";
export type MemoryState = "active" | "cold" | "archived" | "superseded";
export type MemoryType = "fact" | "preference" | "procedure" | "relation" | "event" | "emotion";

export interface MemoryNode {
  id: string;
  content: string;
  summary: string | null;
  type: MemoryType;
  scope: Scope | "session";
  scopeId: string | null;
  topic: string | null;
  importance: number;
  decayScore: number;
  state: MemoryState;
  createdAt: number;
  lastAccessed: number | null;
  accessCount: number;
  source: string | null;
  metadata: string | null;
}

export interface ReviewItem {
  id: string;
  kind: string;
  question: string;
  options: string;
  memoryId: string;
  /** 合并/冲突那类才有：被比的那一条。 */
  otherId: string | null;
}

export interface Overview {
  project: {
    file: string;
    count: number;
    byType: Record<string, number>;
    byState: Record<string, number>;
    byScope: Record<string, number>;
    topics: string[];
    paths: number;
  };
  global: { file: string; count: number };
  pending: number;
  dupes: number;
  dupeCosine: number;
  hitRate: number | null;
  injectedTotal: number;
  citedTotal: number;
  engine: { provider: string; ready: boolean; model?: string; baseUrl?: string; relevanceThreshold: number; problems: string[] };
  topics: string[];
  registry: Array<{ project_id: string; dir: string; memory_count: number; topics: string; updated_at: number }>;
  recalls: Array<{ query: string; recalled: number; injected: number; cited: number; effect: number | null; at: number }>;
  traces: Array<{ stage: string; gate: string; action: string; reason: string; status: string; userVisible: string }>;
}

export interface GraphNode {
  id: string;
  label: string;
  type: MemoryType;
  topic: string | null;
  scope: Scope;
  state: MemoryState;
  importance: number;
  access: number;
  path: string | null;
  created: number;
}
export interface GraphLink {
  source: string;
  target: string;
  kind: string;
}
export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export interface Dupe {
  a: string;
  b: string;
  sim: number;
  aText: string;
  bText: string;
}

export interface Detail {
  memory: MemoryNode;
  topic: string | null;
  paths: string[];
  traces: Array<{ gate: string; action: string; reason: string; status: string; userVisible: string }>;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (res.ok) return (await res.json()) as T;
  let msg = `${res.status}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) msg = body.error;
  } catch {
    /* 不是 JSON 就用状态码 */
  }
  throw new ApiError(msg, res.status);
}

/** 改状态的请求必须带这个头：Cookie 会跟着跨站表单走，自定义头过不去（服务端注释里的规矩）。 */
const MUT: RequestInit = { headers: { "x-csrf": "1" } };
const post = <T,>(path: string, body: unknown) =>
  req<T>(path, { ...MUT, method: "POST", headers: { ...MUT.headers, "content-type": "application/json" }, body: JSON.stringify(body) });

export const api = {
  session: () => req<{ user: string }>("/api/session"),
  overview: (scope: Scope) => req<Overview>(`/api/overview?scope=${scope}`),
  memories: (scope: Scope, q: { state?: string; topic?: string } = {}) => {
    const p = new URLSearchParams({ scope });
    if (q.state) p.set("state", q.state);
    if (q.topic) p.set("topic", q.topic);
    return req<{ items: MemoryNode[]; topics: string[]; pending: ReviewItem[] }>(`/api/memories?${p}`);
  },
  detail: (scope: Scope, id: string) => req<Detail>(`/api/memory-detail?scope=${scope}&id=${encodeURIComponent(id)}`),
  graph: (scope: Scope) => req<GraphData>(`/api/graph?scope=${scope}`),
  dupes: (scope: Scope) => req<{ items: Dupe[]; threshold: number }>(`/api/dupes?scope=${scope}`),
  remove: (scope: Scope, id: string) => req<{ ok: boolean }>(`/api/memory/${encodeURIComponent(id)}?scope=${scope}`, { ...MUT, method: "DELETE" }),
  merge: (keep: string, drop: string) => post<{ ok: boolean; result: string }>("/api/merge", { keep, drop }),
  resolveReview: (id: string, resolution: string) => post<{ ok: boolean; result?: string }>(`/api/review/${encodeURIComponent(id)}`, { resolution }),
  config: () => req<{ path: string; raw: Record<string, unknown> }>("/api/config"),
  saveConfig: (patch: Record<string, unknown>) => post<{ path: string; raw: Record<string, unknown> }>("/api/config", patch),
  /** 账号密码走表单：服务端 readBody 后按 URLSearchParams 解析。 */
  account: (form: { current: string; username: string; password: string }) =>
    fetch("/api/account", {
      ...MUT,
      method: "POST",
      headers: { ...MUT.headers, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    }).then(async (r) => {
      if (r.ok) return (await r.json()) as { ok: boolean; username: string };
      throw new ApiError(((await r.json()) as { error?: string }).error ?? `${r.status}`, r.status);
    }),
};
