/**
 * 图谱：**Cytoscape.js 负责画**，这个文件只管「塞什么数据」和「点了之后干什么」。
 *
 * 上一版是 1000 行手写 SVG：布局、碰撞、标签避让、缩放平移、命中判定全自己实现，
 * 节点一多就卡，而且主题气泡只是画了个圈 —— 拖它带不动里面的节点。换成 Cytoscape 之后：
 *
 *   - **主题是复合节点**（compound node），不是画的圈：拖动主题带着子节点走，布局器按「簇」摆位。
 *   - **canvas 渲染**：几千节点不卡；标签避让缩成 applyLabels 里那一小段矩形判断。
 *   - 缩放 / 平移 / 框选 / 命中判定全部交给它，这里不再有坐标变换代码。
 *
 * 布局确定性没丢：初值按索引摆（不用随机数）+ fcose `randomize: false`，
 * 同一份数据两次打开位置一致。
 *
 * canvas 里没有 DOM 节点，所以旁边挂一份**视觉隐藏但键盘可达**的节点列表：Tab 能进、
 * 屏幕阅读器能读，e2e 也从这里点。
 */

import type { Core, CytoscapeOptions, ElementDefinition, EventObject, LayoutOptions, NodeSingular, StylesheetJsonBlock } from "cytoscape";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { GraphData, GraphLink, GraphNode } from "./api";
import { Button, Chip, EmptyState, KeyHint, SearchInput } from "./components";
import { KIND_LABEL, SCOPE_LABEL, STATE_LABEL, TYPE_LABEL, shortId } from "./format";

const EDGE_STYLE: Record<string, { dash?: number[]; tone: string; label: string; width: number }> = {
  supersedes: { tone: "var(--bad)", label: "取代", width: 1.6, dash: [5, 3] },
  contradicts: { tone: "var(--warn)", label: "冲突", width: 1.6, dash: [5, 3] },
  depends_on: { tone: "var(--info)", label: "依赖", width: 1.2, dash: [2, 3] },
  extends: { tone: "var(--info)", label: "延伸", width: 1.2, dash: [2, 3] },
  path: { tone: "var(--line-strong)", label: "同路径", width: 1, dash: [2, 3] },
  topic: { tone: "var(--line-strong)", label: "同主题", width: 1 },
  similar: { tone: "var(--accent)", label: "相似", width: 1 },
  related: { tone: "var(--line-strong)", label: "相关", width: 1 },
};

/** 有方向的边：取代和依赖方向反了，意思就反了。 */
const DIRECTED = new Set(["supersedes", "contradicts", "depends_on", "extends"]);

/** 左栏和筛选 chip 的顺序：事实关系在前，算法推出来的在后。 */
const RAIL_EDGE_ORDER = ["supersedes", "contradicts", "depends_on", "extends", "path", "topic", "similar", "related"];

const edgeKind = (k: string): string => (EDGE_STYLE[k] ? k : "related");

/** 标签最多画几条。只管数量：具体位置由碰撞判定决定（优先级的节点不受上限影响）。 */
const MAX_PLACED_LABELS = 60;

/**
 * 半径 = 连接度打底 × 重要度乘子（跟 cognee 同一条公式：`(4 + sqrt(deg/maxDeg)*10) * impFactor`）。
 *
 * 上一版只拿重要度在可见集里归一化 —— 库里重要度常挤在 0.6–0.95，归一化后只差几 px，
 * 而且中心节点和边缘叶子看起来一样大。degree 打底之后，枢纽自己就凸出来了。
 */
export function makeRadius(links: readonly GraphLink[]): (n: GraphNode) => number {
  const deg = new Map<string, number>();
  for (const l of links) {
    deg.set(l.source, (deg.get(l.source) ?? 0) + 1);
    deg.set(l.target, (deg.get(l.target) ?? 0) + 1);
  }
  const maxDeg = Math.max(1, ...deg.values());
  return (n) => {
    const imp = Math.min(1, Math.max(0, n.importance));
    return (6 + Math.sqrt((deg.get(n.id) ?? 0) / maxDeg) * 9) * (0.75 + imp * 0.5);
  };
}

const topicKey = (n: GraphNode) => n.topic || "未归主题";
const pathKey = (n: GraphNode) => n.path || "未挂路径";

export interface TreeItem {
  key: string;
  kind: "root" | "topic" | "path" | "memory";
  label: string;
  /** 子树里的记忆条数（分组节点用）。 */
  count: number;
  id?: string;
  state?: string;
  origin?: string;
  trust?: number;
  importance?: number;
  children?: TreeItem[];
}

/** 主题 → 路径 → 记忆。左边导航和右边分层图用的是**同一棵树**，两边口径不会漂。 */
export function buildTree(nodes: readonly GraphNode[], collapsed: ReadonlySet<string>): TreeItem | null {
  if (nodes.length === 0) return null;
  const topics = new Map<string, Map<string, GraphNode[]>>();
  for (const n of nodes) {
    const t = topicKey(n);
    const p = pathKey(n);
    const paths = topics.get(t) ?? new Map<string, GraphNode[]>();
    paths.set(p, [...(paths.get(p) ?? []), n]);
    topics.set(t, paths);
  }
  const topicItems: TreeItem[] = [...topics.entries()]
    .sort((a, b) => {
      const ca = [...a[1].values()].reduce((s, g) => s + g.length, 0);
      const cb = [...b[1].values()].reduce((s, g) => s + g.length, 0);
      return cb - ca || a[0].localeCompare(b[0]);
    })
    .map(([topic, paths]) => {
      const tKey = `topic:${topic}`;
      const children: TreeItem[] = [...paths.entries()]
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
        .map(([path, members]) => ({
          key: `path:${topic}/${path}`,
          kind: "path" as const,
          label: path,
          count: members.length,
          children: collapsed.has(`path:${topic}/${path}`)
            ? undefined
            : members
                .slice()
                .sort((a, b) => b.importance - a.importance || a.id.localeCompare(b.id))
                .map((n) => ({
                  key: `m:${n.id}`,
                  kind: "memory" as const,
                  label: n.label,
                  count: 1,
                  id: n.id,
                  state: n.state,
                  origin: n.origin,
                  trust: n.trust,
                  importance: n.importance,
                })),
        }));
      return {
        key: tKey,
        kind: "topic" as const,
        label: topic,
        count: children.reduce((s, c) => s + c.count, 0),
        children: collapsed.has(tKey) ? undefined : children,
      };
    });
  return {
    key: "root",
    kind: "root" as const,
    label: "本项目记忆库",
    count: nodes.length,
    children: topicItems,
  };
}

