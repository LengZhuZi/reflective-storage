/**
 * J15 轻量反馈的「事后核对」：这一轮注入的记忆，到底有没有被用上（DESIGN.md §4 / §7.1）。
 *
 * 为什么这个信号值钱：没有它，召回阈值、注入上限、J8 的松紧全是拍脑袋 —— 库里攒了
 * 几百条「注入了什么」，却不知道哪次真起了作用，就没法调。
 *
 * 为什么用「原文片段复用」而不是让引擎判：判一次要一次 API 调用，而这件事每轮都要做。
 * 引擎判「模型有没有用上这条记忆」的正确率也未必比字符串比对高多少。所以这里只认
 * 明确信号：回复里出现了该记忆的**连续 4 个以上二字组**（约 5 个字以上的原样片段）。
 *
 * 这必然漏掉「模型换了个说法」的情况 —— 所以它只当**下限**用：cited 标记的是确凿用上的，
 * 没标的只说明「没找到确凿证据」，不等于没用上。字段名保持 cited_ids，含义写在这里。
 */


import type { OpenedDb } from "../storage/db.ts";
import { getMemory, latestRecallWithInjection, updateRecallOutcome } from "../storage/db.ts";

/**
 * 二字组**序列**（保留重复和顺序）。
 *
 * 不能用 rule.ts 的 bigrams()：它返回 Set，去重之后顺序信息就没了，最长连续片段
 * 会被截短（实测「一个模块一个提交」只剩 3，因为它算的是集合）。
 */
function bigramSeq(s: string): string[] {
  const clean = s.replace(/[\s\p{P}\p{S}]/gu, "");
  const out: string[] = [];
  for (let i = 0; i + 2 <= clean.length; i++) out.push(clean.slice(i, i + 2));
  return out;
}

/** 连续命中的二字组个数下限。4 个 ≈ 5 个字以上的原样片段。 */
export const MIN_CITED_RUN = 4;

/**
 * 两个字符串之间最长的「连续二字组」run 长度。
 * 直觉上就是最长公共子串，只是按二字组算 —— 这样对中文分词误差不那么敏感。
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

export interface FeedbackOutcome {
  recalled: number;
  injected: number;
  cited: string[];
  /** cited / injected，注入 0 条时是 null（没发生的事不该给分）。 */
  effectScore: number | null;
}

/**
 * 把「这一轮助手说了什么」对上「上一轮注入过什么」。
 * 找不到带注入的召回记录就直接返回空 —— 大多数轮次本来就没注入过。
 */
export function closeFeedbackLoop(o: OpenedDb, sessionId: string, reply: string): FeedbackOutcome {
  const empty: FeedbackOutcome = { recalled: 0, injected: 0, cited: [], effectScore: null };
  // 没有回复就不做核对：空字符串跟谁都对不上，拿它去覆盖上一轮的核对结果等于报假账。
  // （真 pi 里 agent_end 总有助手消息，但重试/中断的轮次可能没有。）
  if (!reply.trim()) return empty;
  const log = latestRecallWithInjection(o, sessionId);
  if (!log) return empty;

  const injected = JSON.parse(String(log.injected_ids)) as string[];
  const recalled = (JSON.parse(String(log.recalled_ids)) as string[]).length;
  const cited = injected.filter((id) => {
    const m = getMemory(o, id);
    return m ? longestSharedRun(m.content, reply) >= MIN_CITED_RUN : false;
  });

  const effectScore = injected.length === 0 ? null : cited.length / injected.length;
  updateRecallOutcome(o, String(log.id), cited, effectScore);
  return { recalled, injected: injected.length, cited, effectScore };
}
