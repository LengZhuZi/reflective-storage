/** 外壳：命令栏 + 左栏 + 主区 + 检视栏，路由走 hash，键盘优先。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, type MemoryNode, type ProjectRow, type Scope } from "./api";
import { Button, Chip, Dialog, Icon, KeyHint, ToastHost, toast } from "./components";
import { Graph } from "./graph";
import { DupesView, Inspector, MemoriesView, OverviewView, PendingView, SettingsView } from "./views";
import { SCOPE_LABEL, TYPE_LABEL, shortId } from "./format";

type ViewId = "overview" | "graph" | "memories" | "pending" | "dupes" | "settings";

/** 隐藏列表的 localStorage 键，以及全局库在隐藏列表里的占位 id（它没有项目 id）。 */
const HIDDEN_KEY = "rs-hidden-projects";
const GLOBAL_KEY = "__global__";

const VIEWS: Array<{ id: ViewId; label: string; icon: string; key: string }> = [
  { id: "overview", label: "概览", icon: "overview", key: "1" },
  { id: "graph", label: "图谱", icon: "graph", key: "2" },
  { id: "memories", label: "记忆", icon: "list", key: "3" },
  { id: "pending", label: "待确认", icon: "review", key: "4" },
  { id: "dupes", label: "近义堆", icon: "stack", key: "5" },
  { id: "settings", label: "设置", icon: "settings", key: "6" },
];

const fromHash = (): ViewId => {
  const h = location.hash.replace(/^#\/?/, "");
  return (VIEWS.find((v) => v.id === h)?.id ?? "graph") as ViewId;
};

function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const stored = localStorage.getItem("rs-theme");
    if (stored === "dark" || stored === "light") return stored;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("rs-theme", theme);
  }, [theme]);
  return { theme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) };
}