/* ------------------------------------------------------------------ 样式 */

interface Tokens {
  accent: string;
  info: string;
  warn: string;
  bad: string;
  line: string;
  lineStrong: string;
  fg: string;
  fgDim: string;
  fgFaint: string;
  surface: string;
  surface2: string;
  /** 记忆类型 → 填充色（`--c-<type>`）。 */
  types: Record<string, string>;
}

const TYPE_FALLBACK: Record<string, string> = {
  fact: "#4c8df6",
  procedure: "#2fa8c9",
  preference: "#b45bd4",
  event: "#e0a339",
  emotion: "#e5645c",
  relation: "#8b93a8",
};

/** Cytoscape 不吃 CSS 变量，所以从根元素读出当前主题的色值，用字面量喂它。 */
function readTokens(): Tokens {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    accent: v("--accent", "#3fbf8f"),
    info: v("--info", "#5aa9e6"),
    warn: v("--warn", "#d9a038"),
    bad: v("--bad", "#e0685f"),
    line: v("--line", "#1d2124"),
    lineStrong: v("--line-strong", "#2a2f34"),
    fg: v("--fg", "#e7eaec"),
    fgDim: v("--fg-dim", "#98a1a8"),
    fgFaint: v("--fg-faint", "#6a727a"),
    surface: v("--surface", "#101319"),
    surface2: v("--surface-2", "#161a21"),
    types: Object.fromEntries(Object.entries(TYPE_FALLBACK).map(([k, fb]) => [k, v(`--c-${k}`, fb)])),
  };
}

/**
 * 节点编码（分法是抄 cognee 的：填充管类别，其余维度走外环/描边，一个通道只放一件事）：
 *   半径 = 连接度打底 × 重要度乘子
 *   填色 = 记忆类型（六个类型六种实色）
 *   外环 = 作用域里的少数派（全局 / 会话画环，项目不画 —— 大多数都是项目，画了就是噪声）
 *   描边色 = 冷 / 已取代
 *   虚线描边 = 模型所记且未经确认（trust < 0.8）
 *
 * 上一版是「填色=作用域 + 描边=状态 + 虚线=trust」叠在一起，库里数据一同质（全 project、
 * 全 active）就塔成一片同色，四个维度只剩下半径在动。
 */
