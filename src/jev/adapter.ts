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
import { JevHttpClient, JevUnavailableError, type Answer, type Questions } from "./http.ts";
import { ruleRelation, ruleRelevance, ruleScope, ruleType, ruleWorthKeeping } from "./rule.ts";
import type { InjectionJudgment, Judged, NoulResult, RecallJudgment, WriteJudgment } from "./types.ts";

/**
 * 交给 JEV 的候选上限。实测（DESIGN.md §4.1）：20 条时区分度最好
 * （相关 0.85/0.70 vs 无关 0.03/0.02），68 条时最该命中的只给 0.51 —— 排名会糊。
 * 所以多路召回的目标是压到 20 条以内，不是召回越多越好。
 */
export const MAX_CANDIDATES = 20;

export interface JevAdapter {
  /** J1 + J2 + J3，一次调用。 */
  judgeWrite(content: string, context: string, candidates: MemoryNode[]): Promise<Judged<WriteJudgment>>;
  /** J5。 */
  judgeRecallNeed(utterance: string, session: SessionInfo): Promise<Judged<NoulResult>>;
  /** J7。 */
  judgeRelevance(query: string, candidates: MemoryNode[]): Promise<Judged<RecallJudgment>>;
  /** J8。query 必须传进来 —— J8 问的是「这条记忆对**眼下这件事**有没有用」，
   *  没有 query 的话 JEV 只能拿着一段孤立的候选列表瞎猜（实测：把�ype影那条判成了 skip，
   *  反而把不相关的小车点表判成 inject）。 */
  judgeInjection(query: string, candidates: MemoryNode[], budget: TokenBudget): Promise<Judged<InjectionJudgment>>;
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

export function createJevAdapter(client: JevHttpClient): JevAdapter {
  return {
    async judgeWrite(content, context, candidates): Promise<Judged<WriteJudgment>> {
      const t0 = Date.now();
      const state =
        `NEW CONTENT:\n${content}\n\n` +
        `CONVERSATION CONTEXT:\n${context.slice(0, 2000)}\n\n` +
        `EXISTING MEMORIES (numbered by id):\n${candidateBlock(candidates) || "(none)"}`;

      const questions: Questions = {
        worth_keeping: {
          type: "noul",
          instructions: "The NEW CONTENT contains something durable worth remembering across sessions (a decision, a correction, a preference, a project fact), not small talk or transient status",
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
      };

      try {
        // 写入路径可以慢一点，但必须成功：多给时间并重试一次。
        // 实测冷启动第一个请求会莫名卡死（见 http.ts 的说明）。
        const res = await client.ask(state, questions, { timeoutMs: 8000, retries: 1 });
        const type = choiceOf(res.answers.memory_type, MEMORY_TYPES) as MemoryType | null;
        const scope = choiceOf(res.answers.memory_scope, ["global", "project", "session"]) as MemoryScope | null;
        const relation = choiceOf(res.answers.relation, ["none", "extends", "supersedes", "contradicts"]) as Relation | null;
        const target = choiceOf(res.answers.target, ["none", ...candidates.map((m) => m.id)]);

        return {
          worthKeeping: { noul: num(res.answers.worth_keeping, "noul") },
          type: { choice: type ?? "event", confidence: confidenceOf(res.answers.memory_type), probabilities: probabilitiesOf(res.answers.memory_type) },
          scope: { choice: scope ?? "project", confidence: confidenceOf(res.answers.memory_scope), probabilities: probabilitiesOf(res.answers.memory_scope) },
          relation: { choice: relation ?? "none", confidence: confidenceOf(res.answers.relation), probabilities: probabilitiesOf(res.answers.relation) },
          targetId: relation && relation !== "none" && target && target !== "none" ? target : null,
          meta: okMeta("J1+J2+J3", res, questions, t0),
        };
      } catch (e) {
        // fail-open：守不住判断，但不能丢记忆。
        const type = ruleType(content);
        const scope = ruleScope(type.choice);
        return {
          worthKeeping: ruleWorthKeeping(content),
          type, scope, relation: ruleRelation(), targetId: null,
          meta: degradation("J1+J2+J3", e, t0, "JEV 不可用，已按规则写入"),
        };
      }
    },

    async judgeRecallNeed(utterance, _session): Promise<Judged<NoulResult>> {
      const t0 = Date.now();
      const questions: Questions = {
        need_recall: {
          type: "noul",
          instructions: "Answering this request would benefit from the user's stored long-term memory about this project or their preferences",
        },
      };
      try {
        const res = await client.ask(utterance, questions);
        return {
          noul: num(res.answers.need_recall, "noul"),
          meta: okMeta("J5", res, questions, t0),
        };
      } catch (e) {
        // 本地规则兜底：太短的输入不值得查（"继续"、"好"）。
        const noul = utterance.replace(/\s+/g, "").length >= 15 ? 0.5 : 0;
        return { noul, meta: degradation("J5", e, t0, "JEV 不可用，按长度规则判断") };
      }
    },

    async judgeRelevance(query, candidates): Promise<Judged<RecallJudgment>> {
      const t0 = Date.now();
      const capped = candidates.slice(0, MAX_CANDIDATES);
      const relevance = new Map<string, number>();

      if (capped.length === 0) {
        return { relevance, meta: { gate: "J7", fallbackUsed: "none", status: "ok", latencyMs: 0 } };
      }

      const state =
        `CURRENT REQUEST:\n${query}\n\n` +
        `CANDIDATE MEMORIES:\n${candidateBlock(capped)}`;
      const questions: Questions = Object.fromEntries(
        capped.map((m) => [
          `rel_${m.id}`,
          {
            type: "noul" as const,
            instructions: `Memory [${m.id}] is relevant and useful for answering the CURRENT REQUEST`,
          },
        ]),
      );

      try {
        // 召回/注入在 before_agent_start 里，宁可不注入也不能拖住用户：短超时、不重试。
        const res = await client.ask(state, questions, { timeoutMs: 2500 });
        for (const m of capped) relevance.set(m.id, num(res.answers[`rel_${m.id}`], "noul"));
        return {
          relevance,
          meta: okMeta("J7", res, questions, t0),
        };
      } catch (e) {
        // fail-degraded：少召回几条可以，一条都不召回不行。
        for (const m of capped) relevance.set(m.id, ruleRelevance(query, m));
        return { relevance, meta: degradation("J7", e, t0, "JEV 不可用，已退回关键词打分") };
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
        const res = await client.ask(state, questions, { timeoutMs: 2500 });
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
