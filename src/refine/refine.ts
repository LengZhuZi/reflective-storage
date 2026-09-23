/**
 * 提炼 + 主题提议。一次调用同时要两样东西 —— 多问一样不加钱（同一个结论：
 * JEV 那边一次调用里放 3 个问题和放 20 个问题耗时一样）。
 *
 * 主题名**由模型定，不再问用户**：提示词里喂了项目名 + 已有主题，并要求优先复用已有主题。
 * 同义词碎片由「近义堆」那个视图兜底合并（一键合，可回滚），不再占用户一次点击。
 *
 * 长回复**先切分再提炼**（`split`）：一段 20–30K 的回复里往往有好几件事，压成一条的话
 * 检索层面共用一个向量/主题/类型（要么召不回，要么一次召回一整块）。切分给的是**逐字片段**
 * —— 不是摘要 —— 每条自己落库、自己提炼、自己一个向量。切不动就退回单条（见 `planParts`）。
 *
 * 失败姿态：任何一步失败都返回空提炼，调用方存原文（fail-open）。
 */

import { ChatClient, ChatUnavailableError, type ChatMessage } from "./client.ts";
import type { RefineConfig } from "../config.ts";

export interface Refinement {
  /** 提炼后的记忆正文。null = 没提炼（没配后端 / 失败 / 模型认为没有可复用的信息）。 */
  summary: string | null;
  /** 主题名提议。null = 没提议。 */
  topic: string | null;
  status: "ok" | "unavailable" | "empty";
  model: string;
  latencyMs: number;
  /** 给人看的失败/结果说明，落轨迹用。 */
  reason: string;
}

/** 提炼时给模型的上下文：**项目名 + 已有主题**。主题名要能同时跨项目和跨时间复用，
 *  这两样都得喂进去，否则模型每次都在自己造词。 */
export interface RefineScope {
  /** 当前项目标识（`projectIdFor(cwd)`）。 */
  project?: string;
  /** 已有主题名（项目库 + 全局库），最多 30 个。 */
  existingTopics: readonly string[];
  maxChars: number;
}

/**
 * 一段的记忆标注：程序切好段落之后，模型只负责「这一段讲什么 + 起个名」，**不碰原文**。
 * 不要求模型回显或切分原文：它抄不回两万字（被 max_tokens 截断），也会顺手改写。
 */
export interface LabelItem {
  summary: string | null;
  topic: string | null;
}

export interface LabelResult {
  items: LabelItem[];
  status: "ok" | "unavailable" | "empty";
  model: string;
  latencyMs: number;
  reason: string;
}

export interface Refiner {
  readonly available: boolean;
  readonly model: string;
  readonly problems: readonly string[];
  refine(raw: string, opts: RefineScope): Promise<Refinement>;
  /** 给**程序切好的**若干段各写一句提炼 + 一个主题（一次调用，不碰原文）。 */
  label(blocks: readonly string[], opts: RefineScope): Promise<LabelResult>;
}

/** 提炼的系统提示。口径只写一次，改这里就改了全项目的行为。 */
function systemPrompt(maxChars: number): string {
  return [
    "你在给一个长期记忆库做提炼。输入是编码助手刚才的一段回复。",
    `把其中**以后还用得上**的东西压成一条记忆：要点式 3-8 条，用「；」连成一段，总共不超过 ${maxChars} 个字。`,
    "每一条都要能脱离这段上下文看懂：写出具体的文件名、路径、接口名、版本号、参数值、结论 ——",
    "细节就是这条记忆的价值，别抽象成一句总结（「质量集中在某目录」这种写法等于没记）。",
    "保留可复用的结论、事实、约定、踩过的坑；去掉过程叙述、寒暄、一次性的临时路径、失败的尝试，",
    "以及命令的原始输出（结论可以引用一行，不要整段贴）。不要用「我」「刚才」这类指代，缺主语就补清楚。",
    "再给一个主题名：2-6 个字的名词短语。",
    "主题名会被反复复用，所以：",
    "1. 已有主题里**确实就是这段在说的事**，必须原样用它（包括它带了项目名前缀的情况）；",
    "2. 已有主题里有一个只是叫法不同、说的其实是同一件事，也用已有那个，不要另起一个新说法；",
    "3. 确实是全新的话题才给新名字。新名字要能脱离这段上下文也看得懂（比如「检索排序」而不是「这个」）。",
    `严格输出 JSON，不要解释、不要代码块：{"summary": "...", "topic": "..."}`,
    `没有值得长期保留的信息就输出 {"summary": "", "topic": ""}。`,
  ].join("\n");
}

