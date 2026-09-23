/**
 * 反思层：把每个 gate 变成一次 JEV 调用，并把失败姿态写死在这里。
 *
 * 失败姿态（DESIGN.md §6.1）是这套设计里最容易写错的地方 —— 每个阶段的正确
 * 姿态都不一样，而且必须在这里统一，不能让调用方各自决定：
 *
 *   写入   fail-open     JEV 挂了照存，标 status='unavailable'。丢记忆 > 存噪声
 *   召回   fail-degraded 退回关键词排序，标 'degraded'。少召回可以，不召回不行
 *   注入   fail-closed   不注入，标 'unavailable'。沉默优于噪声
 *
 * 另一个核心约束：一次判断合并成一次 API 调用。实测 3 问 0.99s、20 问 0.97s，
 * 加问题几乎不加延迟也不加多少 token。
 */

import { MEMORY_TYPES, type MemoryNode, type MemoryScope, type MemoryType, type Relation, type SessionInfo, type TokenBudget } from "../core/types.ts";
import type { JudgeConfig } from "../config.ts";
import { JevHttpClient, JevUnavailableError, type AskOptions, type Answer, type JevResponse, type Questions } from "./http.ts";
import { LlmClient } from "./llm.ts";
import { createRuleAdapter, RULE_RELEVANCE_THRESHOLD } from "./rule-adapter.ts";
import { ruleRelation, ruleRelevance, ruleScope, ruleType, ruleWorthKeeping, sameTopic } from "./rule.ts";
import type {
  CitationJudgment, InjectionJudgment, Judged, NoulResult, ProactiveJudgment, RecallJudgment, WriteJudgment,
} from "./types.ts";

/**
 * 判断引擎只需要这一个方法。JEV HTTP 和任何 OpenAI 兼容端点（见 llm.ts）都满足它，
 * 所以「换引擎」= 换一个 client，下面的流程、失败姿态、留痕一行都不用改。
 */
export interface JudgeClient {
  ask(state: string, questions: Questions, opts?: AskOptions): Promise<JevResponse>;
}

/**
 * 交给 JEV 的候选上限。实测（DESIGN.md §4.1）：20 条时区分度最好
 * （相关 0.85/0.70 vs 无关 0.03/0.02），68 条时最该命中的只给 0.51 —— 排名会糊。
 * 所以多路召回的目标是压到 20 条以内，不是召回越多越好。
 */
export const MAX_CANDIDATES = 20;

/** J14a：global 记忆适用性低于这个就挡下（§6：<0.5 走保守策略）。 */
export const SCOPE_BLOCK_BELOW = 0.5;
/** J15：引擎判定「回复用上了这条记忆」的阈值。 */
export const CITED_BELOW = 0.5;
/** J16：主动提醒的阈值。故意高一点 —— 主动打扰错了比不打扰烦得多。 */
export const PROACTIVE_BELOW = 0.6;
/**
 * J11：引擎判定「同一件事、合并不丢信息」的阈值。实测分得很开：
 * 真重复（转述/换标点）0.96/0.97，假重复（只差一个项目名、同类不同事）0.02。
 */
export const MERGE_AUTO_ABOVE = 0.9;
/** 0.7–0.9 这一档不自动合并，问用户。 */
export const MERGE_ASK_ABOVE = 0.7;

/** 交给 createJevAdapter 的时间预算。本地模型比 JEV 慢一个量级，所以这两个值可以调。 */
export interface JudgeTimeouts {
  /** 交互路径（J5/J7/J8，在 before_agent_start 里）。宁可不注入，也不能拖住用户。 */
  interactiveTimeoutMs?: number;
  /** 写入路径（J1/J2/J3，在 agent_end 里）。质量比延迟重要，且必须成功。 */
  writeTimeoutMs?: number;
  /** 这个引擎的相关性阈值。缺省 0.7（JEV 的标定值）。 */
  relevanceThreshold?: number;
}

