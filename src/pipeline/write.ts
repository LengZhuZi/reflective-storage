/**
 * 写入流程编排（DESIGN.md §8.2 / §9）。
 *
 * 顺序：本地预筛 → 取同作用域候选 → J1+J2+J3（一次调用）→ 落库 + 写 trace。
 *
 * 三条不能违反的约束：
 *
 *  1. 只消化**用户自己的话**。工具输出里是凭据、是几百行日志，把它写进长期记忆
 *     等于把密码存进一个会到处注入的库。这条沿用既有实践踩过的结论。
 *  2. 本地预筛先跑，因为它免费。JEV 是花钱的那一步，不值得为「继续」调它。
 *  3. 判断失败也必须落一条 trace。DESIGN.md §6.2：JEV 不可用不能表现成「没有记忆」，
 *     否则分不清「没记」和「系统死了」。
 */

import type { MemoryNode, MemoryOrigin, SessionInfo } from "../core/types.ts";
import { TRUST_CAP } from "../core/types.ts";
import { resolveScope } from "../core/governance.ts";
import type { JevAdapter } from "../jev/adapter.ts";
import { MAX_CANDIDATES, MERGE_ASK_ABOVE, MERGE_AUTO_ABOVE } from "../jev/adapter.ts";
import { RELATION_AUTO_BELOW } from "./review.ts";
import { longestSharedRun, ruleScope } from "../jev/rule.ts";
import { cosine, embed } from "../embed/encoder.ts";
import {
  addRelation, addTrace, adjustTrust, distinctTopics, getEmbedding, insertMemory, putEmbedding, setState,
  setTopic, type InsertMemory, type OpenedDb,
} from "../storage/db.ts";
import { recallCandidates } from "./recall.ts";
import { attachPaths } from "./tree.ts";
import { SAME_THING_RUN } from "./review.ts";
import { mergeMemories, queueAfterWrite, queueMerge, queueScopeWidening, type ReviewItem } from "./review.ts";

/** 低于这个概率就不写。实测 §4.1：明确要求记住的给出 0.86–0.89，无关内容 0.2。 */
export const KEEP_THRESHOLD = 0.5;

/** 触发合并判定的余弦下限（只当触发器，判决归引擎）。 */
export const MERGE_TRIGGER_COSINE = 0.85;

/**
 * 「同一个主题 + 不算低的相似」也触发合并提议（让 J11 去判）。
 *
 * 为什么单独一条：**跨会话重分析**同一个模块，两条内容重叠但措辞完全不同 ——
 * 实测同一份项目的两条分析余弦只有 0.76–0.82，够不到 0.85 这条线，于是库里留着两份
 * 讲同一件事的记忆。主题是现成的强信号（同一个 topic 说明说的是同一件事），
 * 所以这条线放宽到 0.8，并且**只提议**：判决还是 J11 的，自动合并仍然要它给高分。
 */
export const MERGE_TOPIC_COSINE = 0.8;

/** 引擎不可用时照存的那条记忆给多少重要性 —— 低到会先被衰减/归档，高到还能被召回。 */
export const FAIL_OPEN_IMPORTANCE = 0.3;

/**
 * trust 的三个出厂值。只按**来源**定，不按引擎打分定。
 *
 * 为什么不让 JEV 给一句「这条对不对」的分数：它的输入是文本，输出是数字，没有仓库、
 * 没跑过测试。给它「已有记忆 + 会话上下文」，它做的是一致性检查 —— 而模型自己上次写
 * 错的东西是自洽的，这次照样打高分。真假的证据不在判断链里，在工具结果里（见下面的
 * `agentVerified`）。
 */
export const TRUST_USER = 1;
/** 模型写的，但这一轮有工具跑成功过 —— 「改了 X，测试通过」这种有外部验证的结论。 */
export const TRUST_AGENT_VERIFIED = 0.7;
/** 模型写的，没有任何外部验证 —— 纯推断。 */
export const TRUST_AGENT_BARE = 0.4;

/** 短于这个长度的用户输入不值得评估（"继续"、"好"、"嗯"）。 */
const MIN_LENGTH = 8;