/**
 * 给「一段一段切好的回复」写提炼的提示词。
 *
 * 为什么不让模型切分原文：实测 glm-4-flash 对 9K/15K 的多话题输入都只回一条，而且两万字的
 * 输入它逐字回显不出来（max_tokens 截断）。**切分交给程序**（`splitSections`：markdown 标题 →
 * 空行段落 → 句子边界），模型只回答「这段讲什么」。这样原文一定是逐字原文，零改写风险。
 */
function labelSystemPrompt(maxChars: number, count: number): string {
  return [
    `输入是一轮助手回复，已经被程序按结构切成 ${count} 段（用【第 N 段】标出）。分段是既定的，你不要重新分段。`,
    "对**每一段**给出两样东西：",
    `1. \`summary\`：这一段里**以后还用得上**的东西，压成一句话（不超过 ${maxChars} 字）。`,
    "   只留可复用的结论、事实、约定、踩过的坑；去掉过程叙述、寒暄、这次特有的一次性细节。",
    "   不要用「我」「刚才」这类指代，缺主语就补清楚。这一段没有值得长期保留的内容就填空字符串。",
    "2. `topic`：2-6 个字的名词短语。已有主题里**确实就是这段在说的事**，就原样用它；",
    "   只是叫法不同的也用已有那个；确实是新话题才给新名字。",
    '严格输出 JSON，不要解释、不要代码块：{"items":[{"i":1,"summary":"...","topic":"..."}]}',
    "items 必须正好覆盖每一段（i 从 1 开始）。",
  ].join("\n");
}

/** 解析 `{"items":[{"i","summary","topic"}]}`；按 i 对齐到段号，缺的填空。 */
export function parseLabel(text: string, count: number, maxChars: number): LabelItem[] {
  const out: LabelItem[] = Array.from({ length: count }, () => ({ summary: null, topic: null }));
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return out;
  let raw: { items?: unknown } | unknown[] | null = null;
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as { items?: unknown };
  } catch {
    return out;
  }
  const items = Array.isArray(raw) ? raw : Array.isArray((raw as { items?: unknown }).items) ? (raw as { items: unknown[] }).items : [];
  for (const item of items) {
    const it = item as { i?: unknown; summary?: unknown; topic?: unknown };
    const i = Math.floor(Number(it?.i));
    if (!Number.isFinite(i) || i < 1 || i > count) continue;
    const summary = typeof it.summary === "string" && it.summary.trim() ? clampSummary(it.summary, maxChars) : null;
    // 没有 summary 的段（模型认为这段没价值）就不带主题：给一条没提炼的记忆挂个主题只会
    // 在主题树里多一个空壳，而这段本来也就只存原文备查。
    const topic = summary && typeof it.topic === "string" && usableTopic(it.topic) ? it.topic : null;
    out[i - 1] = { summary, topic };
  }
  return out;
}

/**
 * 程序侧的切分：markdown 标题 → 空行段落 → 句子边界。**零模型、零改写**，切出来的一定是逐字原文。
 *
 * 三步：
 *   1. `##`/`###`/`####` 标题起新块（标题行留在块里，读回来知道这段在讲什么）；
 *   2. 全文没有标题 → 按空行分段，贪心合到 `maxChars`；
 *   3. 还是超长的块 → 在句子边界上硬切（`。！？；`），**不丢字**。
 * 最后块数超上限就把尾部合并（同样不丢字）。
 */
