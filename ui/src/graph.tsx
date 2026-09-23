/**
 * 图谱：围绕一个节点看它的邻居，而不是全库力导向毛球。
 *
 * 布局是**确定性**的（同一份数据两次打开位置一致）：焦点居中、1 跳内环、2 跳外环，
 * 同主题/同类型的邻居在角度上聚簇；没有焦点时按主题分簇摆一圈。
 * 这样图面能读，也省掉一个模拟循环。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { GraphData, GraphLink, GraphNode } from "./api";
import { Button, Chip, EmptyState, KeyHint, SearchInput } from "./components";
import { KIND_LABEL, STATE_LABEL, TYPE_LABEL, shortId } from "./format";

const EDGE_STYLE: Record<string, { dash?: string; tone: string; label: string }> = {
  supersedes: { dash: "5 3", tone: "var(--bad)", label: "取代" },
  contradicts: { dash: "5 3", tone: "var(--warn)", label: "冲突" },
  extends: { dash: "1 3", tone: "var(--edge)", label: "延伸" },
  related: { dash: "1 3", tone: "var(--edge)", label: "相关" },
  topic: { tone: "var(--edge)", label: "同主题" },
  path: { dash: "2 4", tone: "var(--edge)", label: "同路径" },
  similar: { tone: "var(--edge-dim)", label: "相似" },
};

const RAIL_EDGE_ORDER = ["supersedes", "contradicts", "topic", "path", "similar", "related", "extends"];

interface Pt {
  x: number;
  y: number;
}

/** 主题决定角度分区，保证同主题的邻居聚在一起，且两次打开角度一致。 */
function clusterAngle(key: string | null, keys: string[]): number {
  const i = Math.max(0, keys.indexOf(key ?? ""));
  return (i / Math.max(1, keys.length)) * Math.PI * 2;
}

function hashJitter(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 1000;
  return (h / 1000 - 0.5) * 14;
}

