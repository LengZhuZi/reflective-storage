/** 五个视图 + 右侧检视栏。数据全部来自 /api/*，形状见 src/ui/server.ts。 */
import { useEffect, useMemo, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { api, type Dupe, type MemoryNode, type Overview, type ReviewItem, type Scope } from "./api";
import { Button, Chip, Dialog, EmptyState, ErrorNote, Field, KeyHint, Metric, Panel, SearchInput, Skeleton, StateChip, Timeline, TimeCell, TypeChip, toast, useAsync } from "./components";
import { KIND_LABEL, SCOPE_LABEL, STATE_LABEL, TYPE_LABEL, ago, fixed, humanTrace, pct, shortId, stamp } from "./format";

/* ---------------------------------------------------------------- 概览 */

export function OverviewView({ scope, version }: { scope: Scope; version: number }) {
  const { data, error, loading, reload } = useAsync(() => api.overview(scope), [scope, version]);
  if (loading && !data) return <Skeleton rows={6} />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;
  if (!data) return null;
  const o: Overview = data;
  const byState = o.project.byState ?? {};
  const total = o.project.count;
  const active = byState.active ?? 0;

  return (
    <div class="view">
      <div class="view-head">
        <h1>概览</h1>
        <span class="sub dim">
          {scope === "global" ? "全局库" : "项目库"} {total} 条，其中 active {active} 条
        </span>
        <span class="spacer" />
        <Button variant="ghost" icon="refresh" onClick={reload}>
          刷新
        </Button>
      </div>

      <div class="metrics">
        <Metric k="注入命中率" v={o.hitRate == null ? "-" : pct(o.hitRate)} h={o.injectedTotal ? `注入 ${o.injectedTotal} 条，用过 ${o.citedTotal} 条` : "本会话还没注入过"} />
        <Metric k="待确认" v={String(o.pending)} h="合并 / 冲突 / 起主题" />
        <Metric k="近义堆" v={String(o.dupes)} h={`余弦 ≥ ${fixed(o.dupeCosine, 2)}`} />
        <Metric k="路径节点" v={String(o.project.paths)} h="来自 tool call 的文件名" />
        <Metric k="全局库" v={String(o.global.count)} h={o.global.file.split("/").slice(-1)[0]} />
        <Metric text k="判断引擎" v={o.engine.ready ? (o.engine.model ?? "已配置") : "不可用"} h={o.engine.ready ? `${o.engine.provider} · 阈值 ${fixed(o.engine.relevanceThreshold, 2)}` : o.engine.problems[0] ?? ""} />
      </div>

      <Panel title="召回健康度" actions={<span class="dim">最近 {o.recalls.length} 次</span>} flush>
        {o.recalls.length === 0 ? (
          <EmptyState title="还没有召回记录" hint="新会话第一次提问时，判断引擎会决定要不要查记忆，这里记录结果。" />
        ) : (
          <div>
            <div class="recall-row dim" style={{ fontSize: "11.5px" }}>
              <span>提问</span>
              <span style={{ textAlign: "right" }}>候选</span>
              <span style={{ textAlign: "right" }}>注入</span>
              <span style={{ textAlign: "right" }}>用上</span>
            </div>
            {o.recalls.map((r, i) => (
              <div class="recall-row" key={`${r.at}-${i}`}>
                <span class="truncate" title={r.query}>
                  {r.query}
                </span>
                <span class="n">{r.recalled}</span>
                <span class="n">{r.injected}</span>
                <span class="n" style={{ color: r.cited > 0 ? "var(--accent)" : "var(--fg-faint)" }}>
                  {r.cited}
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="最近判断" flush>
        {o.traces.length === 0 ? (
          <EmptyState title="还没有判断轨迹" />
        ) : (
          <div class="panel-body">
            <div class="timeline">
              {o.traces.map((t, i) => (
                <div class="timeline-item" key={`${t.gate}-${i}`}>
                  <div class="gate">
                    {t.gate}
                    <br />
                    <span class="faint">{t.action}</span>
                  </div>
                  <div class="what">
                    <div>{t.userVisible || humanTrace(t.gate, t.action)}</div>
                    {t.reason ? <div class="dim">{t.reason}</div> : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Panel>

      <Panel title="项目注册表" flush>
        {o.registry.length === 0 ? (
          <EmptyState title="还没有别的项目" hint="在别的目录里用一次 pi，它就会登记进来（跨项目召回靠这张表）。" />
        ) : (
          <table class="grid">
            <thead>
              <tr>
                <th>项目</th>
                <th class="hide-sm">目录</th>
                <th style={{ width: "80px", textAlign: "right" }}>记忆</th>
                <th style={{ width: "110px" }}>更新</th>
              </tr>
            </thead>
            <tbody>
              {o.registry.map((p) => (
                <tr key={p.project_id} style={{ cursor: "default" }}>
                  <td>{p.project_id}</td>
                  <td class="hide-sm mono truncate" title={p.dir}>
                    {p.dir}
                  </td>
                  <td class="num">{p.memory_count}</td>
                  <td>
                    <TimeCell at={p.updated_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="引擎与文件">
        <dl class="meta-grid">
          <dt>项目库</dt>
          <dd class="mono truncate" title={o.project.file}>
            {o.project.file}
          </dd>
          <dt>全局库</dt>
          <dd class="mono truncate" title={o.global.file}>
            {o.global.file}
          </dd>
          <dt>端点</dt>
          <dd class="mono">{o.engine.baseUrl ?? "-"}</dd>
          <dt>模型</dt>
          <dd class="mono">{o.engine.model ?? "-"}</dd>
          {o.engine.problems.length > 0 ? (
            <>
              <dt>配置问题</dt>
              <dd>
                {o.engine.problems.map((p) => (
                  <div key={p} class="dim">
                    {p}
                  </div>
                ))}
              </dd>
            </>
          ) : null}
        </dl>
      </Panel>
    </div>
  );
}

/* ---------------------------------------------------------------- 记忆 */

export function MemoriesView({ scope, version, query, onQuery, selected, onSelect }: { scope: Scope; version: number; query: string; onQuery: (v: string) => void; selected: string | null; onSelect: (id: string | null) => void }) {
  const [state, setState] = useState("");
  const [type, setType] = useState("");
  const [topic, setTopic] = useState("");
  const { data, error, loading, reload } = useAsync(() => api.memories(scope, { state, topic }), [scope, state, topic, version]);

  const items = useMemo(() => {
    const all = data?.items ?? [];
    const q = query.trim().toLowerCase();
    return all.filter((m) => (!type || m.type === type) && (!q || m.content.toLowerCase().includes(q) || m.id.startsWith(q) || (m.topic ?? "").toLowerCase().includes(q)));
  }, [data, type, query]);

  useEffect(() => {
    // j / k 在列表里上下走，Enter 打开（键盘优先）
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /input|textarea|select/i.test(target.tagName)) return;
      if (e.key !== "j" && e.key !== "k") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const i = items.findIndex((m) => m.id === selected);
      e.preventDefault();
      const next = e.key === "j" ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
      const pick = items[next < 0 ? 0 : next];
      if (pick) onSelect(pick.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, selected, onSelect]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of data?.items ?? []) map.set(m.type, (map.get(m.type) ?? 0) + 1);
    return map;
  }, [data]);

  return (
    <div class="view">
      <div class="view-head">
        <h1>记忆</h1>
        <span class="sub dim">
          共 {data?.items.length ?? 0} 条，筛出 {items.length} 条
        </span>
        <span class="spacer" />
        <KeyHint keys={["J", "K"]} />
        <span class="dim">切换</span>
      </div>

      <div class="toolbar">
        <SearchInput value={query} onInput={onQuery} placeholder="按内容 / id / 主题过滤" />
        <select class="select" value={state} onChange={(e) => setState((e.currentTarget as HTMLSelectElement).value)} aria-label="状态">
          <option value="">全部状态</option>
          {["active", "cold", "archived", "superseded"].map((s) => (
            <option key={s} value={s}>
              {STATE_LABEL[s] ?? s}
            </option>
          ))}
        </select>
        <select class="select" value={type} onChange={(e) => setType((e.currentTarget as HTMLSelectElement).value)} aria-label="类型">
          <option value="">全部类型</option>
          {Object.keys(TYPE_LABEL).map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}{counts.get(t) ? ` (${counts.get(t)})` : ""}
            </option>
          ))}
        </select>
        <select class="select" value={topic} onChange={(e) => setTopic((e.currentTarget as HTMLSelectElement).value)} aria-label="主题">
          <option value="">全部主题</option>
          {(data?.topics ?? []).map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <span class="spacer" />
        <Button variant="ghost" icon="refresh" onClick={reload}>
          刷新
        </Button>
      </div>

      <div class="panel">
        {loading && !data ? (
          <Skeleton rows={8} />
        ) : error ? (
          <ErrorNote error={error} onRetry={reload} />
        ) : items.length === 0 ? (
          <EmptyState
            title={query || state || type || topic ? "没有符合条件的记忆" : "这个库里还没有记忆"}
            hint={
              query || state || type || topic ? (
                "换个筛选条件，或者清空搜索框。"
              ) : (
                <>
                  写入是自动的：跟 pi 说一句持久的约定就行。
                  <br />
                  <code>pi -p &quot;以后这个项目的测试统一跑 node tests/smoke.ts&quot;</code>
                </>
              )
            }
          />
        ) : (
          <table class="grid">
            <thead>
              <tr>
                <th style={{ width: "104px" }}>状态</th>
                <th style={{ width: "72px" }} class="hide-sm">
                  类型
                </th>
                <th>内容</th>
                <th style={{ width: "120px" }} class="hide-sm">
                  主题
                </th>
                <th style={{ width: "64px", textAlign: "right" }}>重要度</th>
                <th style={{ width: "96px" }}>写入</th>
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.id} tabindex={0} aria-selected={selected === m.id} onClick={() => onSelect(m.id)}>
                  <td>
                    <StateChip state={m.state} />
                    {m.scope !== "project" ? <Chip title={m.scopeId ?? ""}>{SCOPE_LABEL[m.scope] ?? m.scope}</Chip> : null}
                  </td>
                  <td class="hide-sm">
                    <TypeChip type={m.type} />
                  </td>
                  <td class="cell-content truncate" title={m.content}>
                    {m.content}
                  </td>
                  <td class="hide-sm truncate dim">{m.topic ?? "-"}</td>
                  <td class="num">{fixed(m.importance, 2)}</td>
                  <td>
                    <TimeCell at={m.createdAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 待确认 */

export function PendingView({ scope, version, onChanged, onOpenMemory }: { scope: Scope; version: number; onChanged: () => void; onOpenMemory: (id: string) => void }) {
  const { data, error, loading, reload } = useAsync(() => api.memories(scope), [scope, version]);
  const [busy, setBusy] = useState(false);
  const items: ReviewItem[] = data?.pending ?? [];
  const current = items[0];

  const resolve = async (resolution: string) => {
    if (!current || busy) return;
    setBusy(true);
    try {
      const r = await api.resolveReview(current.id, resolution);
      toast(r.result ? `已处理：${r.result}` : "已处理");
      reload();
      onChanged();
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  const options: string[] = current ? (JSON.parse(current.options) as string[]) : [];
  const isTopic = current?.kind === "topic";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > options.length) return;
      const target = e.target as HTMLElement | null;
      if (target && /input|textarea|select/i.test(target.tagName)) return;
      void resolve(options[n - 1]!);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div class="view">
      <div class="view-head">
        <h1>待确认</h1>
        <span class="sub dim">{items.length > 0 ? `还有 ${items.length} 条等你拍` : "队列是空的"}</span>
        <span class="spacer" />
        <span class="dim">
          按 <KeyHint keys={["1"]} /> 到 <KeyHint keys={["9"]} /> 直接选
        </span>
        <Button variant="ghost" icon="refresh" onClick={reload}>
          刷新
        </Button>
      </div>

      {error ? (
        <ErrorNote error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Skeleton rows={4} />
      ) : !current ? (
        <Panel>
          <EmptyState title="没有待确认的事" hint="判不准的（合并、冲突、起主题、要不要放宽到全局）会排在这里，不会替你拍。" />
        </Panel>
      ) : (
        <>
          <div class="progress" style={{ marginBottom: "12px" }}>
            <i style={{ width: `${(1 / items.length) * 100}%` }} />
          </div>
          <Panel title={`${current.kind === "merge" ? "合并" : current.kind === "conflict" ? "冲突" : current.kind === "scope" ? "作用域" : "起主题"} · 第 1 / ${items.length} 条`}>
            <div class="review-card">
              <div class="review-q">{current.question}</div>
              {isTopic ? (
                <TopicForm busy={busy} onSubmit={resolve} />
              ) : (
                <div class="review-options">
                  {options.map((o, i) => (
                    <button key={o} type="button" class="review-option" disabled={busy} onClick={() => void resolve(o)}>
                      <span class="idx">{i + 1}</span>
                      <span>{o}</span>
                    </button>
                  ))}
                </div>
              )}
              <div class="toolbar" style={{ marginTop: "12px", marginBottom: 0 }}>
                {current.kind === "merge" || current.kind === "conflict" ? (
                  <>
                    <Button variant="ghost" onClick={() => onOpenMemory(current.memoryId)}>
                      看新记的这条
                    </Button>
                    {current.otherId ? (
                      <Button variant="ghost" onClick={() => onOpenMemory(current.otherId!)}>
                        看已有的那条
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <Button variant="ghost" onClick={() => onOpenMemory(current.memoryId)}>
                    看这条原文
                  </Button>
                )}
                <span class="spacer" />
                <Button variant="ghost" onClick={() => void resolve("")} disabled={busy}>
                  先放着（跳过）
                </Button>
              </div>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

function TopicForm({ busy, onSubmit }: { busy: boolean; onSubmit: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <div class="review-options">
      <Field label="主题名" hint="引擎不许自己造词，名字由你起；起过之后同名主题会参与召回。">
        <input
          class="input"
          value={name}
          placeholder="例如：提交流程"
          onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && onSubmit(name.trim())}
        />
      </Field>
      <div style={{ display: "flex", gap: "8px" }}>
        <Button variant="primary" disabled={busy || !name.trim()} onClick={() => onSubmit(name.trim())}>
          用这个名字
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => onSubmit("先不起主题")}>
          先不起
        </Button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 近义堆 */

export function DupesView({ scope, version, onOpenMemory, onChanged }: { scope: Scope; version: number; onOpenMemory: (id: string) => void; onChanged: () => void }) {
  const { data, error, loading, reload } = useAsync(() => api.dupes(scope), [scope, version]);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const merge = async (keep: string, drop: string) => {
    setBusy(true);
    try {
      await api.merge(keep, drop);
      toast("已合并（旧原文留在 metadata 里，可查）");
      reload();
      onChanged();
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  const pairs: Dupe[] = (data?.items ?? []).filter((d) => !skipped.has(`${d.a}-${d.b}`));

  return (
    <div class="view">
      <div class="view-head">
        <h1>近义堆</h1>
        <span class="sub dim">
          余弦 ≥ {fixed(data?.threshold ?? 0.85, 2)} 的两两组合，{pairs.length} 堆
        </span>
        <span class="spacer" />
        <Button variant="ghost" icon="refresh" onClick={reload}>
          刷新
        </Button>
      </div>

      {loading && !data ? (
        <Skeleton rows={6} />
      ) : error ? (
        <ErrorNote error={error} onRetry={reload} />
      ) : pairs.length === 0 ? (
        <Panel>
          <EmptyState title="没有近义堆" hint="向量层是弱过滤器：这里只是把很像的两条摆出来给你看，合并与否由你决定。" />
        </Panel>
      ) : (
        pairs.map((d) => (
          <Panel
            key={`${d.a}-${d.b}`}
            title={`相似度 ${(d.sim * 100).toFixed(1)}%`}
            actions={
              <>
                <span class="mono faint">{shortId(d.a)}</span>
                <span class="dim">↔</span>
                <span class="mono faint">{shortId(d.b)}</span>
              </>
            }
            flush
          >
            <div class="dupe">
              {[
                { id: d.a, text: d.aText },
                { id: d.b, text: d.bText },
              ].map((side) => (
                <div class="dupe-side" key={side.id}>
                  <div class="dupe-sim faint" style={{ marginBottom: "6px" }}>
                    {shortId(side.id)}
                  </div>
                  <div class="wrap">{side.text}</div>
                </div>
              ))}
            </div>
            <div class="dupe-actions">
              <Button variant="primary" disabled={busy} onClick={() => void merge(d.a, d.b)}>
                合并，保留左边原文
              </Button>
              <Button disabled={busy} onClick={() => void merge(d.b, d.a)}>
                合并，保留右边原文
              </Button>
              <Button variant="ghost" onClick={() => onOpenMemory(d.a)}>
                看左边
              </Button>
              <span class="spacer" />
              <Button variant="ghost" onClick={() => setSkipped((s) => new Set(s).add(`${d.a}-${d.b}`))}>
                这堆先放着
              </Button>
            </div>
          </Panel>
        ))
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- 设置 */

interface RawConfig {
  typesafe?: { apiKey?: string; apiKeySet?: number; baseUrl?: string; model?: string; timeoutMs?: number };
  judge?: { provider?: string; model?: string; relevanceThreshold?: number };
  proxy?: { http?: string };
  inject?: { maxPerSession?: number; minTurnsBetween?: number };
  recall?: { perSourceLimit?: number; weights?: Record<string, number> };
  lifecycle?: { autoCleanup?: boolean; sessionTtlDays?: number };
  proactive?: { enabled?: boolean; maxPerSession?: number };
  ui?: { port?: number };
}

export function SettingsView({ user, onSaved }: { user: string; onSaved: () => void }) {
  const { data, error, loading, reload } = useAsync(() => api.config(), []);
  const cfgPath = data?.path ?? "";
  const [draft, setDraft] = useState<RawConfig | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data) {
      setDraft(JSON.parse(JSON.stringify(data.raw)) as RawConfig);
      setDirty(false);
    }
  }, [data]);

  const patch = (fn: (c: RawConfig) => void) => {
    if (!draft) return;
    const next = JSON.parse(JSON.stringify(draft)) as RawConfig;
    fn(next);
    setDraft(next);
    setDirty(true);
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = JSON.parse(JSON.stringify(draft));
      if (apiKey.trim()) (body.typesafe as Record<string, unknown>).apiKey = apiKey.trim();
      await api.saveConfig(body);
      setApiKey("");
      toast("已写入 config.json（权限 600）。判断引擎和端口要重启 pi 才生效");
      reload();
      onSaved();
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  if (loading && !draft) return <Skeleton rows={8} />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;
  if (!draft) return null;

  return (
    <div class="view">
      <div class="view-head">
        <h1>设置</h1>
        <span class="sub dim">{dirty ? "有改动没保存" : "已同步"}</span>
        <span class="spacer" />
        <span class="dim mono truncate" title={cfgPath}>
          {cfgPath}
        </span>
        <Button variant="primary" onClick={() => void save()} disabled={busy || !dirty}>
          保存
        </Button>
      </div>

      <fieldset class="fieldset">
        <legend>判断引擎（硬要求，没有它扩展不启动）</legend>
        <Field label="API key" hint={draft.typesafe?.apiKeySet ? `已配置，长度 ${draft.typesafe.apiKeySet}；只写不读，留空就是不改` : "没配。环境变量 TYPESAFE_API_KEY 优先于这里"}>
          <input class="input" type="password" value={apiKey} placeholder={draft.typesafe?.apiKeySet ? "留空 = 不改" : "apikey_..."} onInput={(e) => setApiKey((e.currentTarget as HTMLInputElement).value)} autocomplete="off" />
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: "10px" }}>
          <Field label="端点 baseUrl">
            <input class="input" value={draft.typesafe?.baseUrl ?? ""} onInput={(e) => patch((c) => void (c.typesafe = { ...c.typesafe, baseUrl: (e.currentTarget as HTMLInputElement).value }))} />
          </Field>
          <Field label="模型">
            <input class="input" value={draft.typesafe?.model ?? ""} onInput={(e) => patch((c) => void (c.typesafe = { ...c.typesafe, model: (e.currentTarget as HTMLInputElement).value }))} />
          </Field>
          <Field label="交互超时 (ms)" hint="召回路径宁可不注入也不拖住用户">
            <input class="input mono" type="number" value={draft.typesafe?.timeoutMs ?? ""} onInput={(e) => patch((c) => void (c.typesafe = { ...c.typesafe, timeoutMs: Number((e.currentTarget as HTMLInputElement).value) || undefined }))} />
          </Field>
          <Field label="相关性阈值">
            <input class="input mono" type="number" step="0.05" value={draft.judge?.relevanceThreshold ?? ""} onInput={(e) => patch((c) => void (c.judge = { ...c.judge, relevanceThreshold: Number((e.currentTarget as HTMLInputElement).value) || undefined }))} />
          </Field>
          <Field label="代理 http" hint="改完要重启 pi，并且启动前设 NODE_USE_ENV_PROXY=1">
            <input class="input" value={draft.proxy?.http ?? ""} onInput={(e) => patch((c) => void (c.proxy = { ...c.proxy, http: (e.currentTarget as HTMLInputElement).value }))} />
          </Field>
        </div>
      </fieldset>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: "14px" }}>
        <fieldset class="fieldset">
          <legend>注入</legend>
          <Field label="每会话最多注入次数">
            <input class="input mono" type="number" value={draft.inject?.maxPerSession ?? ""} onInput={(e) => patch((c) => void (c.inject = { ...c.inject, maxPerSession: Number((e.currentTarget as HTMLInputElement).value) || undefined }))} />
          </Field>
          <Field label="两次注入至少间隔几轮">
            <input class="input mono" type="number" value={draft.inject?.minTurnsBetween ?? ""} onInput={(e) => patch((c) => void (c.inject = { ...c.inject, minTurnsBetween: Number((e.currentTarget as HTMLInputElement).value) || undefined }))} />
          </Field>
        </fieldset>

        <fieldset class="fieldset">
          <legend>召回</legend>
          <Field label="每路候选上限">
            <input class="input mono" type="number" value={draft.recall?.perSourceLimit ?? ""} onInput={(e) => patch((c) => void (c.recall = { ...c.recall, perSourceLimit: Number((e.currentTarget as HTMLInputElement).value) || undefined }))} />
          </Field>
          {Object.keys(draft.recall?.weights ?? { relevance: 0, vector: 0, topic: 0, importance: 0, recency: 0 }).map((k) => (
            <Field key={k} label={`权重 ${k}`}>
              <input
                class="input mono"
                type="number"
                step="0.05"
                value={draft.recall?.weights?.[k] ?? ""}
                onInput={(e) =>
                  patch((c) => {
                    c.recall = { ...c.recall, weights: { ...(c.recall?.weights ?? {}), [k]: Number((e.currentTarget as HTMLInputElement).value) || 0 } };
                  })
                }
              />
            </Field>
          ))}
        </fieldset>

        <fieldset class="fieldset">
          <legend>生命周期与主动提醒</legend>
          <Field label="session 记忆自动清理（不可逆）" hint="默认关。打开后按天数销毁 session 记忆，找不回来">
            <select class="select" value={String(draft.lifecycle?.autoCleanup ?? false)} onChange={(e) => patch((c) => void (c.lifecycle = { ...c.lifecycle, autoCleanup: (e.currentTarget as HTMLSelectElement).value === "true" }))}>
              <option value="false">关闭</option>
              <option value="true">打开</option>
            </select>
          </Field>
          <Field label="session 保留天数">
            <input class="input mono" type="number" value={draft.lifecycle?.sessionTtlDays ?? ""} onInput={(e) => patch((c) => void (c.lifecycle = { ...c.lifecycle, sessionTtlDays: Number((e.currentTarget as HTMLInputElement).value) || undefined }))} />
          </Field>
          <Field label="主动提醒">
            <select class="select" value={String(draft.proactive?.enabled ?? true)} onChange={(e) => patch((c) => void (c.proactive = { ...c.proactive, enabled: (e.currentTarget as HTMLSelectElement).value === "true" }))}>
              <option value="true">开</option>
              <option value="false">关</option>
            </select>
          </Field>
          <Field label="每会话最多提醒次数">
            <input class="input mono" type="number" value={draft.proactive?.maxPerSession ?? ""} onInput={(e) => patch((c) => void (c.proactive = { ...c.proactive, maxPerSession: Number((e.currentTarget as HTMLInputElement).value) || undefined }))} />
          </Field>
        </fieldset>

        <fieldset class="fieldset">
          <legend>面板与账号</legend>
          <Field label="面板端口" hint="0 = 系统挑。改完重启 pi 生效">
            <input class="input mono" type="number" value={draft.ui?.port ?? 0} onInput={(e) => patch((c) => void (c.ui = { port: Number((e.currentTarget as HTMLInputElement).value) || 0 }))} />
          </Field>
          <AccountForm user={user} />
        </fieldset>
      </div>
    </div>
  );
}

function AccountForm({ user }: { user: string }) {
  const [current, setCurrent] = useState("");
  const [name, setName] = useState(user);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <Field label="当前密码">
        <input class="input" type="password" value={current} onInput={(e) => setCurrent((e.currentTarget as HTMLInputElement).value)} autocomplete="current-password" />
      </Field>
      <Field label="账号名">
        <input class="input" value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
      </Field>
      <Field label="新密码" hint="至少 8 位；改完要重新登录">
        <input class="input" type="password" value={password} onInput={(e) => setPassword((e.currentTarget as HTMLInputElement).value)} autocomplete="new-password" />
      </Field>
      <Button
        disabled={busy || !current || password.length < 8}
        onClick={async () => {
          setBusy(true);
          try {
            await api.account({ current, username: name, password });
            toast("账号已更新，请重新登录");
            setCurrent("");
            setPassword("");
          } catch (e) {
            toast((e as Error).message, "bad");
          } finally {
            setBusy(false);
          }
        }}
      >
        改账号密码
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------- 检视栏 */

export function Inspector({ scope, id, version, onClose, onChanged }: { scope: Scope; id: string; version: number; onClose: () => void; onChanged: () => void }) {
  const { data, error, loading, reload } = useAsync(() => api.detail(scope, id), [scope, id, version]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制");
    } catch {
      toast("复制失败，手动选吧", "bad");
    }
  };

  const remove = async () => {
    try {
      await api.remove(scope, id);
      toast("已删除（不可逆）");
      setConfirmDelete(false);
      onChanged();
      onClose();
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  };

  const m: MemoryNode | undefined = data?.memory;
  const paths = data?.paths ?? [];
  const traces = data?.traces ?? [];
  return (
    <aside class="inspector" aria-label="记忆详情">
      <header class="inspector-head">
        <span class="mono faint">{shortId(id)}</span>
        {m ? <StateChip state={m.state} /> : null}
        <span class="spacer" />
        <Button variant="ghost" size="sm" icon="copy" title="复制 id" onClick={() => void copy(id)} />
        <Button variant="ghost" size="sm" icon="close" title="关闭（Esc）" onClick={onClose} />
      </header>

      {loading && !data ? (
        <Skeleton rows={6} />
      ) : error ? (
        <ErrorNote error={error} onRetry={reload} />
      ) : !m ? null : (
        <>
          <div class="inspector-body">
            <div>
              <div class="content-large wrap">{m.content}</div>
              {m.summary ? <div class="dim" style={{ marginTop: "6px" }}>{m.summary}</div> : null}
            </div>

            <dl class="meta-grid">
              <dt>类型</dt>
              <dd>
                <TypeChip type={m.type} /> <Chip>{SCOPE_LABEL[m.scope] ?? m.scope}</Chip> {m.scopeId ? <span class="mono faint">{m.scopeId}</span> : null}
              </dd>
              <dt>主题</dt>
              <dd>{m.topic ?? <span class="dim">没起主题</span>}</dd>
              <dt>重要度</dt>
              <dd class="mono">
                {fixed(m.importance, 2)} <span class="faint">· 衰减 {fixed(m.decayScore, 2)}</span>
              </dd>
              <dt>访问</dt>
              <dd class="mono">
                {m.accessCount} 次 <span class="faint">· 上次 {ago(m.lastAccessed)}</span>
              </dd>
              <dt>写入</dt>
              <dd class="mono" title={stamp(m.createdAt)}>
                {ago(m.createdAt)}
              </dd>
              <dt>来源</dt>
              <dd class="mono truncate" title={m.source ?? ""}>
                {m.source ? `会话 ${shortId(m.source)}` : "-"}
              </dd>
              {paths.length > 0 ? (
                <>
                  <dt>代码路径</dt>
                  <dd>
                    {paths.map((p) => (
                      <div key={p} class="mono">
                        {p}
                      </div>
                    ))}
                  </dd>
                </>
              ) : null}
            </dl>

            <div>
              <h3 style={{ margin: "0 0 8px", fontSize: "12px", color: "var(--fg-dim)", fontWeight: 500 }}>为什么记住</h3>
              <Timeline items={traces} />
            </div>
          </div>

          <div class="inspector-foot">
            <Button variant="danger" icon="trash" onClick={() => setConfirmDelete(true)}>
              删除
            </Button>
            <span class="spacer" />
            <Button variant="ghost" icon="refresh" onClick={reload}>
              刷新
            </Button>
          </div>

          {confirmDelete ? (
            <Dialog
              title="删除这条记忆？"
              onClose={() => setConfirmDelete(false)}
              actions={
                <>
                  <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                    取消
                  </Button>
                  <Button variant="primary" onClick={() => void remove()}>
                    确认删除
                  </Button>
                </>
              }
            >
              硬删除，删了找不回来（轨迹里会留一条 J12 delete 记录）。
              <div class="quote">{m.content}</div>
            </Dialog>
          ) : null}
        </>
      )}
    </aside>
  );
}

/* ---------------------------------------------------------------- 复核队列的其它入口 */

export function PendingBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return <Chip tone="warn">{count}</Chip>;
}

export function KindChipNode({ kind }: { kind: string }): ComponentChildren {
  return <Chip>{KIND_LABEL[kind] ?? kind}</Chip>;
}