export function splitSections(full: string, opts: { maxChars?: number; maxParts?: number } = {}): string[] {
  const maxChars = opts.maxChars ?? 3000;
  const maxParts = opts.maxParts ?? 6;
  const text = full.trim();
  if (!text) return [];
  const HEAD = /^#{1,4}\s/;
  let blocks: string[] = [];
  let cur: string[] = [];
  // 代码围栏里的一行 `# 注释` 不是标题 —— 不认围栏的话，一段 shell 脚本会把整块切碎。
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && HEAD.test(line) && cur.join("\n").trim()) {
      blocks.push(cur.join("\n").trim());
      cur = [];
    }
    cur.push(line);
  }
  if (cur.join("\n").trim()) blocks.push(cur.join("\n").trim());
  if (blocks.length <= 1) {
    const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    blocks = [];
    let buf = "";
    for (const p of paras) {
      if (buf && buf.length + p.length > maxChars) {
        blocks.push(buf);
        buf = "";
      }
      buf = buf ? `${buf}\n\n${p}` : p;
    }
    if (buf) blocks.push(buf);
  }
  const out: string[] = [];
  for (const b of blocks) {
    if (b.length <= maxChars) {
      out.push(b);
      continue;
    }
    let buf = "";
    for (const piece of b.split(/(?<=[。！？；!?;])\s*/)) {
      if (buf && buf.length + piece.length > maxChars) {
        out.push(buf.trim());
        buf = "";
      }
      buf += piece;
    }
    if (buf.trim()) out.push(buf.trim());
  }
  // 只有半行的碎片并回上一块（比如只剩个 `## 二、配色` 标题）：这种单独成一条记忆只会添噪声。
  // 阈值给得很小，因为「一段 157 字的话」是有内容的，不该被吞。
  const MIN_BLOCK = 80;
  const merged: string[] = [];
  for (const b of out) {
    if (merged.length && b.length < MIN_BLOCK) merged[merged.length - 1] = `${merged[merged.length - 1]}\n\n${b}`;
    else merged.push(b);
  }
  if (merged.length > 1 && merged[0]!.length < MIN_BLOCK) {
    merged[1] = `${merged[0]}\n\n${merged[1]}`;
    merged.shift();
  }
  if (merged.length > maxParts) return [...merged.slice(0, maxParts - 1), merged.slice(maxParts - 1).join("\n\n")];
  return merged;
}

/**
 * 给切好的每一段都要到标注 —— 模型会漏段（实测 5 段只回来 1 条），漏了要补。
 *
 * 三级：整批一次 → 只把缺的那几段再问一次 → 还缺就一段一段问。成本不管（用户原话：
 * 「不在乎成本」），要的是每段都有提炼：没有 summary 的那条在注入时只能给原文，
 * 主题也挂不上，等于白拆。
 *
 * 只在**部分**缺失时补：全缺说明后端根本没在干活，同一批输入再问一遍也不会变。
 */
export async function labelAll(refiner: Refiner, blocks: readonly string[], opts: RefineScope): Promise<LabelResult> {
  const first = await refiner.label(blocks, opts);
  const missing = first.items.map((it, i) => (it.summary ? -1 : i)).filter((i) => i >= 0);
  if (!missing.length || missing.length === blocks.length) return first;
  const items = [...first.items];
  let latency = first.latencyMs;
  let filled = 0;
  const batch = await refiner.label(missing.map((i) => blocks[i]!), opts);
  latency += batch.latencyMs;
  missing.forEach((blockIndex, j) => {
    const got = batch.items[j];
    if (got?.summary) {
      items[blockIndex] = got;
      filled++;
    }
  });
  const stillMissing = missing.filter((i) => !items[i]?.summary);
  for (const i of stillMissing) {
    const one = await refiner.label([blocks[i]!], opts);
    latency += one.latencyMs;
    const got = one.items[0];
    if (got?.summary) {
      items[i] = got;
      filled++;
    }
  }
  return {
    ...first,
    items,
    latencyMs: latency,
    reason: `${first.reason}；缺 ${missing.length} 段，补问拿回 ${filled} 段`,
  };
}

/** 从回复里抠出 JSON。模型偶尔会包一层 ```json 或说一句废话，不当失败处理。 */
export function parseRefinement(text: string): { summary: string; topic: string } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return { summary: "", topic: "" };
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as { summary?: unknown; topic?: unknown };
    return {
      summary: typeof raw.summary === "string" ? raw.summary.trim() : "",
      topic: typeof raw.topic === "string" ? raw.topic.trim() : "",
    };
  } catch {
    return { summary: "", topic: "" };
  }
}

/**
 * 主题名做最小校验：带句子的、带标点的、看得出是句在解释的都不算主题。
 *
 * 长度上限放到 24（原来是 12）：提示词第 1 条明确要求「已有主题带了项目名前缀就原样用」，
 * 而项目名本身就占十来个字 —— 实测 glm-4-flash 给出的是「tobacco-atlas掺配板设计」（19 字），
 * 限 12 会把**完全合规**的提议当垃圾丢掉，库里的 topic 就全空了（实测就是这样）。
 * 光看长度分不出「合规的长主题」和「一句话」，所以另加一组从句词。
 */
const TOPIC_MAX = 24;
const TOPIC_CLAUSE = /(这个|那个|实在|不像|觉得|应该|其实|还是|怎么|什么|是否)/;