export function App({ user }: { user: string }) {
  const { theme, toggle } = useTheme();
  const [view, setView] = useState<ViewId>(fromHash);
  // 默认看全部：一个页面看到所有项目的图谱，这也是「跨项目」唯一看得见的地方。
  const [scope, setScope] = useState<Scope>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [graphFocus, setGraphFocus] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  /** 隐藏掉的项目（只影响图谱和列表的显示，不动数据）。全局库用 GLOBAL_KEY。 */
  const [hidden, setHidden] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  const [summary, setSummary] = useState<{ count: number; pending: number; dupes: number; engine: string; engineBad: boolean; dbFile: string; topics: string[]; projects: ProjectRow[] } | null>(null);
  const pendingG = useRef<string | null>(null);

  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const toggleHidden = useCallback((id: string) => {
    setHidden((h) => {
      const next = h.includes(id) ? h.filter((x) => x !== id) : [...h, id];
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  /** 项目/全局是否显示。null/undefined 的 project = 全局库。 */
  const visible = useCallback((project: string | null | undefined) => !hidden.includes(project ?? GLOBAL_KEY), [hidden]);

  useEffect(() => {
    const onHash = () => setView(fromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = useCallback((id: ViewId) => {
    location.hash = `#/${id}`;
    setView(id);
  }, []);

  useEffect(() => {
    api
      .overview(scope)
      .then((o) =>
        setSummary({
          count: o.project.count,
          pending: o.pending,
          dupes: o.dupes,
          engine: o.engine.ready ? (o.engine.model ?? "已配置") : "不可用",
          engineBad: !o.engine.ready || o.engine.problems.length > 0,
          dbFile: o.project.file,
          topics: o.topics,
          projects: o.projects ?? [],
        }),
      )
      .catch(() => setSummary(null));
  }, [scope, view, version]);

  // 全局快捷键：⌘K 命令面板、g+数字 切视图、/ 搜索、? 帮助、Esc 关检视栏
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (/input|textarea|select/i.test(t.tagName) || t.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (typing) return;
      if (pendingG.current === "g") {
        pendingG.current = null;
        const hit = VIEWS.find((v) => v.key === e.key);
        if (hit) {
          e.preventDefault();
          go(hit.id);
          return;
        }
      }
      if (e.key === "g") {
        pendingG.current = "g";
        setTimeout(() => (pendingG.current = null), 900);
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        go("memories");
        setTimeout(() => document.querySelector<HTMLInputElement>(".main input[type=search]")?.focus(), 30);
        return;
      }
      if (e.key === "?") {
        setHelpOpen(true);
        return;
      }
      if (e.key === "Escape" && !paletteOpen) setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, paletteOpen]);

  const openMemory = useCallback((id: string) => setSelected(id), []);

  return (
    <div class={`shell ${railCollapsed ? "rail-collapsed" : ""}`}>
      <header class="topbar">
        <span class="brand">
          <Icon name="stack" size={16} />
          <span>反思存储</span>
        </span>
        <select class="select" value={scope} onChange={(e) => { setScope((e.currentTarget as HTMLSelectElement).value as Scope); setSelected(null); setGraphFocus(null); }} aria-label="看哪个库">
          <option value="all">全部项目</option>
          <option value="global">全局库</option>
          {(summary?.projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.id}（{p.count}）
            </option>
          ))}
        </select>
        {scope === "all" ? (
          <Button variant="ghost" size="sm" icon="stack" title="隐藏不看的项目（只影响图谱和列表的显示）" onClick={() => setFilterOpen(true)}>
            {hidden.length ? `已隐藏 ${hidden.length}` : "项目过滤"}
          </Button>
        ) : null}
        <span class="dbpath truncate" title={summary?.dbFile ?? ""}>
          {summary?.dbFile ?? ""}
        </span>
        <span class="spacer" />
        <button class="cmdk" type="button" onClick={() => setPaletteOpen(true)}>
          <Icon name="search" size={14} />
          <span>搜索记忆 / 跳转</span>
          <span class="spacer" />
          <kbd>⌘K</kbd>
        </button>
        <span class="spacer" />
        <span class="topright">
          {summary?.engineBad ? (
            <Chip tone="warn" title="判断引擎有问题，设置页能看详情">
              {summary.engine}
            </Chip>
          ) : (
            <Chip tone="accent" title="判断引擎正常">
              {summary?.engine ?? "-"}
            </Chip>
          )}
          <Button variant="ghost" size="sm" icon={theme === "dark" ? "sun" : "moon"} title="切换明暗" onClick={toggle} />
          <span class="dim mono" title="当前账号">
            {user}
          </span>
          <form method="post" action="/api/logout" style={{ display: "inline" }}>
            <Button variant="ghost" size="sm" type="submit">
              退出
            </Button>
          </form>
        </span>
      </header>

      <nav class="rail" aria-label="主导航">
        <div style={{ padding: "8px 6px 0" }}>
          <nav>
            {VIEWS.map((v) => (
              <button key={v.id} class="navitem" aria-current={view === v.id ? "page" : undefined} onClick={() => go(v.id)} title={`${v.label}（g ${v.key}）`}>
                <Icon name={v.icon} />
                <span class="label">{v.label}</span>
                {v.id === "memories" && summary ? <span class="n">{summary.count}</span> : null}
                {v.id === "pending" && summary?.pending ? <span class="n" style={{ color: "var(--warn)" }}>{summary.pending}</span> : null}
                {v.id === "dupes" && summary?.dupes ? <span class="n">{summary.dupes}</span> : null}
              </button>
            ))}
          </nav>
        </div>
        <div class="rail-section">主题</div>
        <div class="rail-topics">
          {(summary?.topics ?? []).length === 0 ? (
            <div class="dim" style={{ padding: "4px 8px", fontSize: "12px" }}>
              还没有主题。复核队列里给记忆起个名字就有了。
            </div>
          ) : (
            (summary?.topics ?? []).map((t) => (
              <button
                key={t}
                class="navitem"
                onClick={() => {
                  setQuery(t);
                  go("memories");
                }}
              >
                <Icon name="chevron" size={12} />
                <span class="label truncate">{t}</span>
              </button>
            ))
          )}
        </div>
        <button class="railtoggle" type="button" onClick={() => setRailCollapsed((v) => !v)} title="折叠左栏">
          <Icon name={railCollapsed ? "chevron" : "close"} size={14} />
          <span class="label">折叠</span>
        </button>
      </nav>

      <main class="main">
        {view === "overview" ? <OverviewView scope={scope} version={version} /> : null}
        {view === "graph" ? (
          <GraphSection scope={scope} version={version} selected={selected} onSelect={setSelected} focus={graphFocus} onFocus={setGraphFocus} onOpen={openMemory} visible={visible} />
        ) : null}
        {view === "memories" ? <MemoriesView scope={scope} version={version} query={query} onQuery={setQuery} selected={selected} onSelect={setSelected} visible={visible} /> : null}
        {view === "pending" ? <PendingView scope={scope} version={version} onChanged={bump} onOpenMemory={openMemory} /> : null}
        {view === "dupes" ? <DupesView scope={scope} version={version} onOpenMemory={openMemory} onChanged={bump} /> : null}
        {view === "settings" ? <SettingsView user={user} onSaved={bump} /> : null}
      </main>

      {selected ? <Inspector scope={scope} id={selected} version={version} onClose={() => setSelected(null)} onChanged={bump} /> : null}

      {paletteOpen ? (
        <Palette
          scope={scope}
          onClose={() => setPaletteOpen(false)}
          onPickView={(v) => {
            go(v);
            setPaletteOpen(false);
          }}
          onPickMemory={(id) => {
            setSelected(id);
            setGraphFocus(id);
            go("graph");
            setPaletteOpen(false);
          }}
        />
      ) : null}

      {filterOpen ? (
        <Dialog
          title="项目过滤"
          onClose={() => setFilterOpen(false)}
          actions={<Button onClick={() => setFilterOpen(false)}>知道了</Button>}
        >
          <p class="dim" style={{ margin: "0 0 10px", fontSize: "12px" }}>
            取消勾选 = 从合并图谱和列表里藏起来（数据不动，改回来就又能看见）。
          </p>
          <label class="filterrow">
            <input type="checkbox" checked={!hidden.includes(GLOBAL_KEY)} onChange={() => toggleHidden(GLOBAL_KEY)} />
            <span>全局库</span>
          </label>
          {(summary?.projects ?? []).map((p) => (
            <label key={p.id} class="filterrow">
              <input type="checkbox" checked={!hidden.includes(p.id)} onChange={() => toggleHidden(p.id)} />
              <span class="mono">{p.id}</span>
              <span class="dim truncate" title={p.dir}>
                {p.dir}
              </span>
              <span class="dim">{p.count}</span>
            </label>
          ))}
          {(summary?.projects ?? []).length === 0 ? <p class="dim">还没有别的项目登记进来。</p> : null}
        </Dialog>
      ) : null}

      {helpOpen ? (
        <Dialog title="快捷键" onClose={() => setHelpOpen(false)} actions={<Button onClick={() => setHelpOpen(false)}>知道了</Button>}>
          <dl class="meta-grid">
            <dt>
              <KeyHint keys={["⌘K"]} />
            </dt>
            <dd>命令面板：搜记忆、跳视图</dd>
            <dt>
              <KeyHint keys={["g", "1-6"]} />
            </dt>
            <dd>切视图（概览 / 图谱 / 记忆 / 待确认 / 近义堆 / 设置）</dd>
            <dt>
              <KeyHint keys={["/"]} />
            </dt>
            <dd>跳到记忆列表并聚焦搜索</dd>
            <dt>
              <KeyHint keys={["J", "K"]} />
            </dt>
            <dd>列表里上下移动，选中即打开右侧详情</dd>
            <dt>
              <KeyHint keys={["1-9"]} />
            </dt>
            <dd>待确认视图里直接选第 n 个选项</dd>
            <dt>
              <KeyHint keys={["方向键"]} />
            </dt>
            <dd>图谱里按方向挑节点，<KeyHint keys={["Shift"]} /> + 方向 = 换焦点</dd>
            <dt>
              <KeyHint keys={["F"]} />
            </dt>
            <dd>图谱适配窗口</dd>
            <dt>
              <KeyHint keys={["Esc"]} />
            </dt>
            <dd>关详情；图谱里先回到全库概览</dd>
          </dl>
        </Dialog>
      ) : null}

      <ToastHost />
    </div>
  );
}

function GraphSection(props: { scope: Scope; version: number; selected: string | null; onSelect: (id: string | null) => void; focus: string | null; onFocus: (id: string | null) => void; onOpen: (id: string) => void; visible: (project: string | null | undefined) => boolean }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.graph>> | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .graph(props.scope)
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e: Error) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [props.scope, props.version]);

  // 隐藏的项目在客户端过滤：合并图谱里把它们藏起来，比让用户重新选库快。
  const shown = useMemo(() => {
    if (!data) return null;
    const nodes = data.nodes.filter((n) => props.visible(n.project));
    const keep = new Set(nodes.map((n) => n.id));
    return { nodes, links: data.links.filter((l) => keep.has(l.source) && keep.has(l.target)) };
  }, [data, props.visible]);

  return (
    <div class="view">
      <div class="view-head">
        <h1>图谱</h1>
        <span class="sub dim">
          {shown ? `${shown.nodes.length} 个节点 · ${shown.links.length} 条关系` : "加载中"}
          {data && shown && shown.nodes.length !== data.nodes.length ? `（隐藏了 ${data.nodes.length - shown.nodes.length} 个）` : ""}
        </span>
        <span class="sub dim">{SCOPE_LABEL[props.scope] ?? props.scope}</span>
      </div>
      {error ? (
        <div class="panel">
          <div class="empty">
            <h3>读不到图谱数据</h3>
            <p class="mono">{error.message}</p>
          </div>
        </div>
      ) : shown ? (
        <Graph data={shown} selected={props.selected} onSelect={props.onSelect} focus={props.focus} onFocus={props.onFocus} onOpen={props.onOpen} />
      ) : (
        <div class="graph">
          <div class="skeleton" style={{ height: "100%", margin: "12px" }} />
        </div>
      )}
    </div>
  );
}

function Palette({ scope, onClose, onPickView, onPickMemory }: { scope: Scope; onClose: () => void; onPickView: (v: ViewId) => void; onPickMemory: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<MemoryNode[]>([]);
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .memories(scope)
      .then((r) => setItems(r.items))
      .catch(() => toast("读不到记忆列表", "bad"));
  }, [scope]);

  const views = VIEWS.filter((v) => !q || v.label.includes(q) || v.id.includes(q));
  const memories = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle ? items.filter((m) => m.content.toLowerCase().includes(needle) || m.id.startsWith(needle)) : items.slice(0, 8);
    return list.slice(0, 20);
  }, [items, q]);

  type Row = { key: string; label: string; hint: string; run: () => void };
  const rows: Row[] = [
    ...views.map((v) => ({ key: `v-${v.id}`, label: v.label, hint: `视图 · g ${v.key}`, run: () => onPickView(v.id) })),
    ...memories.map((m) => ({
      key: `m-${m.id}`,
      label: m.content.slice(0, 80),
      hint: `${TYPE_LABEL[m.type] ?? m.type} · ${shortId(m.id)}`,
      run: () => onPickMemory(m.id),
    })),
  ];

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => setIdx(0), [q]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(rows.length - 1, i + 1));
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(0, i - 1));
    }
    if (e.key === "Enter") {
      e.preventDefault();
      rows[idx]?.run();
    }
  };

  return (
    <div class="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <input ref={inputRef} value={q} placeholder={`搜索记忆（${SCOPE_LABEL[scope] ?? scope}）/ 跳视图…`} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} onKeyDown={onKey} />
        <div class="palette-list">
          {rows.length === 0 ? <div class="dim" style={{ padding: "10px" }}>没有匹配项。</div> : null}
          {rows.map((r, i) => (
            <button key={r.key} class="palette-item" aria-selected={i === idx} onMouseEnter={() => setIdx(i)} onClick={r.run}>
              <span class="truncate">{r.label}</span>
              <span class="kind">{r.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
