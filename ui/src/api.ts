/** 面板与 /api/* 的唯一接口层。接口形状由 src/ui/server.ts 定义，这里不改动它。 */

/**
 * 看哪个库：`all` = 所有项目合并（默认）、`global` = 全局库、其他值 = 项目 id。
 * 项目 id 是自由字符串，所以这里不是联合类型。
 */
export type Scope = "all" | "global" | (string & {});
export type MemoryState = "active" | "cold" | "archived" | "superseded";
export type MemoryType = "fact" | "preference" | "procedure" | "relation" | "event" | "emotion";

export interface RegistryRow {
  projectId: string;
  dir: string;
  count: number;
  topics: string[];
  recent: string[];
  updatedAt: number;
}

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
  origin: "user" | "agent";
  trust: number;
  metadata: string | null;
  /** 合并视图（scope=all）下才有：这条属于哪个项目。 */
  project?: string;
}

export interface ReviewItem {
  id: string;
  kind: string;
  question: string;
  options: string;
  memoryId: string;
  /** 合并/冲突那类才有：被比的那一条。 */
  otherId: string | null;
  /** 这是哪个项目的待确认（合并视图下靠它知道要不要切过去）。 */
  project?: string;
}

export interface ProjectRow {
  id: string;
  dir: string;
  count: number;
}

export interface Overview {
  /** 服务端认定的当前视图（便于前端确认自己没问错库）。 */
  scope: string;
  /** true = 所有项目合并出来的数字。 */
  isAll: boolean;
  /** 所有项目（磁盘上的库，不只是注册表里登记过的）：选择器和项目过滤用。 */
  projects: ProjectRow[];
  project: {
    file: string;
    count: number;
    byType: Record<string, number>;
    byState: Record<string, number>;
    byScope: Record<string, number>;
    /** user / agent 的条数（§8.5 的来源权重）。 */
    byOrigin: Record<string, number>;
    /** trust < 0.8 的条数：模型所记、还没被用户确认过。 */
    unconfirmed: number;
    /** 主题 + 条数，按条数降序，最多 12 条。 */
    topicCounts: Array<{ topic: string; n: number }>;
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
  registry: RegistryRow[];
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
  /** user = 用户原话；agent = 模型自己说的（注入时带「未经用户确认」标记）。 */
  origin: "user" | "agent";
  /** 可信度 0..1。低于 0.8 的节点在图上带虚线外环。 */
  trust: number;
  /** 合并视图下节点属于哪个项目（null = 全局库）。 */
  project: string | null;
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