function usableTopic(topic: string): boolean {
  if (!topic || topic.length > TOPIC_MAX) return false;
  if (/[。！？!?，,；;：:]/.test(topic)) return false;
  if (TOPIC_CLAUSE.test(topic)) return false;
  if (/^(无|没有|不确定|none|n\/a)$/i.test(topic)) return false;
  return true;
}

function clampSummary(summary: string, maxChars: number): string {
  const one = summary.replace(/\s+/g, " ").trim();
  if (one.length <= maxChars) return one;
  // 模型没听话：截到上限并在句子边界收尾，免得库里有半句话。
  const cut = one.slice(0, maxChars);
  const stop = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("；"), cut.lastIndexOf("，"));
  return stop > maxChars * 0.6 ? cut.slice(0, stop + 1) : cut;
}

export function createRefiner(cfg: RefineConfig, fetchImpl?: typeof fetch): Refiner {
  const client = new ChatClient({
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
    fetchImpl,
    problems: cfg.problems,
    noKeyReason: `提炼后端没配好（provider=${cfg.provider}）：在设置页填 key 和端点，或设 REFLECTIVE_REFINE_API_KEY`,
  });

  return {
    available: client.available,
    model: client.model,
    problems: cfg.problems,

    async refine(raw: string, opts): Promise<Refinement> {
      const base: Refinement = { summary: null, topic: null, status: "empty", model: client.model, latencyMs: 0, reason: "" };
      const text = raw.trim();
      if (!text) return { ...base, reason: "没有内容可提炼" };
      const t0 = Date.now();
      const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt(opts.maxChars) },
        {
          role: "user",
          content:
            `项目：${opts.project || "（未知）"}\n` +
            `已有主题：${opts.existingTopics.length ? opts.existingTopics.join(" / ") : "（还没有主题）"}\n\n回复：\n${text}`,
        },
      ];
      try {
        const out = await client.complete(messages, { json: true });
        const parsed = parseRefinement(out);
        const summary = parsed.summary ? clampSummary(parsed.summary, opts.maxChars) : "";
        const topic = usableTopic(parsed.topic) ? parsed.topic : null;
        // 被弃用的提议也要写进 reason：只留「没主题」的话，看不出到底是模型没给
        // 还是给了但被校验挡了 —— 上面那个 19 字主题就是这样静默丢了一整天。
        const topicNote = topic
          ? `，主题提议「${topic}」`
          : parsed.topic ? `，主题提议「${parsed.topic}」不合规，弃用` : "";
        return {
          summary: summary || null,
          topic,
          status: summary ? "ok" : "empty",
          model: client.model,
          latencyMs: Date.now() - t0,
          reason: summary ? `提炼 ${text.length} → ${summary.length} 字${topicNote}` : "模型认为没有可长期保留的信息",
        };
      } catch (e) {
        const msg = e instanceof ChatUnavailableError ? e.message : (e as Error).message;
        return { ...base, status: "unavailable", latencyMs: Date.now() - t0, reason: `提炼失败，存原文：${msg}` };
      }
    },

    async label(blocks: readonly string[], opts): Promise<LabelResult> {
      const base: LabelResult = { items: [], status: "empty", model: client.model, latencyMs: 0, reason: "" };
      const list = blocks.map((b) => b.trim()).filter(Boolean);
      if (!list.length) return { ...base, reason: "没有内容可提炼" };
      const t0 = Date.now();
      const numbered = list.map((b, i) => `【第 ${i + 1} 段】\n${b}`).join("\n\n");
      const messages: ChatMessage[] = [
        { role: "system", content: labelSystemPrompt(opts.maxChars, list.length) },
        {
          role: "user",
          content:
            `项目：${opts.project || "（未知）"}\n` +
            `已有主题：${opts.existingTopics.length ? opts.existingTopics.join(" / ") : "（还没有主题）"}\n\n${numbered}`,
        },
      ];
      try {
        const out = await client.complete(messages, { json: true });
        const parsed = parseLabel(out, list.length, opts.maxChars);
        return {
          items: parsed,
          status: parsed.some((p) => p.summary) ? "ok" : "empty",
          model: client.model,
          latencyMs: Date.now() - t0,
          reason: `给 ${list.length} 段写提炼，回来 ${parsed.filter((p) => p.summary).length} 条`,
        };
      } catch (e) {
        const msg = e instanceof ChatUnavailableError ? e.message : (e as Error).message;
        return { ...base, status: "unavailable", latencyMs: Date.now() - t0, reason: `提炼失败，各段存原文：${msg}` };
      }
    },
  };
}