export interface JevAdapter {
  /**
   * 这个引擎自己的相关性阈值（§10.1 的 >0.7 是 JEV 的标定值，不是通用真理）。
   * 规则引擎和本地小模型的分数尺度完全不同，拿 0.7 去卡它们会把候选全卡光。
   */
  readonly relevanceThreshold: number;
  /** J1 + J2 + J3 + J4，一次调用。`topics` 是现有主题，引擎只能在里面选。 */
  judgeWrite(content: string, context: string, candidates: MemoryNode[], topics?: readonly string[]): Promise<Judged<WriteJudgment>>;
  /** J5。 */
  judgeRecallNeed(utterance: string, session: SessionInfo): Promise<Judged<NoulResult>>;
  /** J7 + J14a（global 记忆在当前项目适不适用，边界才问）。`projectId` 给边界判断用。 */
  judgeRelevance(query: string, candidates: MemoryNode[], opts?: { projectId?: string }): Promise<Judged<RecallJudgment>>;
  /** J8。query 必须传进来 —— J8 问的是「这条记忆对**眼下这件事**有没有用」，
   *  没有 query 的话 JEV 只能拿着一段孤立的候选列表瞎猜（实测：把�ype影那条判成了 skip，
   *  反而把不相关的小车点表判成 inject）。 */
  judgeInjection(query: string, candidates: MemoryNode[], budget: TokenBudget): Promise<Judged<InjectionJudgment>>;
  /**
   * J11 合并：这条候选和新记的这条是不是**同一件事**，合并会不会丢信息。
   * 返回 memoryId → 0–1。**只有引擎能判** —— 实测：只差一个项目名的两条
   * （alpha/beta 的影子算法）余弦相似度 0.953，比真重复（模型转述 0.797）还高。
   */
  judgeMerge(memory: MemoryNode, candidates: MemoryNode[]): Promise<Judged<Map<string, number>>>;
  /** J15：回复里到底用上了哪几条注入的记忆。没有引擎时退回字符串比对（见 feedback.ts）。 */
  judgeCitations(reply: string, injected: MemoryNode[]): Promise<Judged<CitationJudgment>>;
  /**
   * J16 主动召回：用户没问，但这条记忆他现在就该知道吗（§4）。
   * 降级策略是**关闭** —— 判不了就不打扰（主动打扰错了比不打扰更烦）。
   */
  judgeProactive(context: string, candidates: MemoryNode[]): Promise<Judged<ProactiveJudgment>>;
}

const num = (a: Answer | undefined, key: "noul" | "score"): number =>
  a && key in a && typeof (a as Record<string, unknown>)[key] === "number"
    ? ((a as unknown as Record<string, number>)[key])
    : 0;

const choiceOf = (a: Answer | undefined, allowed: readonly string[]): string | null => {
  if (!a || a.type !== "choice") return null;
  return allowed.includes(a.choice) ? a.choice : null;
};

const confidenceOf = (a: Answer | undefined): number =>
  a && a.type !== "noul" && typeof a.confidence === "number" ? a.confidence : 0;

/** 概率分布要带出来：§6 的置信度分级和 /memory 排查都靠它，空对象等于把信息丢了。 */
const probabilitiesOf = (a: Answer | undefined): Record<string, number> =>
  a && a.type !== "noul" && a.probabilities && typeof a.probabilities === "object" ? a.probabilities : {};

function candidateBlock(candidates: MemoryNode[]): string {
  return candidates.map((m, i) => `[${m.id}] (${m.type}) ${m.content}`).join("\n");
}

/**
 * 校验返回的答案数量和类型对不对。
 *
 * 为什么需要：200 响应里少了几个答案时，下面的解析会把它们默默当成 0 —— 于是
 * 「JEV 说无关」和「API 没返回」变成同一个结果，这正是 §6.2 要避免的分不清。
 * 缺答案 → status='degraded'（判断不完整），和 status='unavailable'（根本没连上）分开。
 */