function styleSheet(t: Tokens): StylesheetJsonBlock[] {
  const sheet: StylesheetJsonBlock[] = [
    {
      selector: "node",
      style: {
        "background-color": t.types.relation ?? t.surface2,
        "background-opacity": 1,
        "border-width": 1,
        "border-color": t.lineStrong,
        "outline-width": 0,
        "transition-property": "opacity, border-width",
        "transition-duration": 140,
        // 默认不显示标签：只有 applyLabels 判过不打架的节点才加 label-shown。
        // 全显示的话，一堆压在一起的标签比没有标签更难读。
        label: "",
        "font-size": 9,
        color: t.fgDim,
        "text-valign": "top",
        "text-halign": "center",
        // 标签整个抬到节点上方：text-valign:top 只是「文字顶端对齐节点顶端」，
        // 不额外抬的话字会画在圆上（第一版就是这样）。
        "text-margin-y": -18,
        "text-wrap": "wrap",
        "text-max-width": "240px",
        "text-background-color": t.surface,
        "text-background-opacity": 0.72,
        "text-background-padding": "1px",
        "min-zoomed-font-size": 6,
        "overlay-opacity": 0,
      },
    },
    { selector: "node.label-shown", style: { label: "data(label)", "font-size": 10, color: t.fg } },
    { selector: "node.state-cold", style: { "border-color": t.warn, "border-width": 1.6 } },
    { selector: "node.state-archived", style: { "border-color": t.fgFaint, "background-opacity": 0.55 } },
    { selector: "node.state-superseded", style: { "border-color": t.bad, "background-opacity": 0.45 } },
    { selector: "node.trust-low", style: { "border-style": "dashed" } },
    { selector: "node.sel", style: { "border-width": 2.4 } },
    { selector: "node.focus", style: { "border-width": 3 } },
    { selector: "node.dim", style: { opacity: 0.22 } },
    // 分层图的分组：普通节点画的矩形（不是复合节点，见 elements 里的说明）
    {
      selector: "node.group",
      style: {
        shape: "round-rectangle",
        width: "data(w)",
        height: 22,
        "background-color": t.surface2,
        "border-color": t.lineStrong,
        "border-width": 1,
        label: "data(label)",
        "text-valign": "center",
        "text-halign": "center",
        "font-size": 11,
        color: t.fg,
        "min-zoomed-font-size": 7,
      },
    },
    { selector: "node.group.depth-0", style: { "border-color": t.accent, color: t.fg } },
    { selector: "node.group.depth-2", style: { "font-size": 10, color: t.fgDim } },
    // 分层里的记忆叶子：标签挂在右边，行距固定，不会打架
    {
      selector: "node.tree-leaf",
      style: {
        "text-valign": "center",
        "text-halign": "right",
        "text-margin-x": 7,
        "text-margin-y": 0,
        "text-background-opacity": 0,
        "font-size": 10.5,
        color: t.fgDim,
      },
    },
    // 主题/路径/根：复合节点（关系图里用）。不是画的圈 —— 拖它，里面的节点跟着走。
    {
      selector: "$node > node",
      style: {
        "background-color": t.surface2,
        "background-opacity": 0.45,
        "border-color": t.line,
        "border-width": 1,
        "border-style": "dashed",
        shape: "round-rectangle",
        padding: "12px",
        label: "data(label)",
        "text-valign": "top",
        "text-halign": "center",
        "font-size": 10,
        color: t.fgDim,
        "text-margin-y": -4,
        "min-zoomed-font-size": 8,
      },
    },
    {
      selector: "edge",
      style: {
        width: 1,
        "line-color": t.lineStrong,
        "curve-style": "straight",
        "transition-property": "opacity, width",
        "transition-duration": 140,
      },
    },
    { selector: "edge.directed", style: { "target-arrow-shape": "triangle", "target-arrow-color": t.lineStrong, "arrow-scale": 0.7 } },
    // 分层图的连线：用曲线，不用 taxi。taxi 会给「一个父节点扇出十几个子」画出一排平行
    // 拐角线，叠起来像个空框子（看上去像图谱里长了几个大矩形）。
    { selector: "edge.hier", style: { "curve-style": "bezier", "line-color": t.line, "line-opacity": 0.7 } },
    { selector: "edge.dim", style: { opacity: 0.12 } },
    { selector: "edge.hot", style: { width: 2, opacity: 1 } },
  ];
  // 填充 = 类型。实心，不再叠半透明 —— 半透明在暗底上会把六种颜色洗成同一个灰调。
  for (const [kind, fill] of Object.entries(t.types)) {
    sheet.push({ selector: `node.t-${kind}`, style: { "background-color": fill } });
  }
  // 作用域只给少数派画外环，通道和描边/填充都不重叠。
  for (const [cls, tone] of [["scope-global", t.info], ["scope-session", t.warn]] as const) {
    sheet.push({
      selector: `node.${cls}`,
      style: { "outline-color": tone, "outline-width": 1.6, "outline-offset": 1.5, "outline-opacity": 0.85 },
    });
  }
  for (const [kind, st] of Object.entries(EDGE_STYLE)) {
    sheet.push({
      selector: `edge.k-${kind}`,
      style: {
        "line-color": st.tone,
        "target-arrow-color": st.tone,
        width: st.width,
        ...(st.dash ? { "line-style": "dashed", "line-dash-pattern": st.dash } : {}),
      },
    });
  }
  return sheet;
}

/* ------------------------------------------------------------------ 组件 */

type Mode = "graph" | "tree";

const MODES: Array<[Mode, string, string]> = [
  ["graph", "关系图", "力导向：主题成团，边是记忆之间的关系"],
  ["tree", "分层", "主题 → 代码路径 → 记忆：看项目结构"],
];

