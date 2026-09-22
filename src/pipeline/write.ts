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

import type { MemoryNode, SessionInfo } from "../core/types.ts";
import { resolveScope } from "../core/governance.ts";
import type { JevAdapter } from "../jev/adapter.ts";
import { MAX_CANDIDATES } from "../jev/adapter.ts";
import { ruleScope } from "../jev/rule.ts";
import { embed } from "../embed/encoder.ts";
import {
  addRelation, addTrace, distinctTopics, insertMemory, putEmbedding,
  type InsertMemory, type OpenedDb,
} from "../storage/db.ts";
import { recallCandidates } from "./recall.ts";
import { queueAfterWrite, queueTopicNaming, type ReviewItem } from "./review.ts";

/** 低于这个概率就不写。实测 §4.1：明确要求记住的给出 0.86–0.89，无关内容 0.2。 */
export const KEEP_THRESHOLD = 0.5;

/** 引擎不可用时照存的那条记忆给多少重要性 —— 低到会先被衰减/归档，高到还能被召回。 */
export const FAIL_OPEN_IMPORTANCE = 0.3;

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

/** 凭据形态。落盘前必须洗掉 —— 记忆库会被注入到每一次对话里。 */
const SECRET = /(sk-[A-Za-z0-9_-]{8,}|apikey_[A-Za-z0-9_]{8,}|(?:密码|口令|password|passwd|token|secret|api[_-]?key)\s*[:=]\s*\S+)/gi;

export function redact(s: string): string {
  return s.replace(SECRET, "***");
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
  /** 供 JEV 判断用的对话上下文（可以包含助手的话，但同样要洗凭据）。 */
  context: string;
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
export function worthEvaluating(text: string): { ok: boolean; reason?: string } {
  const t = text.trim();
  if (t.length < MIN_LENGTH) return { ok: false, reason: `太短（${t.length} < ${MIN_LENGTH}）` };
  if (NOISE.test(t)) return { ok: false, reason: "纯确认/催促" };
  if (isPureQuestion(t)) {
    return { ok: false, reason: "疑问句，不是记忆" };
  }
  return { ok: true };
}

/** 把本轮的候选内容拼成一段交给 J1。多条用户消息合在一起判断，省调用。
 *  纯提问的句子（哪怕夹在陈述中间）先剔掉：它们不是记忆，还会把噪声带进注入块。 */
export function buildCandidate(input: TurnInput): string {
  return input.userTexts
    .flatMap((t) => sentences(t))
    .map((s) => redact(s.replace(/\s+/g, " ")))
    .filter((s) => s.length > 0 && !isPureQuestion(s))
    .join("\n");
}

export async function writeFlow(
  projectDb: OpenedDb,
  globalDb: OpenedDb,
  adapter: JevAdapter,
  session: SessionInfo,
  input: TurnInput,
): Promise<WriteResult> {
  const content = buildCandidate(input);
  const pre = worthEvaluating(content);
  if (!pre.ok) {
    return { action: "noise", reason: pre.reason };
  }

  // J3 需要候选：**跟这条内容最相关的**旧记忆，不是「最近入库的 20 条」。
  // 走召回那套多路召回（向量 + FTS5 + 作用域），并且带上 global 库 —— 用「最近 20 条」的话，
  // 一条很久以前的矛盾记忆永远进不了候选，冲突检测就是失灵的。
  const candidates = await recallCandidates(content, { projectDb, globalDb, session, limit: MAX_CANDIDATES });

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
  const j = await adapter.judgeWrite(content, redact(input.context), candidates, topics);

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
  const target = resolved.scope === "global" ? globalDb : projectDb;
  const insert: InsertMemory = {
    content,
    type: j.type.choice,
    scope: resolved.scope,
    topic: j.topic,
    scopeId: resolved.scope === "project" ? session.projectId : resolved.scope === "session" ? session.sessionId : null,
    // 引擎不可用时照存，但压成低重要性（见上面 fail-open 的说明）
    importance: unavailable ? FAIL_OPEN_IMPORTANCE : j.worthKeeping.noul,
    source: session.sessionId,
  };
  const memory = insertMemory(target, insert);

  // 向量是加分项：编码失败不能让写入失败（原则 2：向量层可重建）。
  try {
    putEmbedding(target, memory.id, await embed(content));
  } catch {
    /* 没有向量也不影响这条记忆的使用，只影响语义召回那一路 */
  }

  if (j.relation.choice !== "none" && j.targetId) {
    addRelation(target, memory.id, j.targetId, j.relation.choice, j.relation.confidence);
  }

  // 引擎不确定的事（§6 的 <0.5 档）和「看着是同一件事」（§9.3 合并）排进待确认队列。
  // 这里只提议、不动数据 —— 判不了就交给用户，别让污染记忆自己沉淀下去。
  const review = [
    ...queueAfterWrite(target, memory, candidates, j.relation),
    ...queueTopicNaming(target, memory, topics),
  ];

  addTrace(target, {
    memoryId: memory.id, stage: "write", gate: j.meta.gate, action: "keep",
    targetId: j.targetId, reason: `${j.type.choice}/${j.scope.choice} → ${resolved.scope}（${j.type.confidence.toFixed(2)}/${j.scope.confidence.toFixed(2)}，候选 ${candidates.length}）`,
    confidence: j.worthKeeping.noul, status: j.meta.status,
    fallbackUsed: j.meta.fallbackUsed, latencyMs: j.meta.latencyMs,
    route: resolved.route,
  });

  return { action: "stored", memory, review, status: j.meta.status };
}
