/**
 * JEV 不可用时的规则兜底（DESIGN.md §6 的 RuleAdapter 一侧）。
 *
 * 为什么需要它：本机 api.typesafe.ai 直连被掐，代理也会抖。JEV 挂掉不能让
 * 整个记忆系统跟着挂。这里的规则故意写得笨 —— 它的职责只是「别让系统停摆」，
 * 不是替代 JEV 的判断质量。
 */

import type { MemoryNode, MemoryScope, MemoryType, Relation } from "../core/types.ts";
import type { ChoiceResult, NoulResult } from "./types.ts";

/** 明确要求长期记住的信号。来自既有实践里验证过的词表，含否定守卫。 */
const REMEMBER = /(记住|记一下|记下来|remember this)/i;
/** 疑问句里的「记住」不是要求记住：「我为啥要记住」被误判过。 */
const REMEMBER_QUESTION = /(为啥|为什么|怎么会|难道|是不是|要不要|该不该|能不能|是否|需要|不用|不需要)[^。！？?!]{0,16}(记住|记一下|记下来)/;

const CORRECTION = /(不对|不是这样|错了|应该改成|别再|不要用|以后都|都用|改用)/;
const DECISION = /(决定|采用|就用这个|方案定了|就这么办)/;
const PREFERENCE = /(我一般|我习惯|我通常|我喜欢|我不喜欢|我讨厌|最好|尽量|默认用|统一用|一律|只能用|必须)/;

export function ruleWorthKeeping(text: string): NoulResult {
  if (REMEMBER.test(text) && !REMEMBER_QUESTION.test(text)) return { noul: 0.9 };
  if (CORRECTION.test(text) || DECISION.test(text)) return { noul: 0.75 };
  if (PREFERENCE.test(text)) return { noul: 0.6 };
  return { noul: 0.2 };
}

export function ruleType(text: string): ChoiceResult<MemoryType> {
  const pick = (choice: MemoryType, p: number): ChoiceResult<MemoryType> => ({
    choice,
    confidence: p,
    probabilities: { fact: 0, preference: 0, event: 0, procedure: 0, emotion: 0, relation: 0, [choice]: p },
  });
  if (CORRECTION.test(text)) return pick("event", 0.5);
  if (DECISION.test(text)) return pick("fact", 0.5);
  if (PREFERENCE.test(text)) return pick("preference", 0.6);
  return pick("event", 0.3);
}

/** 偏好跨项目，其余归当前项目。 */
export function ruleScope(type: MemoryType): ChoiceResult<MemoryScope> {
  const choice: MemoryScope = type === "preference" ? "global" : type === "emotion" ? "session" : "project";
  return { choice, confidence: 0.4, probabilities: { global: 0, project: 0, session: 0, [choice]: 0.4 } };
}

/** 没有 JEV 时不做语义冲突判断，一律新建 —— 并存比误删安全（§6.1 fail-open）。 */
export function ruleRelation(): ChoiceResult<Relation> {
  return { choice: "none", confidence: 0, probabilities: { none: 1 } };
}

/** 话题没变吗（二字组重叠）。放在规则层：规则档用它当 J5 的兑底，模型档不靠它。 */
export function sameTopic(a: string, b: string, overlapAtLeast = 0.6): boolean {
  if (!a || !b) return false;
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.size === 0 || y.size === 0) return false;
  let hit = 0;
  for (const g of x) if (y.has(g)) hit++;
  return hit / x.size >= overlapAtLeast;
}

/**
 * 提问的二字组被这段文字覆盖了多少（0–1）。本地、免费、对中文有效。
 *
 * 为什么单独抽出来：它是**粗筛**（决定 20 条候选里谁能进来）唯一能用的字面信号。
 * FTS5 那条路对中文近乎失效（trigram 要 3 个字连续，`影子太黑` 匹配不到 `影子强度`），
 * 而这一个在候选集合上直接算，不受索引分词器限制。注意它只适合**排序**，不适合定阈值：
 * 用 Set 求交是「有没有」，不是「像不像」。
 */
export function bigramCoverage(query: string, text: string): number {
  const q = bigrams(query);
  if (q.size === 0) return 0;
  const t = bigrams(text);
  let hit = 0;
  for (const g of q) if (t.has(g)) hit++;
  return hit / q.size;
}

/**
 * 关键词兜底的相关性。FTS5 的 trigram 分词器对中文是字符三元组匹配，
 * 「影子太黑」匹配不到「影子强度」（没有共同三字组，见 DESIGN.md §7.3），
 * 所以这里用 2 字滑窗求交，比 trigram 宽一点。
 */
export function ruleRelevance(query: string, memory: MemoryNode): number {
  const ratio = bigramCoverage(query, memory.content + " " + (memory.summary ?? ""));
  // 重要度高一点的实际记忆也算相关，避免兜底时一条都召不回来。
  return Math.min(1, ratio * 1.5 + memory.importance * 0.2);
}

/**
 * 两个字符串之间最长的「连续二字组」片段长度（直觉上是最长公共子串，按二字组算）。
 *
 * 不能用 bigrams()：它返回 Set，去重后顺序就没了，最长片段会被截短
 * （实测「一个模块一个提交」只剩 3）。所以这里用保留重复的序列版本。
 */
export function longestSharedRun(a: string, b: string): number {
  const x = bigramSeq(a);
  const y = bigramSeq(b);
  if (x.length === 0 || y.length === 0) return 0;
  let best = 0;
  let prev = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array<number>(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) {
      if (x[i - 1] === y[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/** 二字组序列：保留重复和顺序（longestSharedRun 需要）。 */
export function bigramSeq(s: string): string[] {
  const clean = s.replace(/[\s\p{P}\p{S}]/gu, "");
  const out: string[] = [];
  for (let i = 0; i + 2 <= clean.length; i++) out.push(clean.slice(i, i + 2));
  return out;
}

export function bigrams(s: string): Set<string> {
  const clean = s.replace(/[\s\p{P}]/gu, "");
  const out = new Set<string>();
  for (let i = 0; i + 2 <= clean.length; i++) out.add(clean.slice(i, i + 2));
  return out;
}
