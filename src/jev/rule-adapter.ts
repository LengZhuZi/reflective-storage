/**
 * 纯规则判断引擎 —— 不带任何模型、不联网、不需要 key。
 *
 * 为什么必须有它：这是「零配置就能用」的默认档。没有模型时如果每个 gate 都按
 * 「不可用」处理，注入会 fail-closed，于是表现就是「装了什么都没发生」——
 * 对别的 pi 用户来说等于没这个扩展。所以规则引擎不是兜底，是一个正式档位。
 *
 * 代价要写明白：
 *   - J3 不做语义冲突检测，一律新建（并存比误删安全，§6.1）。版本链、矛盾检测没有。
 *   - J2 的类型/作用域是关键词规则，颗粒度粗于模型。
 *   - 分数尺度比 JEV 低，所以 relevanceThreshold 也低（§10.1 的 0.7 是 JEV 的标定值）。
 */

import type { TokenBudget } from "../core/types.ts";
import { ruleRelevance, ruleRelation, ruleScope, ruleType, ruleWorthKeeping, sameTopic } from "./rule.ts";
import type { JevAdapter } from "./adapter.ts";

/** 规则分需要的阈值。JEV 的 0.7 是在 JEV 自己的分数尺度上标定的，移到规则上会全被卡掉。 */
export const RULE_RELEVANCE_THRESHOLD = 0.5;

/** 这一档自己知道自己是规则，不是降级，所以 status 一律 ok（§6.1 的降级是给「失败」用的）。 */
const meta = (gate: string) => ({
  gate, fallbackUsed: "rule" as const, status: "ok" as const, latencyMs: 0, model: "rules",
});

export function createRuleAdapter(relevanceThreshold: number = RULE_RELEVANCE_THRESHOLD): JevAdapter {
  return {
    relevanceThreshold,

    async judgeWrite(content) {
      const type = ruleType(content);
      return {
        worthKeeping: ruleWorthKeeping(content),
        type,
        scope: ruleScope(type.choice),
        // 没有模型就没法判断语义冲突，一律新建 —— 并存比误删安全（§6.1）。
        relation: ruleRelation(),
        targetId: null,
        meta: meta("J1+J2+J3(rules)"),
      };
    },

    async judgeRecallNeed(utterance, session) {
      // 规则档只能判一件事：「这个提问是不是刚才那件事」。
      // 「太短不查」由调用方的本地预判负责（§10.4），不在这里重复，
      // 否则两条长度阈值会各自漂移（真踩过：这里写 15、预判写 6）。
      const same = session.lastInjectedQuery ? sameTopic(utterance, session.lastInjectedQuery) : false;
      return { noul: same ? 0 : 0.6, meta: meta("J5(rules)") };
    },

    async judgeRelevance(query, candidates) {
      return { relevance: new Map(candidates.map((m) => [m.id, ruleRelevance(query, m)])), meta: meta("J7(rules)") };
    },

    async judgeInjection(query, candidates, budget: TokenBudget) {
      // 没有模型时也必须注得进去，否则这一档就是「装了个寂寞」。但分数不到位仍然
      // 不注入：注入是 fail-closed 的那一层，沉默优于噪声（§6.1）。
      const decisions = new Map<string, "inject" | "skip">();
      let used = 0;
      for (const m of [...candidates].sort((a, b) => ruleRelevance(query, b) - ruleRelevance(query, a))) {
        const cost = estimateTokens(m.content);
        if (ruleRelevance(query, m) < relevanceThreshold || used + cost > budget.maxTokens) {
          decisions.set(m.id, "skip");
          continue;
        }
        used += cost;
        decisions.set(m.id, "inject");
      }
      return { decisions, meta: meta("J8(rules)") };
    },
  };
}

/** 与 pipeline/inject.ts 的估算保持一致（不 import 它，避免 jev 层反向依赖 pipeline 层）。 */
function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (ch >= "\u3400" && ch <= "\u9fff") cjk++;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}