function missingAnswers(answers: Record<string, Answer>, questions: Questions): string[] {
  const missing: string[] = [];
  for (const [key, q] of Object.entries(questions)) {
    const a = answers[key];
    if (!a || a.type !== q.type) missing.push(key);
  }
  return missing;
}

function okMeta(gate: string, res: { model: string; usage: { input_tokens: number; output_tokens: number }; answers: Record<string, Answer> }, questions: Questions, t0: number) {
  const missing = missingAnswers(res.answers, questions);
  return {
    gate,
    fallbackUsed: "none" as const,
    status: (missing.length ? "degraded" : "ok") as "degraded" | "ok",
    model: res.model,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    latencyMs: Date.now() - t0,
    detail: missing.length ? `响应缺少 ${missing.length} 个答案: ${missing.slice(0, 5).join(",")}` : undefined,
  };
}

export function createJevAdapter(client: JudgeClient, opts: JudgeTimeouts = {}): JevAdapter {
  // 交互路径（在 before_agent_start 里）宁可不注入也不能拖住用户；写入路径可以慢，
  // 但必须成功。本地模型比 JEV 慢一个量级，所以这两个值可以从 config 调大。
  const fast = opts.interactiveTimeoutMs ?? 2500;
  const slow = opts.writeTimeoutMs ?? 8000;
  return {
    relevanceThreshold: opts.relevanceThreshold ?? 0.7,

    async judgeWrite(content, context, candidates, topics = []): Promise<Judged<WriteJudgment>> {
      const t0 = Date.now();
      const state =
        `NEW CONTENT:\n${content}\n\n` +
        `CONVERSATION CONTEXT:\n${context.slice(0, 2000)}\n\n` +
        `EXISTING MEMORIES (numbered by id):\n${candidateBlock(candidates) || "(none)"}`;

      const questions: Questions = {
        worth_keeping: {
          type: "noul",
          instructions: "The NEW CONTENT contains something durable worth remembering across sessions (a decision, a correction, a preference, a project fact), not small talk or transient status. A question or a request addressed to the assistant is NOT a memory, even when it mentions the project — only durable statements about the user, the project or how work should be done count",
        },
        memory_type: {
          type: "choice",
          // 候选列表是给 relation 那一问用的。不加这句，JEV 会拿候选的作用域去锚定
          // 类型/作用域判断（实测：库里有 1 条 project 记忆时，一句「我一般喜欢…」被
          // 判成 project；没有候选时同句给 global 0.99）。
          instructions: "Which class of memory is the NEW CONTENT. Judge this from the NEW CONTENT alone — the EXISTING MEMORIES are listed only for the relation question",
          criteria: {
            fact: "A stable piece of knowledge, decision or project convention: how this project or system works. Includes a correction to an earlier decision or a rule about how this project does things",
            preference: "A lasting preference of the user themselves about how they want work done in general (tone, length, language, tools), not a rule about this project",
            event: "Something that happened: a bug, a fix, a change, a session outcome",
            procedure: "Steps to accomplish something",
            emotion: "The user's mood or attitude, not durable knowledge",
            relation: "A dependency or connection between two things",
          },
        },
        memory_scope: {
          type: "choice",
          instructions: "How widely should this memory apply. Judge this from the NEW CONTENT alone — the EXISTING MEMORIES are listed only for the relation question",
          criteria: {
            global: "True for this user in every project: what the user themselves prefers, or a convention they follow everywhere",
            project: "True only inside the current project: how this codebase or system works, and decisions about it",
            session: "True only right now: temporary state of the current session",
          },
        },
        relation: {
          type: "choice",
          instructions: "How does the NEW CONTENT relate to the EXISTING MEMORIES above",
          criteria: {
            none: "Unrelated, or there are no existing memories to compare with",
            extends: "Adds information to an existing memory on the same topic",
            supersedes: "Replaces an existing memory because the earlier statement is no longer true",
            contradicts: "Conflicts with an existing memory and both cannot be true",
          },
        },
        target: {
          type: "choice",
          instructions: "If the NEW CONTENT extends, supersedes or contradicts an existing memory, which one",
          criteria: Object.fromEntries([["none", "No existing memory, or relation is none"], ...candidates.map((m) => [m.id, m.content.slice(0, 120)])]),
        },
        // J4：只让引擎在**已有主题**里挑，不给它生成新词的权力（原则 1）。
        // 一个都不合适就选 none —— 之后由用户来起名（走待确认队列），系统不自己造。
        topic: {
          type: "choice",
          instructions: "Which existing topic does the NEW CONTENT belong to. Pick none if none of them fit",
          criteria: Object.fromEntries([
            ["none", "None of the existing topics fit"],
            ...topics.map((t) => [t, t]),
          ]),
        },
      };

      try {
        // 写入路径可以慢一点，但必须成功：多给时间并重试一次。
        // 实测冷启动第一个请求会莫名卡死（见 http.ts 的说明）。
        const res = await client.ask(state, questions, { timeoutMs: slow, retries: 1 });
        const type = choiceOf(res.answers.memory_type, MEMORY_TYPES) as MemoryType | null;
        const scope = choiceOf(res.answers.memory_scope, ["global", "project", "session"]) as MemoryScope | null;
        const relation = choiceOf(res.answers.relation, ["none", "extends", "supersedes", "contradicts"]) as Relation | null;
        const target = choiceOf(res.answers.target, ["none", ...candidates.map((m) => m.id)]);
        const topic = choiceOf(res.answers.topic, ["none", ...topics]);

        return {
          worthKeeping: { noul: num(res.answers.worth_keeping, "noul") },
          type: { choice: type ?? "event", confidence: confidenceOf(res.answers.memory_type), probabilities: probabilitiesOf(res.answers.memory_type) },
          scope: { choice: scope ?? "project", confidence: confidenceOf(res.answers.memory_scope), probabilities: probabilitiesOf(res.answers.memory_scope) },
          relation: { choice: relation ?? "none", confidence: confidenceOf(res.answers.relation), probabilities: probabilitiesOf(res.answers.relation) },
          targetId: relation && relation !== "none" && target && target !== "none" ? target : null,
          topic: topic && topic !== "none" ? topic : null,
          meta: okMeta("J1+J2+J3", res, questions, t0),
        };
      } catch (e) {
        // fail-open：守不住判断，但不能丢记忆。
        const type = ruleType(content);
        const scope = ruleScope(type.choice);
        return {
          worthKeeping: ruleWorthKeeping(content),
          // 规则档不猜主题（它没有判断力）：留空，等用户起名。
          type, scope, relation: ruleRelation(), targetId: null, topic: null,
          meta: degradation("J1+J2+J3", e, t0, "JEV 不可用，已按规则写入"),
        };
      }
    },

    async judgeRecallNeed(utterance, session): Promise<Judged<NoulResult>> {
      const t0 = Date.now();
      const already = session.lastInjectedQuery ?? "";
      const questions: Questions = {
        need_recall: {
          type: "noul",
          instructions: "Answering this request would benefit from the user's stored long-term memory about this project or their preferences",
        },
        // 第二次及以后的注入才需要问这句：上下文里已经有一条记忆块了，
        // 同一个话题再插一遍只是白搭前缀缓存。
        ...(already
          ? {
              new_topic: {
                type: "noul" as const,
                instructions:
                  "THIS REQUEST is about a different subject than ALREADY IN CONTEXT above. It needs its own memories rather than the ones already injected",
              },
            }
          : {}),
      };
      const state = already
        ? `ALREADY IN CONTEXT (injected earlier in this session, for this request):\n${already}\n\nNEW REQUEST:\n${utterance}`
        : utterance;
      try {
        const res = await client.ask(state, questions, { timeoutMs: fast });
        const need = num(res.answers.need_recall, "noul");
        const fresh = already ? num(res.answers.new_topic, "noul") : 1;
        return {
          // 两个问题都过才需要再召回：一个说「用得上记忆」，另一个说「不是已经在上下文里的那件事」。
          noul: Math.min(need, fresh),
          meta: { ...okMeta("J5", res, questions, t0), detail: already ? `need_recall=${need.toFixed(2)} new_topic=${fresh.toFixed(2)}` : undefined },
        };
      } catch (e) {
        // fail-degraded：本地规则兜底（太短不查、同话题不查），不能因为引擎挂了就不召回。
        const short = utterance.replace(/\s+/g, "").length < 15;
        const same = already ? sameTopic(utterance, already) : false;
        return {
          noul: short || same ? 0 : 0.5,
          meta: degradation("J5", e, t0, same ? "JEV 不可用，按同话题跳过" : "JEV 不可用，按长度规则判断"),
        };
      }
    },

    async judgeRelevance(query, candidates, opts = {}): Promise<Judged<RecallJudgment>> {
      const t0 = Date.now();
      const capped = candidates.slice(0, MAX_CANDIDATES);
      const relevance = new Map<string, number>();
      const blocked = new Set<string>();

      if (capped.length === 0) {
        return { relevance, blocked, meta: { gate: "J7", fallbackUsed: "none", status: "ok", latencyMs: 0 } };
      }

      // J14a：只对 global 记忆问边界问题（§11.1 的三个例子之一）。项目的和本会话的
      // 记忆已经被 SQL 那层门禁管住了，不需要再问；而 global 是唯一「谁都能看见、
      // 但未必都适用」的那类。多问不涨价（§5.1），跟在 J7 同一次调用里。
      const globals = capped.filter((m) => m.scope === "global");
      const state =
        `CURRENT REQUEST:\n${query}\n\n` +
        (opts.projectId ? `CURRENT PROJECT: ${opts.projectId}\n\n` : "") +
        `CANDIDATE MEMORIES:\n${candidateBlock(capped)}`;
      const questions: Questions = {
        ...Object.fromEntries(
          capped.map((m) => [
            `rel_${m.id}`,
            {
              type: "noul" as const,
              instructions: `Memory [${m.id}] is relevant and useful for answering the CURRENT REQUEST`,
            },
          ]),
        ),
        ...Object.fromEntries(
          globals.map((m) => [
            `applies_${m.id}`,
            {
              type: "noul" as const,
              instructions:
                `Memory [${m.id}] is a global memory (it is about the user rather than one codebase). It still applies to the work being discussed in the CURRENT REQUEST`,
            },
          ]),
        ),
      };

      try {
        // 召回/注入在 before_agent_start 里，宁可不注入也不能拖住用户：短超时、不重试。
        const res = await client.ask(state, questions, { timeoutMs: fast });
        for (const m of capped) relevance.set(m.id, num(res.answers[`rel_${m.id}`], "noul"));
        for (const m of globals) {
          if (num(res.answers[`applies_${m.id}`], "noul") < SCOPE_BLOCK_BELOW) blocked.add(m.id);
        }
        const meta = okMeta("J7", res, questions, t0);
        return {
          relevance,
          blocked,
          meta: blocked.size ? { ...meta, detail: `${meta.detail ? `${meta.detail}；` : ""}J14a 挡下 ${blocked.size} 条 global` } : meta,
        };
      } catch (e) {
        // fail-degraded：少召回几条可以，一条都不召回不行。
        // J14a 那一问判不了就**不挡**任何东西 —— 作用域门禁（SQL 层）还是会执行，
        // §11.3 说的「JEV 挂了隔离不能跟着失效」靠的就是那层。
        for (const m of capped) relevance.set(m.id, ruleRelevance(query, m));
        return { relevance, blocked, meta: degradation("J7", e, t0, "JEV 不可用，已退回关键词打分") };
      }
    },

    async judgeMerge(memory, candidates): Promise<Judged<Map<string, number>>> {
      const t0 = Date.now();
      const out = new Map<string, number>();
      const capped = candidates.slice(0, MAX_CANDIDATES);
      if (capped.length === 0) {
        return Object.assign(out, { meta: { gate: "J11", fallbackUsed: "none" as const, status: "ok" as const, latencyMs: 0 } });
      }
      const state = `NEW MEMORY:\n${memory.content}\n\nCANDIDATES:\n${candidateBlock(capped)}`;
      const questions: Questions = Object.fromEntries(
        capped.map((m) => [
          `same_${m.id}`,
          {
            type: "noul" as const,
            instructions:
              `The NEW MEMORY and [${m.id}] state the same thing, and merging them into one loses no ` +
              `information (no differing project, name, number, negation or condition)`,
          },
        ]),
      );
      try {
        const res = await client.ask(state, questions, { timeoutMs: fast });
        for (const m of capped) out.set(m.id, num(res.answers[`same_${m.id}`], "noul"));
        return Object.assign(out, { meta: okMeta("J11", res, questions, t0) });
      } catch (e) {
        // 判不了就不合并（fail-closed：合错了会把两条不同的记忆并成一条，不可逆）
        return Object.assign(out, { meta: degradation("J11", e, t0, "JEV 不可用，本轮不自动合并") });
      }
    },

    async judgeProactive(context, candidates): Promise<Judged<ProactiveJudgment>> {
      const t0 = Date.now();
      const remind = new Set<string>();
      if (candidates.length === 0) {
        return { remind, meta: { gate: "J16", fallbackUsed: "none", status: "ok", latencyMs: 0 } };
      }
      const state =
        `WHAT JUST HAPPENED IN THE SESSION:\n${context.slice(0, 2000)}\n\n` +
        `CANDIDATE MEMORIES (not yet used in this session):\n${candidateBlock(candidates)}`;
      const questions: Questions = {
        any_worth_reminding: {
          type: "noul",
          instructions:
            "There is at least one memory below that the user would clearly want to be reminded of right now, and would not be annoyed to see",
        },
        ...Object.fromEntries(
          candidates.map((m) => [
            `remind_${m.id}`,
            {
              type: "noul" as const,
              instructions:
                `Memory [${m.id}] is worth surfacing to the user right now: it changes what they should do or know, and they have not asked about it`,
            },
          ]),
        ),
      };
      try {
        const res = await client.ask(state, questions, { timeoutMs: fast });
        if (num(res.answers.any_worth_reminding, "noul") >= PROACTIVE_BELOW) {
          for (const m of candidates) {
            if (num(res.answers[`remind_${m.id}`], "noul") >= PROACTIVE_BELOW) remind.add(m.id);
          }
        }
        return { remind, meta: okMeta("J16", res, questions, t0) };
      } catch (e) {
        // 降级 = 关闭：主动提醒判不了就不打扰（DESIGN §4 的 J16 降级策略）
        return { remind, meta: degradation("J16", e, t0, "JEV 不可用，本轮不主动提醒") };
      }
    },

    async judgeCitations(reply, injected): Promise<Judged<CitationJudgment>> {
      const t0 = Date.now();
      const cited = new Set<string>();
      if (injected.length === 0) {
        return { cited, meta: { gate: "J15", fallbackUsed: "none", status: "ok", latencyMs: 0 } };
      }
      const state =
        `ASSISTANT REPLY (just written):\n${reply.slice(0, 3000)}\n\n` +
        `INJECTED MEMORIES:\n${candidateBlock(injected)}`;
      const questions: Questions = Object.fromEntries(
        injected.map((m) => [
          `used_${m.id}`,
          {
            type: "noul" as const,
            instructions: `The ASSISTANT REPLY was written using the content of memory [${m.id}] (the same fact or wording appears, or the reply clearly follows it)`,
          },
        ]),
      );
      try {
        const res = await client.ask(state, questions, { timeoutMs: fast });
        for (const m of injected) {
          if (num(res.answers[`used_${m.id}`], "noul") >= CITED_BELOW) cited.add(m.id);
        }
        return { cited, meta: okMeta("J15", res, questions, t0) };
      } catch (e) {
        // fail-degraded：判不了就标降级，由调用方退回字符串比对（feedback.ts 的兜底）。
        // 不在这里自己退回 —— 那会让「引擎判的」和「字符串比的」混成一个结果。
        return { cited, meta: degradation("J15", e, t0, "JEV 不可用，退回字符串比对") };
      }
    },

    async judgeInjection(query, candidates, budget): Promise<Judged<InjectionJudgment>> {
      const t0 = Date.now();
      const decisions = new Map<string, "inject" | "skip">();
      if (candidates.length === 0) {
        return { decisions, meta: { gate: "J8", fallbackUsed: "none", status: "ok", latencyMs: 0 } };
      }

      const state =
        `CURRENT TASK / REQUEST:\n${query}\n\n` +
        `TOKEN BUDGET FOR MEMORY INJECTION: ${budget.maxTokens} tokens\n\n` +
        `CANDIDATE MEMORIES:\n${candidateBlock(candidates)}`;
      const questions: Questions = Object.fromEntries(
        candidates.map((m) => [
          `inj_${m.id}`,
          {
            type: "choice" as const,
            instructions: `Memory [${m.id}] is worth putting in front of the assistant for the CURRENT TASK`,
            criteria: {
              inject: "Directly useful for the current task",
              skip: "Not useful enough to spend context on",
            },
          },
        ]),
      );

      try {
        // 同 J7：这是用户提交 prompt 后、回答前的那段等待，不能等太久。
        const res = await client.ask(state, questions, { timeoutMs: fast });
        for (const m of candidates) {
          decisions.set(m.id, choiceOf(res.answers[`inj_${m.id}`], ["inject", "skip"]) === "inject" ? "inject" : "skip");
        }
        return {
          decisions,
          meta: okMeta("J8", res, questions, t0),
        };
      } catch (e) {
        // fail-closed：判断不了就不注入。错误的记忆比没有记忆更坏。
        for (const m of candidates) decisions.set(m.id, "skip");
        return { decisions, meta: degradation("J8", e, t0, "JEV 不可用，本会话不注入记忆") };
      }
    },
  };
}