/** 纯确认/催促，没有可记信息。 */
const NOISE = /^(继续|好|好的|嗯|行|可以|ok|okay|yes|no|停|算了|谢谢|多谢|go on|continue)[。.!！?？\s]*$/i;

/**
 * 疑问句。
 *
 * 实测（真跑 pi）：用户一句「这个仓库提交的时候要怎么拆？」被 J1 判成值得存（1.00），
 * 于是**问题本身变成了记忆**。问题不是记忆 —— 不挡的话，每一句提问都会入库，
 * 长期下来库里全是问句，注入预算会被吃光。
 *
 * 不能说「带问号就跳过」：「记住：为什么不？」这种带着明确要求的句子必须留。
 * 所以只挡「有疑问句形状且没有任何持久化信号」的。
 */
const QUESTION = /(怎么|如何|为什么|为啥|什么|能不能|是不是|要不要|有没有|哪[个些里]|多少|how|why|what|which|where)[^。！!]{0,24}[?？]/i;
const QUESTION_TAIL = /[?？]\s*$/;

/** 出现这些词就说明用户在下结论/提要求，不是单纯提问。 */
const DURABLE_SIGNAL = /(记住|记一下|记下来|以后|之后都|不要用|别再|改用|应该改|决定|采用|统一|一律|必须|只能|默认用|remember)/i;

/** 凭据形态。落盘前必须洗掉 —— 记忆库会被注入到每一次对话里。
 *
 * 实测漏过的两类（真跑 pi 存进过库）：
 *   1. 连接串里的明文口令 —— `postgresql://readonly:S3cr3tP%40ss@10.0.0.5:5432/prod`
 *      旧正则只认 `password=xxx`，DSN 完全不匹配。
 *   2. 中文口语写法 —— `密码是 hunter2`、`密码：hunter2`，旧正则只认 `[:=]`。
 * 所以这里补了 DSN（只洗口令段，主机和库名留着，那才是有用的信息）和「是/为/：」。
 */
const DSN = /([a-z][a-z0-9+.-]*:\/\/[^\s:@/]*):[^\s@/]+@/gi;
const SECRET = /(sk-[A-Za-z0-9_-]{8,}|apikey_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{8,}|(?:密码|口令|密钥|password|passwd|pwd|token|secret|api[_-]?key)\s*(?:是|为|[:=：])\s*[^\s，。；、！？,;：]+)/gi;

export function redact(s: string): string {
  return s.replace(DSN, "$1:***@").replace(SECRET, "***");
}

/**
 * 查重用的归一化：大小写、空白、标点、符号都不算差异。
 *
 * 为什么需要：真实跑一遍 pi 发现同一条约定被存了两遍 —— 模型在对话中调了
 * memory_add，agent_end 又把用户原话自动存一次（J3 能标出 extends，但两行还是两行）。
 * 重复不花钱不多，但它会占注入预算，也会让「该记的」越来越难找。
 * 这里做的是**精确**重复：归一化后完全一样才合并，语义相近交给 J3/J11。
 */