/** e2e 用：canvas 里没有 DOM 节点，坐标只能从 cy 问。 */
interface GraphProbe {
  /** 记忆节点数（只数记忆：主题/路径/根那些分组不算）。 */
  nodeCount(): number;
  /** 当前可见节点数：用来验证折叠真的把子树藏起来了。 */
  visibleCount(): number;
  /** 分组节点数：关系图里是主题复合节点，分层图里是 库 + 主题 + 路径 的矩形。 */
  groupCount(): number;
  renderedCenter(id: string): { x: number; y: number; w: number; h: number } | null;
  /** 世界坐标（不带缩放平移），排查布局用。 */
  positions(): Array<{ id: string; x: number; y: number }>;
  canvas(): { w: number; h: number };
  /** 当前缩放（排查布局用）。 */
  zoom(): number;
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
  const [mode, setMode] = useState<Mode>("graph");
  const [kinds, setKinds] = useState<Set<string>>(() => new Set(RAIL_EDGE_ORDER));
  const [states, setStates] = useState<Set<string>>(() => new Set(["active", "cold"]));
  const [hover, setHover] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showRail, setShowRail] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [themeVersion, setThemeVersion] = useState(0);
  /** 图谱库是动态 import 的（体积不小），加载完才建实例。 */
  const [lib, setLib] = useState<((options?: CytoscapeOptions) => Core) | null>(null);

  const modeRef = useRef<Mode>("graph");
  const host = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  /** 点节点要区分「点击」和「拖完松手」——不然拖一下就把详情打开了。 */
  const dragged = useRef(false);
  /** 下一次布局跑完要不要重新适配视野（换模式/换数据要，折叠不要）。 */
  const needFit = useRef(true);
  /** 分层图里叶子太多时就不给叶子画标签：一列 49 条长文本叠下来是一墙字。 */
  const denseTree = useRef(false);

  const visible = useMemo(
    () =>
      data.nodes.filter(
        (n) =>
          states.has(n.state) &&
          (!query ||
            n.label.toLowerCase().includes(query.toLowerCase()) ||
            (n.topic ?? "").toLowerCase().includes(query.toLowerCase()) ||
            (n.path ?? "").toLowerCase().includes(query.toLowerCase())),
      ),
    [data.nodes, states, query],
  );
  const byId = useMemo(() => new Map(data.nodes.map((n) => [n.id, n])), [data.nodes]);
  const visibleIds = useMemo(() => new Set(visible.map((n) => n.id)), [visible]);
  const visibleLinks = useMemo(() => data.links.filter((l) => visibleIds.has(l.source) && visibleIds.has(l.target)), [data.links, visibleIds]);
  const links = useMemo(() => visibleLinks.filter((l) => kinds.has(edgeKind(l.kind))), [visibleLinks, kinds]);
  const radius = useMemo(() => makeRadius(links), [links]);
  const adj = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of visibleLinks) {
      m.set(l.source, (m.get(l.source) ?? new Set()).add(l.target));
      m.set(l.target, (m.get(l.target) ?? new Set()).add(l.source));
    }
    return m;
  }, [visibleLinks]);
  const treeRoot = useMemo(() => buildTree(visible, collapsed), [visible, collapsed]);
  /** 图例只列**这一份数据里真有的**类型（按条数排）：写死六行的时候，库里没有的类型也在占位置。 */
  const legendTypes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of visible) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  }, [visible]);

  // 事件回调放 ref：重建 cy 实例的 effect 不该因为父组件重新渲染就跑一遍。
  const live = useRef({ onSelect, onFocus, onOpen, byId, focus, hover, selected, adj, visible });
  live.current = { onSelect, onFocus, onOpen, byId, focus, hover, selected, adj, visible };
  modeRef.current = mode;

  useEffect(() => {
    let alive = true;
    void import("./graph-lib").then((m) => {
      if (alive) setLib(() => m.default);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 主题切换：Cytoscape 的样式表是字面色值，只能重建。
  useEffect(() => {
    const obs = new MutationObserver(() => setThemeVersion((v) => v + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  /* ---------------------------------------------------------------- 元素 */

  const elements = useMemo<ElementDefinition[]>(() => {
    const out: ElementDefinition[] = [];
    const nodeClasses = (n: GraphNode) =>
      [`t-${n.type}`, `scope-${n.scope}`, `state-${n.state}`, ...(n.trust < 0.8 ? ["trust-low"] : [])].join(" ");
    // 关系图里主题就是父节点：子节点必须在建立时就挂在 parent 上，否则主题会变成空框。
    const topicParent = (n: GraphNode) => `topic:${topicKey(n)}`;

    visible.forEach((n, i) => {
      // 初值按索引摆在螺旋上（不用随机数）：fcose 用 randomize:false 时靠它保证确定性。
      const ring = Math.floor(Math.sqrt(i));
      const angle = i * 2.399963;
      const rad = 30 + ring * 45;
      out.push({
        data: {
          id: n.id,
          label: n.label.length > 24 ? `${n.label.slice(0, 23)}…` : n.label,
          radius: radius(n),
          kind: "memory",
          ...(mode === "graph" ? { parent: topicParent(n) } : {}),
        },
        classes: nodeClasses(n),
        position: { x: Math.cos(angle) * rad, y: Math.sin(angle) * rad },
      });
    });

    if (mode === "graph") {
      const counts = new Map<string, number>();
      for (const n of visible) counts.set(topicParent(n), (counts.get(topicParent(n)) ?? 0) + 1);
      for (const [id, count] of counts) {
        out.push({ data: { id, label: `${id.slice("topic:".length)} · ${count}`, kind: "topic" } });
      }
      for (const l of links) {
        const kind = edgeKind(l.kind);
        out.push({
          data: { id: `e:${l.source}:${l.target}:${kind}`, source: l.source, target: l.target, kind },
          classes: `k-${kind}${DIRECTED.has(kind) ? " directed" : ""}`,
        });
      }
    } else {
      // 分层：库 → 主题 → 路径 → 记忆。
      //
      // 这里**不用复合节点**：复合节点的语义是「框住子节点」，于是父框必须一路包到最右列的
      // 记忆上，四个深度就叠成一个大框（试过，全挤成一列）。而这一层要的是「文档目录」的样子 ——
      // 每一层一列、连线牵着走 —— 所以分组当普通节点画（矩形 + 计数），位置自己算（preset）。
      //
      // 坐标：深度 → 横坐标，叶子顺序 → 纵坐标。折叠在算坐标时就地生效（折叠的分组占一行）。
      out.length = 0;
      const X = [0, 240, 480, 720];
      // 行距：小库放宽到 28px，大库压到 20px 就不再压了。再压下去标签会叠成一墙（fit 缩下去
      // 也一样）——行数超出视口就让用户上下拖，比缩到看不清强。
      const estimatedRows = visible.length + collapsed.size + 1;
      const hostH = host.current?.clientHeight ?? 720;
      const ROW = Math.max(20, Math.min(28, (hostH - 48) / Math.max(1, estimatedRows)));
      const hier: ElementDefinition[] = [];
      const link = (id: string, source: string, target: string) => hier.push({ data: { id, source, target }, classes: "hier" });
      const group = (id: string, label: string, depth: number, y: number, kind: string) =>
        out.push({
          data: { id, label, kind, w: Math.max(96, Math.min(240, label.length * 7.4 + 30)) },
          classes: `group depth-${depth}`,
          position: { x: X[depth]!, y },
        });

      const topics = new Map<string, Map<string, GraphNode[]>>();
      for (const n of visible) {
        const t = topicKey(n);
        const paths = topics.get(t) ?? new Map<string, GraphNode[]>();
        paths.set(pathKey(n), [...(paths.get(pathKey(n)) ?? []), n]);
        topics.set(t, paths);
      }

      // 叶子标签只在小树里全画；密度上来了只画分组（主题/路径）+ 悬停/选中的叶子。
      // 49 行长文本挤在一列里，画出来是一墙字，反而什么都读不出来。左栏列表和悬停卡都还在。
      const leafLabels = visible.length <= 24;
      denseTree.current = !leafLabels;
      let row = 0;
      const mid = (ys: number[]) => (ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : (row++) * ROW);
      const topicRows: Array<{ id: string; label: string; y: number }> = [];
      group("rs-root", `${visible.length} 条记忆`, 0, 0, "root");
      for (const [topic, paths] of [...topics.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))) {
        const tid = `topic:${topic}`;
        const count = [...paths.values()].reduce((s, g) => s + g.length, 0);
        const pathRows: Array<{ id: string; label: string; y: number }> = [];
        for (const [path, members] of [...paths.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
          const pid = `path:${topic}/${path}`;
          const collapsedHere = collapsed.has(pid) || collapsed.has(tid);
          const label = collapsedHere ? `${path} · ${members.length}（折叠）` : `${path} · ${members.length}`;
          if (collapsedHere) {
            pathRows.push({ id: pid, label, y: (row++) * ROW });
            continue;
          }
          const placed = members.map((n) => ({ n, y: (row++) * ROW }));
          for (const p of placed) {
            out.push({
              data: { id: p.n.id, label: p.n.label.slice(0, 30), radius: 5, kind: "memory" },
              classes: `${nodeClasses(p.n)}${leafLabels ? " label-shown" : ""} tree-leaf`,
              position: { x: X[3]!, y: p.y },
            });
            link(`h:${pid}:${p.n.id}`, pid, p.n.id);
          }
          pathRows.push({ id: pid, label, y: mid(placed.map((p) => p.y)) });
        }
        topicRows.push({ id: tid, label: `${topic} · ${count}`, y: mid(pathRows.map((r) => r.y)) });
        for (const r of pathRows) {
          group(r.id, r.label, 2, r.y, "path");
          link(`h:${r.id}`, tid, r.id);
        }
      }
      for (const tr of topicRows) {
        group(tr.id, tr.label, 1, tr.y, "topic");
        link(`h:${tr.id}`, "rs-root", tr.id);
      }
      out.push(...hier);
    }
    return out;
  }, [visible, links, radius, mode, collapsed]);

  /** 分层模式下的折叠：任一祖先是折叠状态，这条就藏起来。 */
  const applyCollapse = useCallback((cy: Core, collapsedSet: ReadonlySet<string>) => {
    for (const n of cy.nodes()) {
      let hidden = false;
      for (const a of n.ancestors()) {
        if (collapsedSet.has(a.id())) {
          hidden = true;
          break;
        }
      }
      n.style("display", hidden ? "none" : "element");
    }
  }, []);

  /**
   * 标签：焦点/悬停/选中优先，其余按重要度取，并且**估矩形避让一次**。
   * Cytoscape 不管标签重叠（节点和标签都是它画的），而图谱最难读的就是一堆压在一起的标签。
   */
  const applyLabels = useCallback((cy: Core) => {
    const { focus: f, hover: h, selected: s, visible: vis, adj } = live.current;
    // 分层图的行距是算出来的，标签位置固定，不按碰撞筛；只在稠密树里给焦点/悬停/选中补标签。
    if (modeRef.current === "tree") {
      if (!denseTree.current) return;
      cy.nodes().removeClass("label-shown");
      for (const id of [f, h, s]) if (id) (cy.getElementById(id) as NodeSingular).addClass("label-shown");
      return;
    }
    const fixed = [f, h, s].filter((x): x is string => Boolean(x));
    /** 连接度高先占位置：空间不够时，枢纽的名字比叶子的重要（同 cognee 的破平规则）。 */
    const degree = (id: string) => adj.get(id)?.size ?? 0;
    const ranked = vis
      .slice()
      .sort((a, b) => degree(b.id) - degree(a.id) || b.importance - a.importance)
      .map((n) => n.id)
      .filter((id) => !fixed.includes(id));
    // 标签一律单行（20 字以内 + text-max-width 240px）：折行的标签第二行会压到节点上，
    // 而「压到节点上」正是要避免的事。宽度按中日韩字宽估（一个汉字 ≈ 9px）。
    const MAXW = 240;
    const LINE_H = 13;
    const boxOf = (label: string, center: { x: number; y: number }, nodeH: number) => {
      const w = Math.min(MAXW, label.length * 9 + 8);
      return { x: center.x - w / 2, y: center.y - nodeH / 2 - 18 - LINE_H, w, h: LINE_H };
    };
    const taken: Array<{ x: number; y: number; w: number; h: number }> = [];
    // 障碍只算**记忆节点**：主题/路径是包着子节点的框，把它们算进来等于每个标签都压在
    // 自己的父框上，于是全被判为「打架」，一条标签都不显示（第一版就是这样）。
    const boxes = [...cy.nodes()]
      .filter((n) => n.isChildless())
      .map((n) => {
        const p = n.renderedPosition();
        const w = n.renderedWidth();
        const hh = n.renderedHeight();
        return { id: n.id(), x: p.x - w / 2, y: p.y - hh / 2, w, h: hh };
      });
    const hits = (b: { x: number; y: number; w: number; h: number }, self: string) =>
      boxes.some((q) => q.id !== self && b.x < q.x + q.w && q.x < b.x + b.w && b.y < q.y + q.h && q.y < b.y + b.h);
    // 复合节点的标题一直显示（组名），所以先把它们占的位置记为已占用。
    for (const n of cy.nodes()) {
      if (n.isChildless()) continue;
      const p = n.renderedPosition();
      const top = p.y - n.renderedHeight() / 2;
      taken.push({ x: p.x - 90, y: top - 16, w: 180, h: 16 });
    }
    cy.nodes().removeClass("label-shown");
    // 两遍放置：焦点/悬停/选中（优先级 3）不看碰撞直接画 —— 用户正看的就是它；
    // 其余按连接度排序逐个试，撞了就丢。上限只管数量，不再当“预算”用。
    const wanted: Array<[string, number]> = [
      ...fixed.map((id) => [id, 3] as [string, number]),
      ...ranked.map((id) => [id, 1] as [string, number]),
    ];
    let placed = 0;
    for (const [id, prio] of wanted) {
      if (placed >= MAX_PLACED_LABELS) break;
      const ele = cy.getElementById(id) as NodeSingular;
      if (ele.empty() || !ele.visible()) continue;
      const label = String(ele.data("label") ?? "");
      const box = boxOf(label, ele.renderedPosition(), ele.renderedHeight());
      const clash = hits(box, id) || taken.some((q) => box.x < q.x + q.w && q.x < box.x + box.w && box.y < q.y + q.h && q.y < box.y + box.h);
      if (prio < 3 && clash) continue;
      taken.push(box);
      ele.addClass("label-shown");
      placed++;
    }
  }, []);

  /** 高亮：中心节点（悬停 > 选中 > 焦点）的邻居留着，其余压暗。 */
  const applyHighlight = useCallback(
    (cy: Core) => {
      const { hover: h, selected: s, focus: f, adj: adjacency } = live.current;
      const center = h ?? s ?? f;
      const neighbors = center ? adjacency.get(center) ?? new Set<string>() : new Set<string>();
      cy.batch(() => {
        cy.elements().removeClass("dim sel focus hot");
        for (const n of cy.nodes()) {
          const id = n.id();
          if (id === s) n.addClass("sel");
          if (id === f) n.addClass("focus");
          if (center && id !== center && !neighbors.has(id) && n.isChildless()) n.addClass("dim");
        }
        for (const e of cy.edges()) {
          if (e.hasClass("hier")) continue;
          const hot = center != null && (e.source().id() === center || e.target().id() === center);
          e.toggleClass("hot", hot);
          e.toggleClass("dim", center != null && !hot);
        }
      });
      applyLabels(cy);
    },
    [applyLabels],
  );

  /** 焦点居中 / 无焦点则适配全图。焦点居中这条被 e2e 钉着（手感也靠它）。 */
  const fitView = useCallback((cy: Core, focusId: string | null) => {
    if (focusId) {
      const n = cy.getElementById(focusId);
      if (!n.empty()) {
        cy.zoom(1);
        cy.center(n);
        return;
      }
    }
    cy.fit(undefined, 60);
    // 分层图：行数超过视口时，fit 会一直缩下去，缩到 0.85 以下标签就糊成一墙。
    // 宁可停在这个缩放下，让用户上下拖（拖比看一墙字强）。
    if (modeRef.current === "tree" && cy.zoom() < 0.85) {
      cy.zoom(0.85);
      cy.center();
    }
  }, []);

  /* ---------------------------------------------------------------- 挂载 */

  useEffect(() => {
    const el = host.current;
    if (!el || visible.length === 0 || !lib) return;
    const cy = lib({
      container: el,
      elements,
      style: styleSheet(readTokens()),
      wheelSensitivity: 0.22,
      minZoom: 0.1,
      maxZoom: 3,
      boxSelectionEnabled: true,
      pixelRatio: "auto",
      layout: { name: "preset" },
    });
    cyRef.current = cy;

    cy.on("layoutstop", () => {
      const c = cyRef.current;
      if (!c) return;
      applyCollapse(c, collapsedRef.current);
      if (needFit.current) {
        needFit.current = false;
        fitView(c, live.current.focus);
      }
      applyHighlight(c);
    });

    cy.on("tap", "node", (e: EventObject) => {
      if (dragged.current) return;
      const node = e.target;
      const id = node.id();
      if (node.isParent()) {
        // 分组节点：分层模式下点它就是折叠/展开，关系图模式下什么都不做。
        if (mode === "tree") setCollapsed((prev) => toggleSet(prev, id));
        return;
      }
      if (e.originalEvent instanceof MouseEvent && (e.originalEvent.altKey || e.originalEvent.detail > 1)) {
        live.current.onOpen(id);
        return;
      }
      live.current.onSelect(id);
      live.current.onFocus(live.current.byId.has(id) ? id : null);
    });
    cy.on("tap", (e: EventObject) => {
      if (e.target === cy && !dragged.current) {
        live.current.onSelect(null);
        live.current.onFocus(null);
      }
    });
    cy.on("grab", "node", () => (dragged.current = false));
    cy.on("drag", "node", () => (dragged.current = true));
    cy.on("mouseover", "node", (e: EventObject) => {
      const id = e.target.id();
      if (live.current.byId.has(id)) setHover(id);
    });
    cy.on("mouseout", "node", () => setHover(null));
    let zoomTimer: number | undefined;
    cy.on("zoom", () => {
      window.clearTimeout(zoomTimer);
      zoomTimer = window.setTimeout(() => {
        if (cyRef.current) applyLabels(cyRef.current);
      }, 120);
    });

    // e2e 的挂载点：canvas 画出来的东西 DOM 里查不到。
    const win = window as unknown as { __rsGraphProbe?: GraphProbe };
    win.__rsGraphProbe = {
      nodeCount: () => cy.nodes('node[kind = "memory"]').length,
      visibleCount: () => cy.nodes().filter((n) => n.visible()).length,
      groupCount: () => cy.nodes(":parent").length + cy.nodes("node.group").length,
      renderedCenter: (id) => {
        const n = cy.getElementById(id);
        if (n.empty()) return null;
        const p = n.renderedPosition();
        return { x: p.x, y: p.y, w: n.renderedWidth(), h: n.renderedHeight() };
      },
      positions: () =>
        [...cy.nodes()].map((n) => ({ id: n.id(), x: Math.round(n.position("x")), y: Math.round(n.position("y")) })),
      canvas: () => ({ w: el.clientWidth, h: el.clientHeight }),
      zoom: () => cy.zoom(),
    };

    cy.ready(() => {
      cy.layout(layoutOptions(mode)).run();
    });

    // 容器大小会变（左栏折叠、窗口缩放、首屏布局还在落），而 Cytoscape 只在 window resize
    // 时自己更新 —— 不告诉它，它会继续按旧尺寸算坐标，焦点居中和 fit 都会偏。
    const ro = new ResizeObserver(() => {
      const c = cyRef.current;
      if (!c) return;
      c.resize();
      const f = live.current.focus;
      if (f) {
        const n = c.getElementById(f);
        if (!n.empty()) c.center(n);
      }
      applyLabels(c);
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      delete win.__rsGraphProbe;
      cy.destroy();
      cyRef.current = null;
    };
    // 元素集合或模式变了就重建：几百个节点重建几毫秒，而增量改 compound 结构容易出脏状态。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elements, mode, themeVersion, lib, applyCollapse, applyHighlight, applyLabels, fitView]);

  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

  // 折叠：不重建实例，只藏子树 + 重新适配。
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || mode !== "tree") return;
    applyCollapse(cy, collapsed);
    // 走 fitView（它带分层图的最小缩放限制），别直接 cy.fit —— 直接 fit 会把上面那条限制绕过去。
    fitView(cy, null);
    applyLabels(cy);
  }, [collapsed, mode, applyCollapse, applyLabels, fitView]);

  // 选中/悬停/焦点变了：只改 class，不动布局。
  useEffect(() => {
    const cy = cyRef.current;
    if (cy) applyHighlight(cy);
  }, [applyHighlight, hover, selected, focus]);

  // 焦点变化 → 居中它。
  useEffect(() => {
    const cy = cyRef.current;
    if (cy && focus) fitView(cy, focus);
  }, [focus, fitView]);

  /* ---------------------------------------------------------------- 交互 */

  const toggleSet = (prev: ReadonlySet<string>, key: string): Set<string> => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const cy = cyRef.current;
    if (!cy) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      if (focus) onFocus(null);
      else onSelect(null);
      fitView(cy, null);
      return;
    }
    if (e.key === "f") {
      fitView(cy, null);
      return;
    }
    if (e.key === "Enter" && selected) {
      e.preventDefault();
      onOpen(selected);
      return;
    }
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
    e.preventDefault();
    // 方向键 = 就近选：同一方向里「朝前的分量大、横向偏得少」的那个赢。
    const cur = selected ?? focus;
    const here = cur ? cy.getElementById(cur).renderedPosition() : null;
    const dir = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key]!;
    let best: { id: string; score: number } | null = null;
    for (const n of cy.nodes()) {
      const id = n.id();
      if (id === cur || !n.isChildless() || !n.visible()) continue;
      const p = n.renderedPosition();
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
      onFocus(best.id);
      fitView(cy, best.id);
    }
  };

  /* ---------------------------------------------------------------- 渲染 */

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

  const activeKinds = RAIL_EDGE_ORDER.filter((k) => kinds.has(k));
  const agentCount = visible.filter((n) => n.origin === "agent").length;
  const hoverNode = hover ? byId.get(hover) ?? null : null;
  const focusNode = focus ? byId.get(focus) ?? null : null;

  return (
    <div class={`graph ${showRail ? "has-list" : ""}`}>
      {showRail ? (
        <div class="graph-rail">
          <div class="graph-rail-head">
            <SearchInput value={query} onInput={setQuery} placeholder="过滤节点 / 主题 / 路径" />
            <div class="graph-stats">
              <span class="k">{visible.length}</span> 节点 · <span class="k">{visibleLinks.length}</span> 边 ·{" "}
              <span class="k">{new Set(visible.map(topicKey)).size}</span> 主题 ·{" "}
              <span class="k">{new Set(visible.filter((n) => n.path).map((n) => n.path)).size}</span> 路径
              {agentCount > 0 ? <> · <span class="k warn">{agentCount}</span> 条模型所记</> : null}
            </div>
          </div>
          <div class="rail-tree">
            {(treeRoot?.children ?? []).map((t) => (
              <div key={t.key} class="rail-node">
                <button type="button" class="rail-head" aria-expanded={!collapsed.has(t.key)} onClick={() => setCollapsed((prev) => toggleSet(prev, t.key))}>
                  <span class={`caret ${collapsed.has(t.key) ? "" : "open"}`}>›</span>
                  <span class="rail-name">{t.label}</span>
                  <span class="rail-count">{t.count}</span>
                </button>
                {!collapsed.has(t.key)
                  ? (t.children ?? []).map((p) => (
                      <div key={p.key} class="rail-node">
                        <button type="button" class="rail-head sub" aria-expanded={!collapsed.has(p.key)} onClick={() => setCollapsed((prev) => toggleSet(prev, p.key))}>
                          <span class={`caret ${collapsed.has(p.key) ? "" : "open"}`}>›</span>
                          <span class="rail-name mono">{p.label}</span>
                          <span class="rail-count">{p.count}</span>
                        </button>
                        {!collapsed.has(p.key)
                          ? (p.children ?? []).map((m) => (
                              <div
                                key={m.key}
                                class="row leaf"
                                role="button"
                                tabindex={-1}
                                aria-selected={selected === m.id}
                                onClick={() => {
                                  onSelect(m.id!);
                                  onFocus(m.id!);
                                }}
                                onDblClick={() => onOpen(m.id!)}
                                title={`${TYPE_LABEL[byId.get(m.id!)?.type ?? ""] ?? ""}｜${m.label}`}
                              >
                                <span class={`dot ${m.state} ${m.origin === "agent" ? "agent" : ""}`} />
                                <span class="truncate">{m.label}</span>
                              </div>
                            ))
                          : null}
                      </div>
                    ))
                  : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div class="graph-canvas">
        <div class="graph-overlay">
          <Button size="sm" variant="ghost" icon="list" onClick={() => setShowRail((v) => !v)}>
            {showRail ? "隐藏结构" : "项目结构"}
          </Button>
          <div class="seg">
            {MODES.map(([m, label, title]) => (
              <button key={m} type="button" class={`seg-item ${mode === m ? "on" : ""}`} aria-pressed={mode === m} title={title} onClick={() => setMode(m)}>
                {label}
              </button>
            ))}
          </div>
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
          {activeKinds.map((k) => (
            <button
              key={k}
              type="button"
              class={`chip ${kinds.has(k) ? "accent" : ""}`}
              aria-pressed={kinds.has(k)}
              title={EDGE_STYLE[k]!.label}
              onClick={() => setKinds((prev) => toggleSet(prev, k))}
            >
              {KIND_LABEL[k] ?? k}
            </button>
          ))}
          {["active", "cold", "archived", "superseded"]
            .filter((s) => data.nodes.some((n) => n.state === s))
            .map((s) => (
              <button key={s} type="button" class={`chip ${states.has(s) ? "accent" : ""}`} aria-pressed={states.has(s)} onClick={() => setStates((prev) => toggleSet(prev, s))}>
                {STATE_LABEL[s] ?? s}
              </button>
            ))}
        </div>

        {/* canvas 里没有 DOM 节点：这份列表是键盘和屏幕阅读器的入口，e2e 也从这里点。 */}
        <div class="graph-a11y" aria-label="记忆节点（按重要度排序）">
          {visible
            .slice()
            .sort((a, b) => b.importance - a.importance)
            .map((n) => (
              <button
                key={n.id}
                type="button"
                class="graph-node-a11y"
                data-id={n.id}
                aria-current={selected === n.id}
                aria-label={`${TYPE_LABEL[n.type] ?? n.type}：${n.label}`}
                onClick={() => {
                  onSelect(n.id);
                  onFocus(n.id);
                }}
                onDblClick={() => onOpen(n.id)}
              >
                {n.label.slice(0, 40)}
              </button>
            ))}
        </div>

        <div ref={host} class="graph-canvas-host" tabindex={0} role="application" aria-label="记忆关系图" onKeyDown={onKeyDown} />

        {hoverNode ? (
          <div class="graph-tip">
            <div class="graph-tip-head">
              <span class="mono faint">{shortId(hoverNode.id)}</span>
              <Chip>{TYPE_LABEL[hoverNode.type] ?? hoverNode.type}</Chip>
              <Chip>{SCOPE_LABEL[hoverNode.scope] ?? hoverNode.scope}</Chip>
              {hoverNode.project ? <Chip title="所属项目">{hoverNode.project}</Chip> : null}
              {hoverNode.origin === "agent" ? <Chip tone="warn">模型所记 {hoverNode.trust.toFixed(2)}</Chip> : null}
            </div>
            <div class="graph-tip-body">{hoverNode.label}</div>
            <div class="graph-tip-meta mono">
              {hoverNode.topic ?? "未归主题"}
              {hoverNode.path ? ` ｜ ${hoverNode.path}` : ""} ｜ 重要度 {hoverNode.importance.toFixed(2)} ｜ 召回 {hoverNode.access}
            </div>
          </div>
        ) : null}

        <div class="graph-legend">
          {activeKinds
            .filter((k) => kinds.has(k))
            .map((k) => (
              <div class="row" key={k}>
                <svg viewBox="0 0 26 8">
                  <line
                    x1="1"
                    y1="4"
                    x2="25"
                    y2="4"
                    stroke={EDGE_STYLE[k]!.tone}
                    stroke-width={EDGE_STYLE[k]!.width + 0.4}
                    stroke-dasharray={EDGE_STYLE[k]!.dash?.join(" ")}
                  />
                </svg>
                {KIND_LABEL[k] ?? k}
              </div>
            ))}
          {legendTypes.map((t) => (
            <div class="row" key={t}>
              <span class="lg-dot" style={{ background: `var(--c-${t})`, borderColor: "transparent" }} />
              {TYPE_LABEL[t] ?? t}
            </div>
          ))}
          <div class="row">
            <span class="lg-dot ring" />
            全局 / 会话（外环）
          </div>
          <div class="row">
            <span class="lg-dot dashed" />
            模型所记（虚线）
          </div>
          <div class="row">
            <span class="lg-dot group" />
            主题（拖它整团跟着走）
          </div>
        </div>

        {visibleLinks.length === 0 ? (
          <div class="graph-hint" style={{ right: "auto", left: "50%", transform: "translateX(-50%)", color: "var(--fg-dim)" }}>
            这些记忆之间还没有关系。同主题、同路径、取代/冲突、高相似会自动连成边。
          </div>
        ) : null}
        <div class="graph-hint">
          <KeyHint keys={["方向键"]} /> 选节点 <KeyHint keys={["Enter"]} /> 看详情 <KeyHint keys={["F"]} /> 适配{" "}
          <KeyHint keys={["Esc"]} /> 回全库{mode === "tree" ? " · 点分组框折叠" : " · 拖主题带着整团走"}
        </div>
      </div>
    </div>
  );
}

/**
 * 关系图用 fcose（复合节点摆位是它的强项：主题整团成簇，边少的元件自动分开摆）。
 * 分层的坐标是算好的，所以走 preset。
 */
function layoutOptions(mode: Mode): LayoutOptions {
  return mode === "graph"
    ? ({
        name: "fcose",
        quality: "default",
        animate: false,
        randomize: false,
        fit: false,
        padding: 30,
        nodeSeparation: 60,
        idealEdgeLength: 55,
        nodeRepulsion: 3000,
        gravity: 0.4,
        gravityRange: 2.5,
        packComponents: true,
        tile: false,
      } as unknown as LayoutOptions)
    : ({ name: "preset", animate: false, fit: false } as unknown as LayoutOptions);
}