function degradation(gate: string, e: unknown, t0: number, detail: string) {
  const isUnavailable = e instanceof JevUnavailableError;
  return {
    gate,
    fallbackUsed: "rule" as const,
    status: (isUnavailable ? "unavailable" : "degraded") as "unavailable" | "degraded",
    latencyMs: Date.now() - t0,
    detail: `${detail} — ${(e as Error).message}`.slice(0, 300),
  };
}

/**
 * 引擎选择。三个档位都是正式档位，不是「主 / 备」：
 *
 *   rules   零配置、零联网、零成本。默认档 —— 装了就有用，但判断粗。
 *   jev     TypeSafe AI 的 JEV，本设计的标定基准（§4.1）。
 *   openai  任何 OpenAI 兼容 /chat/completions：DeepSeek / Ollama / LM Studio / vLLM…
 *
 * 选哪个只影响判断质量，不影响流程、失败姿态和落库格式。
 */
export function createJudgeAdapter(config: JudgeConfig, deps: { fetchImpl?: typeof fetch } = {}): JevAdapter {
  const timeouts: JudgeTimeouts = {
    interactiveTimeoutMs: config.timeoutMs,
    writeTimeoutMs: config.writeTimeoutMs,
    relevanceThreshold: config.relevanceThreshold,
  };
  switch (config.provider) {
    case "rules":
      return createRuleAdapter(config.relevanceThreshold);
    case "openai":
      return createJevAdapter(
        new LlmClient({
          baseUrl: config.baseUrl ?? "",
          apiKey: config.apiKey,
          model: config.model ?? "",
          timeoutMs: config.timeoutMs,
          fetchImpl: deps.fetchImpl,
        }),
        timeouts,
      );
    case "jev":
    default:
      return createJevAdapter(
        new JevHttpClient({
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          model: config.model,
          timeoutMs: config.timeoutMs,
          fetchImpl: deps.fetchImpl,
        }),
        timeouts,
      );
  }
}