export function normalizeForDedup(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

export interface TurnInput {
  /** 本轮用户说过的话，按时间顺序。 */
  userTexts: string[];
  /**
   * 这些话是谁说的。默认 user。
   *
   * 拆句、脱敏、J1 写入闸、查重、合并、冲突检测 —— 两条来源走**完全同一套**，
   * 唯一的差别就是落库时的 origin/trust 和以后的注入措辞。判断链一个字不改。
   */
  origin?: MemoryOrigin;
  /** origin=agent 时：这一轮有没有工具跑成功过。有就给高一点的 trust（0.7 vs 0.4）。 */
  agentVerified?: boolean;
  /** 本轮碰过的文件（来自 pi 的 tool call）。给记忆挂树路径用（tree.ts）。 */
  paths?: string[];
  /** 别的项目（id + 线索），让引擎可以判定「这条属于那个项目」（跨项目写入）。 */
  projects?: Array<{ id: string; hint: string }>;
  /** 按 id 打开别的项目库（调用方缓存 + 收尾关闭）。返回 null 表示这次不跨项目写。 */
  openForeign?: (projectId: string) => OpenedDb | null;
  /** 供 JEV 判断用的对话上下文（可以包含助手的话，但同样要洗凭据）。 */
  context: string;
  /**
   * 提炼层的结果（可选）。这是**生成**不是判断：`summary` 存进 summary 字段（原文照旧进
   * content，一行不改），`topic` 只是提议。没配提炼后端就没这个字段，行为跟以前一样。
   */
  refinement?: { summary?: string | null; topic?: string | null };
  /**
   * 主题兜底提议（可选）：引擎在已有主题里挑不出来、又没有 `refinement` 时调它一次，
   * 只取主题名。用户自己说的话走这条路（那条路没有 summary 可提炼）。
   * 返回 null = 这次拿不到名字，主题就留空。抛错按拿不到处理（fail-open）。
   */
  topicProposer?: (content: string) => Promise<string | null>;
}

export interface WriteResult {
  action: "stored" | "skipped" | "noise" | "duplicate";
  memory?: MemoryNode;
  /** 为什么跳过，用于 /memory 展示。 */
  reason?: string;
  /** 落库后排队等用户确认的事项（合并提议 / 低置信冲突），由调用方决定什么时候问。 */
  review?: ReviewItem[];
  /** 判断引擎的三态。调用方靠它决定要不要提示（例如引擎连不上时提示代理）。 */
  status?: "ok" | "degraded" | "unavailable";
  /** 自动合并掉了几条（引擎判定是同一件事）。 */
  merged?: number;
}

/** 有疑问句形状且没有持久化信号 —— 就是提问，不是记忆。 */
function isPureQuestion(t: string): boolean {
  return (QUESTION.test(t) || QUESTION_TAIL.test(t)) && !DURABLE_SIGNAL.test(t);
}

/**
 * 按句切开。实测：一句话里夹问句很常见（「这个怎么拆？另外以后都用 X」），
 * 不切就把提问也一起存进记忆，以后注入时模型看到的是噪声。
 */
function sentences(text: string): string[] {
  return text.split(/(?<=[。！？!?])/).map((s) => s.trim()).filter(Boolean);
}

/**
 * 本地预筛：决定这份内容值不值得花一次 JEV 调用。
 * 它只负责省钱，不负责判断内容好坏 —— 那是 J1 的活。
 */
/**
 * 工具/子任务的**任务书**，不是记忆。
 *
 * 实测：用 subagent 拆模块分析时，派给子任务的那段提示词（「Task: Analyze the module
 * tobacco-service/… Report in Chinese: purpose of module, its application port…」）作为
 * 「用户的话」进了写入链路，J1 还判了值得记 —— 库里躺着三条 697–724 字的任务书，
 * 占了三个主题位（`[模块分析]`）。
 *
 * 只认特征明确的开头：这一段本来就是给模型看的指令，不会出现在人要记的话里。
 */
const TOOL_TASK = /^\s*(Task:|You are\b|You're\b|Analyze the\b|Please analyze\b|分析一下以下|请分析以下|扮演\b)/;

export function worthEvaluating(text: string, opts: { allowQuestion?: boolean } = {}): { ok: boolean; reason?: string } {
  const t = text.trim();
  if (t.length < MIN_LENGTH) return { ok: false, reason: `太短（${t.length} < ${MIN_LENGTH}）` };
  if (NOISE.test(t)) return { ok: false, reason: "纯确认/催促" };
  if (TOOL_TASK.test(t)) return { ok: false, reason: "工具任务书（派给子任务的指令），不是记忆" };
  // 助手侧跳过问句过滤：一整篇分析里夹个问号就整篇不要了，那不是“判断”，是丢数据。
  if (!opts.allowQuestion && isPureQuestion(t)) {
    return { ok: false, reason: "疑问句，不是记忆" };
  }
  return { ok: true };
}

/**
 * 一轮里有几句话，就分几条记忆写（最多 3 条，多的并进最后一条）。
 *
 * 实测（真 pi）：用户一口气说「提交必须一个模块一个提交。另外我一般喜欢先给结论」
 * 时，整段被当成**一条**记忆 —— 于是一个项目约定和一个用户偏好挤在同一条里，
 * 类型只能选一个（判成了 fact），作用域也只能选一个（跟着进了项目库）。
 * 用户偏好本该是 global，被锁进单个项目就再也跟不着他走了。
 *
 * 拆开之后每条各自过 J1+J2+J3：类型、作用域、主题、去重、合并提议都按句粒度算。
 * 代价是每条一次判断调用（写入本来就在后台队列里跑，不挡用户）。
 */
export const MAX_WRITES_PER_TURN = 3;

export function splitForWrite(userTexts: readonly string[]): string[] {
  const parts = userTexts
    .flatMap((t) => sentences(t))
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0 && !isPureQuestion(s));
  if (parts.length <= MAX_WRITES_PER_TURN) return parts;
  return [...parts.slice(0, MAX_WRITES_PER_TURN - 1), parts.slice(MAX_WRITES_PER_TURN - 1).join(" ")];
}

/**
 * 把本轮的候选内容拼成一段交给 J1。
 *
 * **用户侧和助手侧走两条路**（实测踩过：同一条路会吃掉助手的长段落）：
 *   - 用户侧是一句一句说的话：拆句 + 剔掉纯提问（「这个怎么拆？」不是记忆，还会把噪声
 *     带进注入块）+ 把行内空白压成一个空格。
 *   - 助手侧是一整篇 markdown（标题、列表、代码块）：**原样保留**。既不拆句、也不过滤
 *     问句、也不折叠空白 —— 这三个都是为短句写的规则，套在长文上就是数据损失：
 *       · 一段代码块里没有句号，末尾一个 `？` 就让 `isPureQuestion` 把整段判成提问丢掉
 *         （实测 325 字的「模块地图」只剩 1 个字）；
 *       · `[^\S\n]+ → " "` 会把缩进和逐列表对齐全压平（实测一块 776 → 399 字）。
 *     助手侧的文本已经是被切好的逐字片段，这里的活只剩脱敏和去空行。
 */
export function buildCandidate(input: TurnInput): string {
  const agent = input.origin === "agent";
  const pieces = agent
    ? input.userTexts.map((t) => t.replace(/[ \t]+$/gm, "").trim())
    : input.userTexts.flatMap((t) => sentences(t)).map((s) => s.replace(/[^\S\n]+/g, " "));
  return pieces
    .map((s) => redact(s))
    .filter((s) => s.length > 0 && (agent || !isPureQuestion(s)))
    .join(agent ? "\n\n" : "\n");
}

/**
 * 三个本地判据决定「要不要让 J11 判这两条是不是一件事」。**只触发，不判决** ——
 * 判决交给引擎（阈值见 MERGE_AUTO_ABOVE / MERGE_ASK_ABOVE）。
 *
 *   1. 字面连续片段够长（≥ SAME_THING_RUN 个二字组）—— 原样复述，最硬的信号；
 *   2. 向量余弦 ≥ 0.85 —— 同义改写；
 *   3. **同主题** + 余弦 ≥ 0.8 —— 跨会话重分析同一个模块：内容重叠但措辞差得远
 *      （实测同一份项目的两份分析只有 0.76–0.82），够不到第 2 条，而主题是现成的强信号。
 *      只差一个项目名的两条记忆余弦能到 0.953，所以余弦永远只当触发，不当判决。
 */
export function mergeTriggered(
  a: { content: string; topic: string | null },
  b: { content: string; topic: string | null },
  sim: number | null,
): boolean {
  if (longestSharedRun(a.content, b.content) >= SAME_THING_RUN) return true;
  if (sim === null) return false;
  if (sim >= MERGE_TRIGGER_COSINE) return true;
  return Boolean(a.topic && b.topic && a.topic === b.topic && sim >= MERGE_TOPIC_COSINE);
}

export async function writeFlow(
  projectDb: OpenedDb,
  globalDb: OpenedDb,
  adapter: JevAdapter,
  session: SessionInfo,
  input: TurnInput,
): Promise<WriteResult> {
  const content = buildCandidate(input);
  const pre = worthEvaluating(content, { allowQuestion: input.origin === "agent" });
  if (!pre.ok) {
    return { action: "noise", reason: pre.reason };
  }

  // J3 需要候选：**跟这条内容最相关的**旧记忆，不是「最近入库的 20 条」。
  // 走召回那套多路召回（向量 + FTS5 + 作用域），并且带上 global 库 —— 用「最近 20 条」的话，
  // 一条很久以前的矛盾记忆永远进不了候选，冲突检测就是失灵的。
  const candidates = await recallCandidates(content, {
    projectDb, globalDb, session, limit: MAX_CANDIDATES, openForeign: input.openForeign,
  });

  // 先查重再调 JEV：完全重复的一句话不该再花一次判断，也不该再占一条预算。
  // 已经在候选里的记忆比对，不额外查库。
  const norm = normalizeForDedup(content);
  const dup = candidates.find((c) => normalizeForDedup(c.content) === norm);
  if (dup) {
    addTrace(projectDb, {
      stage: "write", gate: "dedup", action: "duplicate", targetId: dup.id,
      reason: `与已有记忆内容相同（${dup.id}）`,
    });
    return { action: "duplicate", memory: dup, reason: `与已有记忆相同（${dup.id.slice(0, 8)}）` };
  }

  // J4：把**现有主题**给引擎，让它只在里面挑（它不许生成新词）。项目库和全局库的主题
  // 合起来给 —— 主题是跨库的分组，不是作用域。
  const topics = [...new Set([...distinctTopics(projectDb), ...distinctTopics(globalDb)])].slice(0, 30);
  const j = await adapter.judgeWrite(content, redact(input.context), candidates, topics, input.projects ?? []);

  // §6.1 fail-open：引擎「不可用」时**不卡写入闸** —— 丢一条记忆的代价大于存一条噪声。
  // （原来的写法是先算 worth_keeping 再比阈值，于是引擎挂了、规则兜底给出 0.2，
  // 记忆就静默丢了 —— 那是 fail-closed，跟设计写反了。）
  // 代价是对付噪声：这样存进来的记忆 importance 压到 0.3，衰减和归档会比正常记忆快，
  // 也不会盖过正常记住的东西。
  const unavailable = j.meta.status === "unavailable";
  if (!unavailable && j.worthKeeping.noul < KEEP_THRESHOLD) {
    addTrace(projectDb, {
      stage: "write", gate: j.meta.gate, action: "skip",
      reason: `worth_keeping=${j.worthKeeping.noul.toFixed(2)} < ${KEEP_THRESHOLD}`,
      confidence: j.worthKeeping.noul, status: j.meta.status,
      fallbackUsed: j.meta.fallbackUsed, latencyMs: j.meta.latencyMs,
    });
    return { action: "skipped", reason: `worth_keeping ${j.worthKeeping.noul.toFixed(2)}`, status: j.meta.status };
  }

  // J14b：作用域分了置信度就分别对待。低置信度只许收窄（§11 原则 6），
  // 默认值取规则档的判断当参照 —— 引擎不确定时至少要有个「更窄」的方向。
  const resolved = resolveScope(j.scope.choice, j.scope.confidence, ruleScope(j.type.choice).choice);

  // 作用域决定落哪个库：偏好之类跨项目的进 global，其余进当前项目。
  // 例外：引擎判定这条属于**别的项目**（跨项目写入）→ 写进那个项目的库，
  // 并且两边留痕（用户指出过：在前端会话里发现后端问题就该能改，不能只读）。
  const foreign = j.ownerProject ? input.openForeign?.(j.ownerProject) ?? null : null;
  const target = foreign ?? (resolved.scope === "global" ? globalDb : projectDb);
  const origin: MemoryOrigin = input.origin ?? "user";
  const trust = origin === "agent" ? (input.agentVerified ? TRUST_AGENT_VERIFIED : TRUST_AGENT_BARE) : TRUST_USER;
  const insert: InsertMemory = {
    content,
    // 提炼只填 summary：**content 永远是原文**（真相不许被压缩掉，提炼错了也只是多几行
    // 上下文，不是永久丢信息）。显示和注入默认用 summary，需要细节时用 memory_raw 取原文。
    summary: input.refinement?.summary ?? undefined,
    type: j.type.choice,
    scope: foreign ? "project" : resolved.scope,
    topic: j.topic,
    scopeId: foreign
      ? j.ownerProject!
      : resolved.scope === "project" ? session.projectId : resolved.scope === "session" ? session.sessionId : null,
    // 引擎不可用时照存，但压成低重要性（见上面 fail-open 的说明）
    importance: unavailable ? FAIL_OPEN_IMPORTANCE : j.worthKeeping.noul,
    source: session.sessionId,
    origin,
    trust,
  };
  const memory = insertMemory(target, insert);

  // 树路径来自**本轮碰过的文件**（pi 的 tool call 自带），不是让引擎或用户起名。
  attachPaths(target, memory.id, input.paths ?? [], session.cwd);

  // 向量是加分项：编码失败不能让写入失败（原则 2：向量层可重建）。
  let vec: number[] | null = null;
  try {
    vec = await embed(content);
    putEmbedding(target, memory.id, vec);
  } catch {
    /* 没有向量也不影响这条记忆的使用，只影响语义召回那一路 */
  }

  // J11 合并：**触发**用本地判据（字面连续片段够长、或向量余弦够高），**决定**交给引擎。
  // 只差一个项目名的两条记忆余弦 0.953 —— 比真重复还高，所以余弦只能当触发器，
  // 不能当判决（实测算过：alpha/beta 0.953 vs 模型转述 0.797）。
  const mergeCandidates = candidates.filter((c) => {
    if (c.id === memory.id) return false;
    const other = vec ? getEmbedding(target, c.id) : null;
    const sim = vec && other ? cosine(vec, other) : null;
    return mergeTriggered(
      { content, topic: memory.topic ?? null },
      { content: c.content, topic: c.topic ?? null },
      sim,
    );
  });
  let merged = 0;
  const mergeAsk: ReviewItem[] = [];
  if (mergeCandidates.length && j.meta.status !== "unavailable") {
    try {
      const scores = await adapter.judgeMerge(memory, mergeCandidates);
      if (scores.meta.status === "ok") {
        for (const c of mergeCandidates) {
          const same = scores.get(c.id) ?? 0;
          if (same >= MERGE_AUTO_ABOVE) {
            // 保留用户原话：把一条模型转述的并进用户的话里，不该反过来 —— 否则存活下来
            // 的是模型的重述，用户的原话反而被标成已取代（保下来的文字就不对了）。
            const keepUser = memory.origin === "agent" && c.origin === "user";
            const keepId = keepUser ? c.id : memory.id;
            const dropId = keepUser ? memory.id : c.id;
            mergeMemories(target, keepId, dropId, `引擎判定是同一件事（${same.toFixed(2)}）`);
            merged++;
          } else if (same >= MERGE_ASK_ABOVE) {
            // 中间档问用户（不自动合并）。返回的项要带出去，否则调用方不知道要弹这一条。
            mergeAsk.push(...queueMerge(target, memory, c, same));
          }
        }
      }
    } catch {
      /* 合并判不了就不合并：合错了不可逆 */
    }
  }

  if (j.relation.choice !== "none" && j.targetId) {
    addRelation(target, memory.id, j.targetId, j.relation.choice, j.relation.confidence);
    // 被比的那条在哪个库：作用域硬过滤是按库拆的，调 trust 得调对库。
    const old = candidates.find((c) => c.id === j.targetId);
    const oldDb = old?.scope === "global" ? globalDb : projectDb;

    // trust 的涨跌就靠这两件**可观测**的事，不靠引擎打分：
    //   extends     用户后来在同一个话题上说话，又没推翻它  = 默许 → 升 0.1，封顶 TRUST_CAP
    //   contradicts 撞上反证                              = 降 0.2
    // 只对 agent 来源的记忆动 —— 用户自己的话 trust 本来就是 1.0，没什么可升的。
    // 注意 contradicts 这里**只降不删**：哪条对得人来判（下面那个分支把它排进待确认队列）。
    if (old?.origin === "agent") {
      const delta = j.relation.choice === "extends" ? 0.1 : j.relation.choice === "contradicts" ? -0.2 : 0;
      const next = delta ? adjustTrust(oldDb, j.targetId, delta, TRUST_CAP) : null;
      if (next !== null) {
        addTrace(oldDb, {
          memoryId: j.targetId, stage: "governance", gate: "J3-trust", action: "trust",
          targetId: memory.id, reason: `${j.relation.choice}：trust ${delta > 0 ? "+" : ""}${delta} → ${next.toFixed(2)}`,
          confidence: j.relation.confidence, status: j.meta.status,
        });
      }
    }

    // §6 的「>0.8 直接执行」：**取代**够确信就把旧那条标掉，否则两条并存的记忆
    // 会同时在库里，召回给哪条看运气（贪吃蛇 demo 验出来的：音效「不做」和「加上」
    // 一度并存）。冲突（contradicts）不自动执行 —— 哪条对得人来判。
    if (j.relation.choice === "supersedes" && j.relation.confidence >= RELATION_AUTO_BELOW) {
      setState(oldDb, j.targetId, "superseded");
      addTrace(oldDb, {
        memoryId: j.targetId, stage: "governance", gate: "J3", action: "superseded",
        reason: `被更新的记忆取代（置信度 ${j.relation.confidence.toFixed(2)}）`,
        status: j.meta.status, confidence: j.relation.confidence,
      });
    }
  }

  // 主题一律由**提炼层那个模型**定（它在生成 summary 的同一次调用里给名字，提示词里带了项目名 +
  // 已有主题，并要求优先复用）。引擎的 J4 降为兜底：它只能在已有主题里挑，不是生成。
  // 两者都直接落库，不问用户；碎出来的同义词由「近义堆」兜底合并（一键合、可回滚）。
  let effectiveTopic = input.refinement?.topic ?? j.topic ?? null;
  // 两条路都没名字时，让提炼层现场生成一个（用户侧的记忆只能走这条：引擎不许造词，
  // 而 J4 又只能在**已有**主题里挑）。拿不到就留空，不影响这条记忆落库。
  if (!effectiveTopic && input.topicProposer) {
    try {
      effectiveTopic = await input.topicProposer(memory.content);
    } catch {
      /* 提议失败不影响写入 */
    }
    if (effectiveTopic) {
      addTrace(target, {
        memoryId: memory.id, stage: "write", gate: "refine", action: "topic",
        reason: `主题由提炼层现场生成：「${effectiveTopic}」`, status: "ok",
      });
    }
  }
  if (effectiveTopic) setTopic(target, memory.id, effectiveTopic);
  // 返回值也要反映刚落下去的主题，否则调用方（/memory、轨迹）看到的是「没主题」。
  if (effectiveTopic) memory.topic = effectiveTopic;

  // 引擎不确定的事（§6 的 <0.5 档）和「看着是同一件事」（§9.3 合并）排进待确认队列。
  // 这里只提议、不动数据 —— 判不了就交给用户，别让污染记忆自己沉淀下去。
  const review = [
    ...queueAfterWrite(target, memory, candidates, j.relation, j.targetId, j.meta.status !== "ok"),
    // J14b：引擎说 global 但我们收窄了 → 问用户要不要放宽（本地版不做 LLM 复核，就问用户）
    ...queueScopeWidening(target, memory, j.scope.choice),
    ...mergeAsk,
  ];

  if (foreign) {
    // 跨项目写入：两边的库里都留痕，谁在哪个项目里改的、因为什么，以后查得到。
    addTrace(projectDb, {
      memoryId: memory.id, stage: "governance", gate: "J17-scope", action: "cross_write",
      reason: `写进了项目 ${j.ownerProject} 的库（本会话在 ${session.projectId}）`,
      status: j.meta.status,
    });
  }
  addTrace(target, {
    memoryId: memory.id, stage: "write", gate: j.meta.gate, action: "keep",
    targetId: j.targetId, reason: `${j.type.choice}/${j.scope.choice} → ${resolved.scope}（${j.type.confidence.toFixed(2)}/${j.scope.confidence.toFixed(2)}，候选 ${candidates.length}）`,
    confidence: j.worthKeeping.noul, status: j.meta.status,
    fallbackUsed: j.meta.fallbackUsed, latencyMs: j.meta.latencyMs,
    route: resolved.route,
  });

  return { action: "stored", memory, review, status: j.meta.status, merged };
}