export function layoutGraph(data: GraphData, focusId: string | null, visible: GraphNode[]): { pos: Map<string, Pt>; neighborhood: Set<string> } {
  const pos = new Map<string, Pt>();
  /** 焦点邻域（焦点 + 1/2 跳）。没有焦点时等于全部可见节点（不做压暗）。 */
  const neighborhood = new Set<string>();
  const visibleIds = new Set(visible.map((n) => n.id));
  const links = data.links.filter((l) => visibleIds.has(l.source) && visibleIds.has(l.target));
  const focus = focusId && visibleIds.has(focusId) ? data.nodes.find((n) => n.id === focusId) ?? null : null;

  if (!focus) {
    // 全库概览：按主题分簇，每簇一个小圆，簇心均匀分布在一个大圆上
    const groups = new Map<string, GraphNode[]>();
    for (const n of visible) {
      const key = n.topic ?? n.type;
      groups.set(key, [...(groups.get(key) ?? []), n]);
    }
    const keys = [...groups.keys()].sort((a, b) => (groups.get(b)!.length - groups.get(a)!.length) || a.localeCompare(b));
    keys.forEach((key, gi) => {
      const members = groups.get(key)!.slice().sort((a, b) => b.importance - a.importance || a.id.localeCompare(b.id));
      const angle = clusterAngle(key, keys);
      const clusterR = 150 + Math.min(180, keys.length * 6) + gi * 6;
      const cx = Math.cos(angle) * clusterR;
      const cy = Math.sin(angle) * clusterR;
      const inner = 14 + Math.sqrt(members.length) * 9;
      members.forEach((n, i) => {
        const a = (i / members.length) * Math.PI * 2 + angle;
        const r = members.length === 1 ? 0 : inner;
        pos.set(n.id, { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
      });
    });
    for (const n of visible) neighborhood.add(n.id);
    return { pos, neighborhood };
  }

  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const adj = new Map<string, Set<string>>();
  for (const l of links) {
    (adj.get(l.source) ?? adj.set(l.source, new Set()).get(l.source)!).add(l.target);
    (adj.get(l.target) ?? adj.set(l.target, new Set()).get(l.target)!).add(l.source);
  }
  const sorted = (ids: Iterable<string>) =>
    [...ids].filter((id) => id !== focus.id && visibleIds.has(id)).sort((a, b) => {
      const na = byId.get(a)!;
      const nb = byId.get(b)!;
      return (na.topic ?? "").localeCompare(nb.topic ?? "") || nb.importance - na.importance || a.localeCompare(b);
    });

  const hop1 = sorted(adj.get(focus.id) ?? []);
  const hop1Set = new Set(hop1);
  const hop2 = sorted(new Set([...hop1].flatMap((id) => [...(adj.get(id) ?? [])])).values()).filter((id) => !hop1Set.has(id));
  const placed = new Set([focus.id, ...hop1, ...hop2]);
  for (const id of placed) neighborhood.add(id);
  pos.set(focus.id, { x: 0, y: 0 });

  // 1 跳：角度按主题聚簇，半径按重要度（越重要越靠近焦点）
  const topics = [...new Set(hop1.map((id) => byId.get(id)!.topic ?? byId.get(id)!.type))].sort();
  hop1.forEach((id, i) => {
    const n = byId.get(id)!;
    const base = clusterAngle(n.topic ?? n.type, topics);
    const span = (Math.PI * 2) / Math.max(1, hop1.length);
    const angle = base + (i / hop1.length) * span;
    const r = 120 - n.importance * 26 + hashJitter(id);
    pos.set(id, { x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  });

  // 2 跳：挂在它连着的那个 1 跳邻居外侧
  const parentOf = new Map<string, string>();
  for (const id of hop2) {
    const p = [...(adj.get(id) ?? [])].find((x) => hop1Set.has(x));
    if (p) parentOf.set(id, p);
  }
  const byParent = new Map<string, string[]>();
  for (const [id, p] of parentOf) byParent.set(p, [...(byParent.get(p) ?? []), id]);
  for (const [parent, kids] of byParent) {
    const base = pos.get(parent)!;
    const baseAngle = Math.atan2(base.y, base.x);
    kids.forEach((id, i) => {
      const a = baseAngle + (i - (kids.length - 1) / 2) * 0.34;
      const r = Math.hypot(base.x, base.y) + 92;
      pos.set(id, { x: Math.cos(a) * r + hashJitter(id), y: Math.sin(a) * r + hashJitter(id) });
    });
  }

  // 其余：外圈停靠，暗掉
  const rest = visible.filter((n) => !placed.has(n.id)).sort((a, b) => a.id.localeCompare(b.id));
  rest.forEach((n, i) => {
    const a = (i / Math.max(1, rest.length)) * Math.PI * 2;
    pos.set(n.id, { x: Math.cos(a) * 340, y: Math.sin(a) * 340 });
  });
  return { pos, neighborhood };
}

function edgeStyleKind(link: GraphLink): string {
  return EDGE_STYLE[link.kind] ? link.kind : "related";
}

export function Graph({
  data,
  selected,
  onSelect,
  focus,
  onFocus,
  onOpen,
}: {
  data: GraphData;
  selected: string | null;
  onSelect: (id: string | null) => void;
  focus: string | null;
  onFocus: (id: string | null) => void;
  onOpen: (id: string) => void;
}) {
  const [kinds, setKinds] = useState<Set<string>>(() => new Set(RAIL_EDGE_ORDER.filter((k) => data.links.some((l) => l.kind === k))));   // 数据一变由下面的 effect 校正
  const [states, setStates] = useState<Set<string>>(() => new Set(["active", "cold"]));
  const [hover, setHover] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showList, setShowList] = useState(true);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const [size, setSize] = useState({ w: 900, h: 620 });
  const [manual, setManual] = useState<Map<string, Pt>>(new Map());
  const [panning, setPanning] = useState(false);
  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string | null; startX: number; startY: number; originX: number; originY: number } | null>(null);
  /** 拖过就不算点击：不然拖一下节点会顺手把它设成焦点并打开详情。 */
  const dragged = useRef(false);

  const visible = useMemo(
    () => data.nodes.filter((n) => states.has(n.state) && (!query || n.label.toLowerCase().includes(query.toLowerCase()))),
    [data.nodes, states, query],
  );
  const visibleIds = useMemo(() => new Set(visible.map((n) => n.id)), [visible]);
  const layout = useMemo(() => layoutGraph(data, focus, visible), [data, focus, visible]);
  const base = layout.pos;
  const neighborhood = layout.neighborhood;
  const pos = useMemo(() => {
    if (manual.size === 0) return base;
    const merged = new Map(base);
    for (const [id, p] of manual) if (merged.has(id)) merged.set(id, p);
    return merged;
  }, [base, manual]);

  const visibleLinks = useMemo(
    () => data.links.filter((l) => visibleIds.has(l.source) && visibleIds.has(l.target)),
    [data.links, visibleIds],
  );
  const links = useMemo(() => visibleLinks.filter((l) => kinds.has(edgeStyleKind(l))), [visibleLinks, kinds]);

  /** 标签防重叠：按重要度贪心取，离已标注的节点太近就跳过（不然一堆标签叠在一起没法读）。 */
  const labels = useMemo(() => {
    const ids = new Set<string>();
    for (const id of [focus, hover, selected]) if (id) ids.add(id);
    const placed: Pt[] = [];
    for (const id of [focus, hover, selected]) {
      const p = base.get(id ?? "");
      if (p) placed.push(p);
    }
    for (const n of visible.slice().sort((a, b) => b.importance - a.importance)) {
      if (ids.size > 12) break;
      if (ids.has(n.id)) continue;
      const p = base.get(n.id);
      if (!p) continue;
      if (placed.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 46)) continue;
      placed.push(p);
      ids.add(n.id);
    }
    return ids;
  }, [visible, base, focus, hover, selected]);

  useEffect(() => setManual(new Map()), [focus]);

  // 画布尺寸：布局坐标以 (0,0) 为画布中心，所以要量出实际大小（之前漏了这一步，
  // 结果是所有节点按 SVG 左上角为原点摆放，一半节点在画布外）。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setSize({ w: r.width, h: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    setKinds((prev) => {
      // 换了数据/筛选后，只保留仍然存在的边类型；新出现的默认打开。
      const present = new Set(visibleLinks.map((l) => edgeStyleKind(l)));
      const next = new Set([...prev].filter((kk) => present.has(kk)));
      for (const kk of present) next.add(kk);
      return next;
    });
  }, [visibleLinks]);

  /** 适配窗口。
   *  有焦点时：焦点就在布局原点，直接把它放到画布正中（k=1），邻居环天然看得到；
   *  没有焦点时：按包围盒算缩放和位移，装下全库那张簇图。 */
  const fit = useCallback(() => {
    if (focus) {
      setView({ k: 1, x: 0, y: 0 });
      return;
    }
    const pts = [...base.values()];
    if (pts.length === 0) return;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    // 左右留够标签的位置（标签挂在节点上，超出画布就看不见了）
    const k = Math.min(1.15, Math.max(0.3, Math.min((size.w - 260) / w, (size.h - 180) / h)));
    setView({ k, x: -((minX + maxX) / 2) * k, y: -((minY + maxY) / 2) * k });
  }, [base, focus, size]);

  useEffect(() => {
    fit();
  }, [fit]);

  const toWorld = useCallback(
    (clientX: number, clientY: number): Pt => {
      const svg = ref.current!;
      const r = svg.getBoundingClientRect();
      const cx = r.width / 2;
      const cy = r.height / 2;
      return { x: (clientX - r.left - cx - view.x) / view.k, y: (clientY - r.top - cy - view.y) / view.k };
    },
    [view],
  );

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.min(2.6, Math.max(0.32, view.k * factor));
    const svg = ref.current!;
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left - r.width / 2;
    const py = e.clientY - r.top - r.height / 2;
    const ratio = next / view.k;
    setView({ k: next, x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio });
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const onPointerDown = (e: PointerEvent) => {
    const pt = toWorld(e.clientX, e.clientY);
    drag.current = { id: null, startX: e.clientX, startY: e.clientY, originX: pt.x, originY: pt.y };
    dragged.current = false;
    setPanning(true);
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.startX) > 4 || Math.abs(e.clientY - d.startY) > 4) dragged.current = true;
    if (d.id) {
      const x = d.originX + (e.clientX - d.startX) / view.k;
      const y = d.originY + (e.clientY - d.startY) / view.k;
      setManual((m) => new Map(m).set(d.id!, { x, y }));
    } else {
      setView((v) => ({ ...v, x: v.x + (e.clientX - d.startX), y: v.y + (e.clientY - d.startY) }));
      drag.current = { ...d, startX: e.clientX, startY: e.clientY };
    }
  };
  const onPointerUp = () => {
    drag.current = null;
    setPanning(false);
  };

  /** 节点上的按下：只记状态，不抢指针捕获 —— 抢了之后 click 会落在 <svg> 上，
   *  节点自己的 onClick 永远收不到（实测：点节点没反应，焦点怎么都设不上）。 */
  const startNodeDrag = (n: GraphNode, e: PointerEvent) => {
    e.stopPropagation();
    const p = pos.get(n.id);
    if (!p) return;
    drag.current = { id: n.id, startX: e.clientX, startY: e.clientY, originX: p.x, originY: p.y };
    dragged.current = false;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (focus) onFocus(null);
      else onSelect(null);
      return;
    }
    if (e.key === "f") {
      fit();
      return;
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown" && e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const cur = selected ?? focus;
    const here = cur ? pos.get(cur) : null;
    const dir = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key]!;
    let best: { id: string; score: number } | null = null;
    for (const [id, p] of pos) {
      if (id === cur) continue;
      const dx = p.x - (here?.x ?? 0);
      const dy = p.y - (here?.y ?? 0);
      const along = dx * dir[0]! + dy * dir[1]!;
      if (along <= 6) continue;
      const side = Math.abs(dx * dir[1]! - dy * dir[0]!);
      const score = along + side * 2;
      if (!best || score < best.score) best = { id, score };
    }
    if (best) {
      onSelect(best.id);
      if (e.shiftKey) onFocus(best.id);
    }
  };

  if (data.nodes.length === 0) {
    return (
      <div class="graph">
        <EmptyState
          title="库里还没有可画的节点"
          hint={
            <>
              图谱画的是 active / cold 的记忆和它们之间的关系。安静用一轮 pi，或者切到全局库看看：
              <br />
              <code>pi -p "记住：这个项目的测试统一跑 node tests/smoke.ts"</code>
            </>
          }
        />
      </div>
    );
  }

  const activeEdgeKinds = RAIL_EDGE_ORDER.filter((kk) => visibleLinks.some((l) => edgeStyleKind(l) === kk));
  const focusNode = focus ? data.nodes.find((n) => n.id === focus) ?? null : null;

  return (
    <div class={`graph ${showList ? "has-list" : ""}`}>
      {showList ? (
        <div class="graph-list">
          <div style={{ position: "sticky", top: 0, zIndex: 1, padding: "8px", background: "var(--surface)", borderBottom: "1px solid var(--line)" }}>
            <SearchInput value={query} onInput={setQuery} placeholder="过滤节点" />
            <div class="dim" style={{ marginTop: "6px", fontSize: "11.5px" }}>
              {visible.length} / {data.nodes.length} 个节点
            </div>
          </div>
          {visible
            .slice()
            .sort((a, b) => b.importance - a.importance || a.id.localeCompare(b.id))
            .map((n) => (
              <div key={n.id} class="row" role="button" tabindex={-1} aria-selected={selected === n.id} onClick={() => onSelect(n.id)} onDblClick={() => onOpen(n.id)} title={n.label}>
                <span class={`dot ${n.state}`} />
                <span class="truncate">{n.label}</span>
              </div>
            ))}
        </div>
      ) : null}

      <div class="graph-canvas">
        <div class="graph-overlay">
          <Button size="sm" variant="ghost" icon="list" onClick={() => setShowList((v) => !v)}>
            {showList ? "隐藏列表" : "节点列表"}
          </Button>
          {focusNode ? (
            <>
              <Chip tone="accent" title={focusNode.label}>
                焦点 {shortId(focusNode.id)}
              </Chip>
              <Button size="sm" variant="ghost" onClick={() => onFocus(null)}>
                回到全库
              </Button>
            </>
          ) : (
            <Chip tone="">全库概览（点击节点看邻居）</Chip>
          )}
          <span class="spacer" />
          {activeEdgeKinds.map((kk) => (
            <button
              key={kk}
              type="button"
              class={`chip ${kinds.has(kk) ? "accent" : ""}`}
              aria-pressed={kinds.has(kk)}
              onClick={() =>
                setKinds((s) => {
                  const next = new Set(s);
                  if (next.has(kk)) next.delete(kk);
                  else next.add(kk);
                  return next;
                })
              }
            >
              {KIND_LABEL[kk] ?? kk}
            </button>
          ))}
          {["active", "cold", "archived", "superseded"]
            .filter((s) => data.nodes.some((n) => n.state === s))
            .map((s) => (
              <button
                key={s}
                type="button"
                class={`chip ${states.has(s) ? "accent" : ""}`}
                aria-pressed={states.has(s)}
                onClick={() =>
                  setStates((prev) => {
                    const next = new Set(prev);
                    if (next.has(s)) next.delete(s);
                    else next.add(s);
                    return next;
                  })
                }
              >
                {STATE_LABEL[s] ?? s}
              </button>
            ))}
        </div>

        <svg
          ref={ref}
          tabindex={0}
          class={panning ? "panning" : ""}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          onKeyDown={onKeyDown}
          role="application"
          aria-label="记忆关系图"
        >
          <g transform={`translate(${size.w / 2 + view.x} ${size.h / 2 + view.y}) scale(${view.k})`}>
            {links.map((l, i) => {
              const a = pos.get(l.source);
              const b = pos.get(l.target);
              if (!a || !b) return null;
              const st = EDGE_STYLE[edgeStyleKind(l)]!;
              const hot = hover === l.source || hover === l.target || selected === l.source || selected === l.target;
              return (
                <line
                  key={`${l.source}-${l.target}-${i}`}
                  class="graph-edge"
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={st.tone}
                  stroke-width={hot ? 1.6 : 1}
                  stroke-dasharray={st.dash}
                  opacity={hot ? 0.95 : hover || selected ? 0.28 : 0.55}
                />
              );
            })}

            {[...pos.entries()].map(([id, p]) => {
              const n = data.nodes.find((x) => x.id === id);
              if (!n) return null;
              const r = 4 + n.importance * 7;
              const isFocus = focus === id;
              const isSel = selected === id;
              // 压暗优先级：悬停 > 选中 > 焦点邻域之外
              const linkedToSelected = selected != null && visibleLinks.some((l) => (l.source === selected && l.target === id) || (l.target === selected && l.source === id));
              const dim =
                (hover != null && hover !== id) ||
                (selected != null && !isSel && !linkedToSelected) ||
                (hover == null && selected == null && focus != null && !neighborhood.has(id));
              return (
                <g
                  key={id}
                  class="graph-node"
                  transform={`translate(${p.x} ${p.y})`}
                  opacity={dim ? 0.34 : 1}
                  onPointerDown={(e) => startNodeDrag(n, e)}
                  onPointerEnter={() => setHover(id)}
                  onPointerLeave={() => setHover((h) => (h === id ? null : h))}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (dragged.current) return;      // 刚才是拖动，不是点击
                    if (e.altKey || e.detail === 2) onOpen(id);
                    else {
                      onSelect(id);
                      onFocus(id);
                    }
                  }}
                  tabindex={0}
                  role="button"
                  aria-label={`${TYPE_LABEL[n.type] ?? n.type}：${n.label}`}
                >
                  <circle
                    r={r}
                    fill={n.state === "cold" ? "var(--warn)" : isFocus ? "var(--accent)" : "var(--surface-2)"}
                    stroke={n.state === "active" ? "var(--accent)" : n.state === "cold" ? "var(--warn)" : "var(--fg-faint)"}
                    stroke-width={isSel ? 2.4 : 1.4}
                  />
                  {n.state === "superseded" ? <line x1={-r} y1={r} x2={r} y2={-r} stroke="var(--bad)" stroke-width="1.4" /> : null}
                  {isFocus ? <circle r={r + 5} fill="none" stroke="var(--accent)" stroke-width="1" opacity="0.5" /> : null}
                  {labels.has(id) ? (
                    <text class={`graph-label ${isFocus || isSel ? "focus" : ""}`} y={-r - 6} text-anchor="middle">
                      {n.label.slice(0, 26)}
                    </text>
                  ) : null}
                  <title>{[n.label, `${TYPE_LABEL[n.type] ?? n.type} / ${STATE_LABEL[n.state] ?? n.state}`, n.topic ?? ""].filter(Boolean).join("\n")}</title>
                </g>
              );
            })}
          </g>
        </svg>

        <div class="graph-legend">
          {activeEdgeKinds
            .filter((kk) => kinds.has(kk))
            .map((kk) => (
              <div class="row" key={kk}>
                <svg viewBox="0 0 26 8">
                  <line x1="1" y1="4" x2="25" y2="4" stroke={EDGE_STYLE[kk]!.tone} stroke-width="1.4" stroke-dasharray={EDGE_STYLE[kk]!.dash} />
                </svg>
                {KIND_LABEL[kk] ?? kk}
              </div>
            ))}
        </div>
        {visibleLinks.length === 0 ? (
          <div class="graph-hint" style={{ right: "auto", left: "50%", transform: "translateX(-50%)", color: "var(--fg-dim)" }}>
            这些记忆之间还没有关系。同主题、同路径、取代/冲突、高相似会自动连成边。
          </div>
        ) : null}
        <div class="graph-hint">
          <KeyHint keys={["方向键"]} /> 选节点 <KeyHint keys={["Enter"]} /> 看详情 <KeyHint keys={["F"]} /> 适配 <KeyHint keys={["Esc"]} /> 回全库
        </div>
      </div>
    </div>
  );
}
