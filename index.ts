/**
 * pi 扩展入口（DESIGN.md §8.1 / §8.2）。
 *
 * 这一层只做绑定，不做判断：判断在 `src/jev`，流程在 `src/pipeline`。
 * 它的职责是把 pi 的事件接到流程上，并且**不把失败姿态抹平**（§6.1）：
 *
 *   写入   fail-open      JEV 挂了照存，标 status='unavailable'
 *   召回   fail-degraded  退回关键词排序，标 'degraded'
 *   注入   fail-closed    判断不了就不注入 —— 但必须能在 /memory 里看见原因（§6.2）
 *
 * 工厂里不建长生命周期资源：pi 在不跑会话的调用里也会执行工厂（docs/extensions.md）。
 * 所以库在 `session_start` 里开、在 `session_shutdown` 里关，写入排队后台跑、
 * 收尾时冲刷 —— 写库不该拖住用户，但也不能丢。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { JudgeMeta } from "./src/jev/types.ts";
import type { MemoryNode, SessionInfo } from "./src/core/types.ts";
import { createJudgeAdapter, type JevAdapter } from "./src/jev/adapter.ts";
import { loadConfig, proxyHint, type InjectConfig, type RecallWeights } from "./src/config.ts";
import {
  addTrace, countMemories, countPendingReviews, distinctTopics, getMemory, hardDelete, listInScope,
  openGlobalDb, openProjectDb, projectIdFor, recentRecalls, resolveReview, setTopic, tracesFor,
  type OpenedDb,
} from "./src/storage/db.ts";
import { splitForWrite, writeFlow } from "./src/pipeline/write.ts";
import { recallFlow, worthRecalling } from "./src/pipeline/recall.ts";
import { resurrectFor, runLifecycle } from "./src/pipeline/lifecycle.ts";
import { closeFeedbackLoop } from "./src/pipeline/feedback.ts";
import { startUi, type UiHandles } from "./src/ui/server.ts";
import {
  RESOLUTION_LABELS, SCOPE_WIDEN, applyResolution, labelToResolution, pendingItems, widenScopeToGlobal,
} from "./src/pipeline/review.ts";
import { DEFAULT_MAX_TOKENS, InjectionState, MEMORY_OPEN } from "./src/pipeline/inject.ts";

/** 本会话的运行时状态。每次 session_start 重建，session_shutdown 拆掉。 */
interface Runtime {
  projectDb: OpenedDb;
  globalDb: OpenedDb;
  adapter: JevAdapter;
  session: SessionInfo;
  state: InjectionState;
  /** 后台写入队列：agent_end 不等它，session_shutdown 必须等。 */
  pending: Promise<unknown>;
  /** 本会话已经消化过的用户原话，防同一句被评估两次。 */
  digested: Set<string>;
  /** 本会话的注入策略（config.inject）。 */
  inject: InjectConfig;
  /** §10.2 的混合排序权重。 */
  weights: RecallWeights;
  /** J16 主动召回的开关与频率（每会话几次）。 */
  proactive: { enabled: boolean; maxPerSession: number };
  /** 本会话已经主动提醒过几次。 */
  proactiveCount: number;
  /** 本地页面的端口（0 = 系统挑）。 */
  uiPort: number;
  /** 配置读取时发现的问题（文件缺失 / 权限不对 / 解析失败），/memory 要能看见。 */
  configProblems: string[];
  /** 本会话用哪个判断引擎（rules / jev / openai），/memory 要能看见。 */
  engine: string;
  /** 代理没生效时的提示文本（配了代理但启动时没开 NODE_USE_ENV_PROXY）。只在真失败时提示一次。 */
  proxyHint: string | null;
  proxyWarned?: boolean;
  /** 生命周期里的自动清理设置（/memory 要能看见它开没开、多少天）。 */
  cleanup: { autoCleanup: boolean; sessionTtlDays: number };
  /** query 存着给 J5 用：下次它要判断「这个提问还是上次那件事吗」。 */
  lastRecall?: { status: JudgeMeta["status"] | "skipped"; candidates: number; injected: number; detail?: string; query?: string; at: number };
  lastWrite?: { action: string; reason?: string; at: number };
  lastFeedback?: { injected: number; cited: number; score: number | null; by: string; at: number };
  lastProactive?: { id: string; content: string; at: number };
  error?: string;
}

/** J5 的阈值：低于它就不值得花这次召回的钱。§6 把 0.5 定成「交给规则二次确认」的下界。 */
const NEED_RECALL_THRESHOLD = 0.5;

function errText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** 状态三态/跳过的人话标签。§6.2：降级不能表现成「没有记忆」，所以词要分开。 */
function label(status: JudgeMeta["status"] | "skipped"): string {
  switch (status) {
    case "ok": return "正常";
    case "degraded": return "降级（判断不完整）";
    case "unavailable": return "记忆系统降级（JEV 不可用）";
    case "skipped": return "跳过";
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: string; text: string } =>
      Boolean(p) && typeof p === "object" && (p as { type?: string }).type === "text")
    .map((p) => p.text)
    .join("");
}

/**
 * 只取用户自己敲的话。工具输出里是凭据和几百行日志 —— 把这些写进长期记忆，
 * 等于把密码存进一个会到处注入的库。
 *
 * 顺带跳过我们自己注入的记忆块：它是 role='user' 的自定义消息，
 * 但来源是库，不是用户。
 */
export function userTexts(messages: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    const msg = m as { role?: string; content?: unknown };
    if (msg.role !== "user") continue;
    const text = textOf(msg.content);
    if (!text.trim()) continue;
    if (text.includes(MEMORY_OPEN)) continue;
    out.push(text);
  }
  return out;
}

/** 给 JEV 的上下文：助手说过的话。不带工具结果 —— 那里面才是凭据和日志。 */
export function assistantText(messages: readonly unknown[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const msg = m as { role?: string; content?: unknown };
    if (msg.role !== "assistant") continue;
    const text = textOf(msg.content);
    if (text.trim()) parts.push(text);
  }
  return parts.join("\n").slice(-2000);
}

/**
 * 给 JEV 判断用的对话上下文：**最近几轮用户说过的话** + 本轮助手说过的话。
 *
 * 为什么要有前面几轮的用户话：只给本轮助手的话时，用户说「不对，改成 Y」这种，
 * JEV 只能靠词形（"不对"、"改成"）猜，而不是靠「上一轮说的是 X」。判断该不该记、
 * 跟哪条旧记忆冲突，都需要知道上一句是什么。
 *
 * 为什么不用整段会话：token 和噪声都涨，判断质量并不会跟着涨。最近 2 轮够用。
 * 本轮用户的话在这里排除掉 —— 它已经在 NEW CONTENT 里了，重复给一遍只会让
 * JEV 以为用户说了两次。
 */
export function conversationContext(
  branch: readonly unknown[],
  currentUserTexts: readonly string[],
  thisRunAssistant: string,
  maxTurns = 2,
): string {
  const current = new Set(currentUserTexts.map((t) => t.trim()));
  const previous: string[] = [];
  for (let i = branch.length - 1; i >= 0 && previous.length < maxTurns; i--) {
    const entry = branch[i] as { role?: string; content?: unknown; message?: { role?: string; content?: unknown } };
    const msg = entry?.message ?? entry;
    if (msg?.role !== "user") continue;
    const text = textOf(msg.content).trim();
    if (!text || text.includes(MEMORY_OPEN) || current.has(text)) continue;
    previous.unshift(text.slice(0, 300));
  }
  const parts: string[] = [];
  if (previous.length) parts.push(`USER SAID EARLIER IN THIS SESSION:\n${previous.join("\n")}`);
  if (thisRunAssistant.trim()) parts.push(`ASSISTANT SAID IN THIS TURN:\n${thisRunAssistant}`);
  return parts.join("\n\n");
}

/**
 * 本会话最后一条用户消息。
 *
 * memory_add 用它而不是用模型给的 content：记忆原文必须由系统控制（§15 原则 1），
 * 而且模型的重述与 agent_end 自动存的原话对不上，查重也拦不住 —— 实测同一个约定
 * 就这样存了两行。写用户自己的话，两条路径的内容天然一致，精确查重直接命中。
 */
export function lastUserText(branch: readonly unknown[]): string | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as { role?: string; content?: unknown; message?: { role?: string; content?: unknown } };
    // 真时 getBranch() 给的是会话条目 { type:"message", message:{role,content} }，
    // 而 agent_end 给的是裸消息。两种形状都要认，否则这里永远取不到用户的话，
    // 又退回去存模型的重述（实测就是这样漏回去的）。
    const msg = entry?.message ?? entry;
    if (msg?.role !== "user") continue;
    const text = textOf(msg.content);
    if (!text.trim() || text.includes(MEMORY_OPEN)) continue;
    return text;
  }
  return null;
}

function statusText(r: Runtime): string {
  const lines = [
    `项目库 ${projectIdFor(r.session.cwd)}：${countMemories(r.projectDb)} 条`,
    `全局库：${countMemories(r.globalDb)} 条`,
    `本会话注入：${r.state.doneThisSession ? `${r.state.injectedIds.size} 条 / ${r.state.injectionCount} 次` : "未注入"}`,
    `注入策略：每会话最多 ${r.inject.maxPerSession} 次，间隔 ≥${r.inject.minTurnsBetween} 轮，换话题才再注入`,
    `判断引擎：${r.engine}`,
    `主动召回：${r.proactive.enabled ? `开（每会话最多 ${r.proactive.maxPerSession} 次）` : "关"}`,
    `自动清理：${r.cleanup.autoCleanup ? `开（session 记忆 ${r.cleanup.sessionTtlDays} 天没命中就销毁）` : "关（session 记忆只归档不销毁）"}`,
  ];
  const lr = r.lastRecall;
  if (lr) lines.push(`上次召回：${label(lr.status)}，候选 ${lr.candidates} → 注入 ${lr.injected}${lr.detail ? `（${lr.detail}）` : ""}`);
  if (r.lastWrite) lines.push(`上次写入：${r.lastWrite.action}${r.lastWrite.reason ? `（${r.lastWrite.reason}）` : ""}`);
  const pending = countPendingReviews(r.projectDb);
  if (pending > 0) lines.push(`待确认：${pending} 条（/memory review 过一遍）`);
  if (r.lastProactive) lines.push(`上次主动提醒：${r.lastProactive.content.slice(0, 40)}`);
  if (r.lastFeedback) {
    const how = r.lastFeedback.by === "engine" ? "引擎判定" : "字符串比对（下限）";
    lines.push(`上次注入效果：注入 ${r.lastFeedback.injected} 条，确凿用上 ${r.lastFeedback.cited} 条${r.lastFeedback.score === null ? "" : `（${how}，命中率 ${(r.lastFeedback.score * 100).toFixed(0)}%）`}`);
  }
  // J15：最近几次召回的事实（没注入的时候最需要看到这个）
  const recalls = recentRecalls(r.projectDb, 3);
  for (const q of recalls) {
    const injected = JSON.parse(String(q.injected_ids ?? "[]")) as unknown[];
    const recalled = JSON.parse(String(q.recalled_ids ?? "[]")) as unknown[];
    const cited = JSON.parse(String(q.cited_ids ?? "[]")) as unknown[];
    lines.push(`召回记录：候选 ${recalled.length} → 注入 ${injected.length} → 确凿用上 ${cited.length} 「${String(q.query).slice(0, 24)}」`);
  }
  for (const p of r.configProblems) lines.push(`配置：${p}`);
  if (r.error) lines.push(`最近错误：${r.error}`);
  return lines.join("\n");
}

function foundLine(r: { memory: MemoryNode; relevance: number }): string {
  return `[${r.memory.id}] (${r.memory.type}/${r.memory.scope}) ${r.relevance.toFixed(2)} ${r.memory.content}`;
}

/**
 * 引擎真连不上时，才提示代理这件事（每会话最多一次）。
 *
 * 原来是在 session_start 无条件提示「配了代理但没开 NODE_USE_ENV_PROXY」—— 但直连好好的时候
 * 那是误报，天天弹等于噪声。改成看证据：有一次判断拿到 unavailable 才说。
 */
function warnProxy(r: Runtime, ctx: ExtensionContext): void {
  if (!r.proxyHint || r.proxyWarned || !ctx.hasUI) return;
  r.proxyWarned = true;
  ctx.ui.notify(r.proxyHint, "warning");
}

/**
 * 问用户一条待确认项（pi 的 1/2/3 选择框）。
 * 返回处置结果的人话，用户按 Esc 取消就当「保留两条」—— 默认永远选最安全的那个。
 */
async function askReview(o: OpenedDb, ctx: ExtensionContext, reviewId: string): Promise<string | null> {
  const item = pendingItems(o, 50).find((it) => String(it.id) === reviewId);
  if (!item) return null;

  // J14b 的放宽也走选择框，但它要跨库操作，所以单独处理（applyResolution 只碰一个库）。
  if (String(item.kind) === "scope") {
    const options = JSON.parse(String(item.options)) as string[];
    const picked = await ctx.ui.select(`记忆待确认：${String(item.question)}`, options);
    const widen = picked === SCOPE_WIDEN;
    resolveReview(o, String(item.id), widen ? "scope:widen" : "scope:keep");
    if (!widen) return "保持项目级";
    return widenScopeToGlobal(o, rt!.globalDb, String(item.memory_id));
  }

  // J4 的起名用文本框（要让用户输入新词），其余两个用 1/2/3 选择框。
  if (String(item.kind) === "topic") {
    const existing = (JSON.parse(String(item.options)) as string[]).filter((o) => o !== "先不起主题");
    const name = (await ctx.ui.input(
      `${String(item.question)}${existing.length ? `\n（已有主题：${existing.join(" / ")}）` : ""}`,
      "主题名，留空跳过",
    ))?.trim();
    if (!name) {
      resolveReview(o, String(item.id), "topic:skipped");
      return "先不起主题";
    }
    setTopic(o, String(item.memory_id), name);
    resolveReview(o, String(item.id), `topic:${name}`);
    return `主题设为「${name}」`;
  }

  const options = JSON.parse(String(item.options)) as string[];
  const labels = options.length ? options : Object.values(RESOLUTION_LABELS);
  const picked = await ctx.ui.select(`记忆待确认：${String(item.question)}`, labels);
  const resolution = labelToResolution(picked ?? RESOLUTION_LABELS.keep_both);
  return applyResolution(o, item, resolution);
}

export default function reflectiveStorage(pi: ExtensionAPI): void {
  let rt: Runtime | null = null;
  /** 本地页面面板。按需启动（/memory ui），session_shutdown 关掉 —— 工厂里不起长驻资源（§8.2）。 */
  let ui: UiHandles | null = null;

  pi.on("session_start", async (_event, ctx) => {
    const projectDb = openProjectDb(ctx.cwd);
    const globalDb = openGlobalDb();
    const loaded = loadConfig();
    const judge = loaded.judge;

    // 代理只影响判断引擎能不能连上，连不上就是召回 fail-degraded、注入 fail-closed。
    // 但必须提示：不提示的话表现是「一直超时」，看不出是代理没生效。
    // 代理提示**不在这里**发：配了代理不等于代理没生效（直连可能好好的），
    // 一上来就警告会在网络正常时天天误报。改成「引擎真的连不上时才提示一次」（见 warnProxy）。
    const hint = loaded.config.proxy ? proxyHint(loaded.config) : null;
    // 引擎配错了（openai 缺 baseUrl 之类）要当场说 —— 那个是配置错误，不是网络问题。
    if (judge.problems.length && ctx.hasUI) {
      ctx.ui.notify(`reflective-storage 判断引擎配置：\n${judge.problems.join("\n")}`, "warning");
    }

    rt = {
      projectDb,
      globalDb,
      adapter: createJudgeAdapter(judge),
      engine: judge.provider,
      weights: loaded.recall.weights,
      proactive: loaded.proactive,
      proactiveCount: 0,
      uiPort: loaded.ui.port,
      proxyHint: hint,
      inject: loaded.inject,
      session: {
        sessionId: ctx.sessionManager.getSessionId() ?? "ephemeral",
        cwd: ctx.cwd,
        projectId: projectIdFor(ctx.cwd),
        injectedIds: new Set<string>(),
      },
      state: new InjectionState(),
      pending: Promise.resolve(),
      digested: new Set<string>(),
      configProblems: [...loaded.problems, ...judge.problems],
      cleanup: loaded.lifecycle,
    };

    // 有待确认的事项就在启动时说一声（不弹窗：一次弹五个对话框比不问更糟）。
    const pending = countPendingReviews(projectDb);
    if (pending > 0 && ctx.hasUI) {
      ctx.ui.notify(`reflective-storage：有 ${pending} 条记忆等你确认（合并 / 冲突），/memory review`, "info");
    }

    // 懒生命周期（§9.3）：没有定时任务，就挂在 session_start 上跑一次，且有上限。
    // 纯后台（fail-silent）：不 await、出错也不影响会话。
    const lifecycle = rt;
    void Promise.resolve()
      .then(() => {
        const s = runLifecycle(lifecycle.projectDb, {
          autoCleanup: lifecycle.cleanup.autoCleanup,
          purgeAfterDays: lifecycle.cleanup.sessionTtlDays,
        });
        runLifecycle(lifecycle.globalDb, {
          autoCleanup: lifecycle.cleanup.autoCleanup,
          purgeAfterDays: lifecycle.cleanup.sessionTtlDays,
        });
        if (s.errors.length) lifecycle.error = `生命周期：${s.errors[0]}`;
      })
      .catch((e) => { lifecycle.error = `生命周期：${errText(e)}`; });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const r = rt;
    if (!r) return;
    r.state.tick();

    // J13 复活要先跑，而且必须在预判之前：它是纯本地二字组比对（不吃 token、不调引擎），
    // 而预判可能因为「输入太短」直接返回 —— 实测就是这样漏掉一次本该发生的复活。
    try {
      resurrectFor(r.projectDb, event.prompt ?? "");
      resurrectFor(r.globalDb, event.prompt ?? "");
    } catch (e) {
      r.error = errText(e);   // 纯后台的一层，不该影响召回
    }

    const pre = worthRecalling(event.prompt ?? "");
    if (!pre.ok) {
      // 跳过不打「已注入」标记：这一轮不花那个钱，下一轮话够长还会查。
      r.lastRecall = { status: "skipped", candidates: 0, injected: 0, detail: pre.reason, at: Date.now() };
      return;
    }

    // 机械约束（次数上限 / 隔几轮）过了之后，**该不该查由 J5 判** ——
    // 「这个提问是不是已经在上下文里的那件事」是内容判断，不该让本地二字组规则兼职。
    // 首轮不问 J5：§10.4 第一条规则就是「首轮直接走完整召回」。
    const gate = r.state.shouldInject(r.inject);
    if (!gate.ok) {
      r.lastRecall = { status: "skipped", candidates: 0, injected: 0, detail: gate.reason, at: Date.now() };
      return;
    }
    if (!gate.first) {
      try {
        const need = await r.adapter.judgeRecallNeed(event.prompt, {
          ...r.session,
          lastInjectedQuery: r.lastRecall?.query ?? null,
        });
        if (need.noul < NEED_RECALL_THRESHOLD) {
          r.lastRecall = {
            status: "skipped", candidates: 0, injected: 0, query: event.prompt,
            detail: `J5 判断不必再查（${need.noul.toFixed(2)}${need.meta.detail ? `，${need.meta.detail}` : ""}）`,
            at: Date.now(),
          };
          return;
        }
      } catch (e) {
        // 问不动就不查：保守方向（少召回一条），比多插一块噪声好。
        r.error = errText(e);
        return;
      }
    }

    try {
      const res = await recallFlow(event.prompt, {
        projectDb: r.projectDb,
        globalDb: r.globalDb,
        adapter: r.adapter,
        session: r.session,
        budget: { maxTokens: DEFAULT_MAX_TOKENS },
        weights: r.weights,
      });
      r.lastRecall = {
        status: res.status, candidates: res.candidates.length,
        injected: res.injected.length, detail: res.detail, query: event.prompt, at: Date.now(),
      };
      if (res.status === "unavailable") warnProxy(r, ctx);
      if (res.injected.length === 0) return;   // fail-closed：沉默优于噪声
      r.state.markInjected(res.injected.map((x) => x.memory.id));
      return { message: { customType: "reflective-memory", content: res.block, display: true } };
    } catch (e) {
      // 注入 fail-closed：任何意外都不许穿透到 agent 启动
      r.error = errText(e);
      return;
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    const r = rt;
    if (!r) return;
    const texts = userTexts(event.messages).filter((t) => !r.digested.has(t));
    for (const t of texts) r.digested.add(t);
    const replyText = assistantText(event.messages);
    const context = conversationContext(ctx.sessionManager.getBranch(), texts, replyText);
    // J15 事后核对：这一轮助手的回复到底用上了哪几条注入过的记忆。纯本地、不联网，
    // 所以直接同步算（写库也在这儿），不走后台队列。
    // 没有助手回复的轮次（重试/中断）**不核对**：拿一段不含回复的上下文去算，
    // 只会把上一轮「确凿用上」的结论覆盖成 0，等于报假账。
    if (replyText.trim()) {
      // 进后台队列：J15 现在会**调一次引擎**问「这条用上了没」（cited 拿钱换精度），
      // 不能在 agent_end 里同步等它，否则每轮结束都多一段等待。
      r.pending = r.pending
        .then(async () => {
          const fb = await closeFeedbackLoop(r.projectDb, r.session.sessionId, replyText, r.adapter);
          if (fb.injected > 0) {
            r.lastFeedback = { injected: fb.injected, cited: fb.cited.length, score: fb.effectScore, by: fb.by, at: Date.now() };
          }
        })
        .catch((e) => { r.error = errText(e); });
    }
    if (texts.length === 0) return;
    // 写入 fail-open 且不该拖住用户：排队后台跑，session_shutdown 冲刷。
    r.pending = r.pending
      .then(async () => {
        // 一句一条记忆（见 splitForWrite 的说明）：整段写会把项目约定和用户偏好挤进
        // 同一条，类型和作用域只能选一个 —— 用户偏好被锁进单个项目就再也跟不走了。
        const pieces = splitForWrite(texts);
        let firstReviewId: string | null = null;
        for (const piece of pieces) {
          const res = await writeFlow(r.projectDb, r.globalDb, r.adapter, r.session, { userTexts: [piece], context });
          r.lastWrite = { action: res.action, reason: res.reason, at: Date.now() };
          if (res.status === "unavailable") warnProxy(r, ctx);
          firstReviewId ??= res.review?.[0]?.id ?? null;
        }
        // 写入排队问用户的事项：一轮最多问一条，别刷屏（剩下的 /memory review 随时能过）。
        // hasUI 为假（print 模式）就只排队，不问。
        if (firstReviewId && ctx.hasUI) await askReview(r.projectDb, ctx, firstReviewId);
      })
      .catch((e) => { r.error = errText(e); });
  });

  // J16 主动召回（§4）：用户没问、但库里有一条他现在就该知道的。
  //
  // 挂在 agent_settled（pi 确认不会再自动继续）——那一轮已经答完，用户正在看，此刻提醒
  // 不打断任何东西。**提醒只给用户看（notify），不往上下文里塞**：注入有 §8.3 的纪律
  // （每会话有界几次、保前缀缓存），主动提醒挤进上下文会把那条纪律毁掉。
  //
  // 频率先保证不烦人：每会话最多 maxPerSession 次（默认 1），而且只提醒**本次会话还没
  // 注入过**的记忆（注入过的话模型已经知道，再提醒是唠叨）。降级策略是关闭。
  pi.on("agent_settled", async (_event, ctx) => {
    const r = rt;
    if (!r || !r.proactive.enabled) return;
    if (r.proactiveCount >= r.proactive.maxPerSession) return;
    const said = lastUserText(ctx.sessionManager.getBranch());
    if (!said || !worthRecalling(said).ok) return;
    r.proactiveCount++;   // 先占位：判失败也算用掉了这一轮，不许反复试

    r.pending = r.pending
      .then(async () => {
        const res = await recallFlow(said, {
          projectDb: r.projectDb, globalDb: r.globalDb, adapter: r.adapter, session: r.session,
          weights: r.weights,
        });
        if (res.candidates.length === 0) return;
        const j = await r.adapter.judgeProactive(said, res.candidates.map((c) => c.memory));
        if (j.meta.status !== "ok") return;   // 降级 = 关闭（§4 的 J16 降级策略）
        const pick = res.candidates.find((c) => j.remind.has(c.memory.id));
        if (!pick) return;
        addTrace(r.projectDb, {
          memoryId: pick.memory.id, stage: "recall", gate: "J16", action: "remind",
          reason: `主动提醒（J7 相关度 ${pick.relevance.toFixed(2)}）`,
          status: j.meta.status, latencyMs: j.meta.latencyMs,
        });
        r.lastProactive = { id: pick.memory.id, content: pick.memory.content, at: Date.now() };
        if (ctx.hasUI) {
          ctx.ui.notify(`记忆提醒：${pick.memory.content.slice(0, 140)}\n/memory why ${pick.memory.id.slice(0, 8)} 看依据`, "info");
        }
      })
      .catch((e) => { r.error = errText(e); });
  });

  pi.on("session_compact", async () => {
    // 压缩把上下文重写过了，注入块已经不在里面 —— 解开标记，允许下一轮重新注入（§8.3 / §8.4）。
    rt?.state.reset();
  });

  pi.on("session_before_switch", async () => {
    // 要换会话了，本会话的注入记录作废。库由 session_shutdown 关、session_start 重开（§8.2）。
    rt?.state.reset();
  });

  pi.on("session_shutdown", async () => {
    const r = rt;
    rt = null;
    if (!r) return;
    ui?.close();
    ui = null;
    await r.pending;   // 待写队列必须落地，失败已经记在 r.error 里
    r.projectDb.close();
    r.globalDb.close();
  });

  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "在长期记忆库里检索与当前问题相关的条目（向量 + 关键词召回，再按相关性重排），返回带 id 和分数片段。",
    promptSnippet: "Search the user's long-term memory for past decisions, preferences and project facts",
    promptGuidelines: [
      "Use memory_search when the user refers to something from an earlier session — a past decision, a correction, a preference, or a project convention you have not seen in this conversation.",
      "Use memory_search before assuming a project convention; the memory store is the only place cross-session decisions live.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "问题或关键词，写得越具体越准" }),
    }),
    async execute(_id, params) {
      const r = rt;
      if (!r) throw new Error("记忆库未打开（没有活动会话）");
      const res = await recallFlow(params.query, {
        projectDb: r.projectDb, globalDb: r.globalDb, adapter: r.adapter, session: r.session,
        weights: r.weights,
      });
      r.lastRecall = { status: res.status, candidates: res.candidates.length, injected: res.injected.length, detail: res.detail, at: Date.now() };
      if (res.candidates.length === 0) {
        return {
          content: [{ type: "text", text: `没有命中：${res.detail ?? "库里没有相关条目"}` }],
          details: { status: res.status, count: 0 },
        };
      }
      return {
        content: [{ type: "text", text: res.candidates.map(foundLine).join("\n") }],
        details: { status: res.status, count: res.candidates.length },
      };
    },
  });

  pi.registerTool({
    name: "memory_add",
    label: "Memory Add",
    description: "主动往长期记忆里写入一条。仍然会走类型/作用域判断和写入闸，JEV 认为不值得存就不会落库。",
    promptSnippet: "Remember a durable decision, correction or preference in the user's long-term memory",
    promptGuidelines: [
      "Use memory_add ONLY when the user explicitly asks you to remember something (for example \"记住…\", \"别忘了…\", \"remember this\").",
      "Do NOT use memory_add for decisions, corrections or preferences the user merely states in passing — those are captured automatically at the end of the turn, and calling memory_add as well stores the same thing twice.",
      "Write memory_add content in your own words as one clear sentence. Never paste logs, file contents or tool output into it.",
    ],
    parameters: Type.Object({
      content: Type.String({ description: "要记住的内容，一句话说清楚，别贴日志或文件内容" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const r = rt;
      if (!r) throw new Error("记忆库未打开（没有活动会话）");
      // 优先存用户自己的话（见 lastUserText 的说明）；拿不到当前用户消息时才用模型给的文本。
      const said = lastUserText(ctx.sessionManager.getBranch());
      const texts = said ? [said] : [params.content];
      const res = await writeFlow(r.projectDb, r.globalDb, r.adapter, r.session, {
        userTexts: texts,
        context: `memory_add 工具：模型判断这条值得记（${ctx.sessionManager.getSessionId() ?? "?"}）`,
      });
      r.lastWrite = { action: res.action, reason: res.reason, at: Date.now() };
      const text = res.action === "stored"
        ? `已记住 [${res.memory?.id}] (${res.memory?.type}/${res.memory?.scope})： ${(res.memory?.content ?? "").slice(0, 80)}`
        : res.action === "duplicate"
          ? `已经有这条了（${res.reason}），没有重复写入`
          : `没有写入（${res.action}：${res.reason ?? "写入闸没放行"}）`;
      return { content: [{ type: "text", text }], details: { action: res.action, id: res.memory?.id } };
    },
  });

  pi.registerTool({
    name: "memory_forget",
    label: "Memory Forget",
    description: "删除一条长期记忆。给 id 才真删；只给 query 会先列出命中的条目和 id，让你确认后再按 id 删。",
    promptSnippet: "Delete a specific long-term memory by id",
    promptGuidelines: [
      "Use memory_forget only when the user asks to delete or forget a stored memory. Pass the id from memory_search; a query alone only lists candidates and deletes nothing.",
    ],
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "要删的记忆 id（memory_search 返回过）" })),
      query: Type.Optional(Type.String({ description: "没有 id 时用它列出候选，不直接删" })),
    }),
    async execute(_id, params) {
      const r = rt;
      if (!r) throw new Error("记忆库未打开（没有活动会话）");
      const inProject = (m: MemoryNode) => m.scope !== "global";

      if (params.id) {
        // 硬删是不可逆的，所以只认 id：查到的这一条是谁，删的就是谁。
        const m = getMemory(r.projectDb, params.id) ?? getMemory(r.globalDb, params.id);
        if (!m) return { content: [{ type: "text", text: `没有 id 为 ${params.id} 的记忆` }], details: { deleted: 0 } };
        const db = inProject(m) ? r.projectDb : r.globalDb;
        addTrace(db, { memoryId: m.id, stage: "governance", gate: "J12", action: "delete", reason: "用户/模型要求删除" });
        hardDelete(db, m.id);
        return { content: [{ type: "text", text: `已删除 [${m.id}] ${m.content.slice(0, 60)}` }], details: { deleted: 1, id: m.id } };
      }

      if (params.query) {
        const hits = listInScope(r.projectDb, "project", r.session.projectId, 20)
          .concat(listInScope(r.globalDb, "global", null, 20))
          .filter((m) => m.content.includes(params.query!) || (m.summary ?? "").includes(params.query!));
        if (hits.length === 0) return { content: [{ type: "text", text: "没有命中，什么都没删" }], details: { deleted: 0 } };
        return {
          content: [{
            type: "text",
            text: `命中 ${hits.length} 条，什么都没删。要删哪条就用它的 id 再调一次 memory_forget：\n${hits.map((m) => `[${m.id}] ${m.content.slice(0, 80)}`).join("\n")}`,
          }],
          details: { deleted: 0, candidates: hits.map((m) => m.id) },
        };
      }

      throw new Error("memory_forget 需要 id 或 query");
    },
  });

  pi.registerCommand("memory", {
    description: "长期记忆 /memory：状态、search <词>、why <id>、review（待确认）、topic <名>、topics、ui（网页面板）、forget <id>",
    handler: async (args: string, ctx: ExtensionContext) => {
      const r = rt;
      if (!r) {
        ctx.ui.notify("记忆库未打开（没有活动会话）", "error");
        return;
      }
      const [sub, ...rest] = args.trim().split(/\s+/);
      const tail = rest.join(" ").trim();

      if (sub === "search" && tail) {
        const res = await recallFlow(tail, {
          projectDb: r.projectDb, globalDb: r.globalDb, adapter: r.adapter, session: r.session,
          weights: r.weights,
        });
        ctx.ui.notify(
          res.candidates.length === 0
            ? `没有命中：${res.detail ?? "库里没有相关条目"}`
            : `${label(res.status)}\n${res.candidates.map(foundLine).join("\n")}`,
          "info",
        );
        return;
      }

      if (sub === "why" && tail) {
        // Phase 1 验收标准要的第三个问题「为什么记住」就靠这段轨迹回答。
        const m = getMemory(r.projectDb, tail) ?? getMemory(r.globalDb, tail);
        if (!m) {
          ctx.ui.notify(`没有 id 为 ${tail} 的记忆`, "error");
          return;
        }
        const traces = tracesFor(m.scope === "global" ? r.globalDb : r.projectDb, m.id);
        ctx.ui.notify([
          `[${m.id}] (${m.type}/${m.scope}) ${m.content}`,
          `importance ${m.importance.toFixed(2)} · 访问 ${m.accessCount} 次 · 状态 ${m.state}`,
          ...(traces.length
            ? traces.map((t) => `${t.user_visible ?? ""}\n    ${t.gate} ${t.action} ${t.reason ?? ""} [${t.status ?? "?"}/${t.fallback_used ?? "?"}]${t.judgment ? ` 路由=${t.judgment}` : ""}`)
            : ["没有判断轨迹"]),
        ].join("\n"), "info");
        return;
      }

      if (sub === "review" || sub === "review-") {
        const items = pendingItems(r.projectDb, tail ? Number(tail) || 5 : 5);
        if (items.length === 0) {
          ctx.ui.notify("没有待确认的记忆", "info");
          return;
        }
        if (!ctx.hasUI) {
          ctx.ui.notify(
            items.map((it) => `[${String(it.id).slice(0, 8)}] ${String(it.question).replace(/\n/g, " ")}`).join("\n"),
            "info",
          );
          return;
        }
        for (const item of items) await askReview(r.projectDb, ctx, String(item.id));
        return;
      }

      if (sub === "ui") {
        try {
          ui ??= await startUi({
            projectDb: r.projectDb, globalDb: r.globalDb, projectId: r.session.projectId,
            port: r.uiPort,
          });
          const msg = `记忆库页面：${ui.url}\n（只绑 127.0.0.1，URL 里的 token 是访问凭证；关掉 pi 就停）`;
          // print / json 模式没有 UI（notify 是空操作），所以那边退到 stderr —— 不然
          // 用户敲了 /memory ui 却什么也看不到。
          if (ctx.hasUI) ctx.ui.notify(msg, "info");
          else console.error(`[reflective-storage] ${msg}`);
        } catch (e) {
          ctx.ui.notify(`页面起不来：${errText(e)}`, "error");
        }
        return;
      }

      if (sub === "topics") {
        const topics = distinctTopics(r.projectDb);
        ctx.ui.notify(topics.length ? `主题（${topics.length}）：\n${topics.join("\n")}` : "还没有主题", "info");
        return;
      }

      if (sub === "topic" && tail) {
        const rows = r.projectDb.db
          .prepare(`SELECT id, type, state, content FROM memories WHERE topic = ? ORDER BY created_at DESC LIMIT 20`)
          .all(tail) as Array<Record<string, unknown>>;
        ctx.ui.notify(
          rows.length
            ? `主题「${tail}」下 ${rows.length} 条：\n${rows.map((m) => `[${String(m.id).slice(0, 8)}] (${m.type}/${m.state}) ${String(m.content).slice(0, 40)}`).join("\n")}`
            : `没有主题是「${tail}」的记忆`,
          "info",
        );
        return;
      }

      if (sub === "forget" && tail) {
        const m = getMemory(r.projectDb, tail) ?? getMemory(r.globalDb, tail);
        if (!m) {
          ctx.ui.notify(`没有 id 为 ${tail} 的记忆`, "error");
          return;
        }
        const db = m.scope === "global" ? r.globalDb : r.projectDb;
        addTrace(db, { memoryId: m.id, stage: "governance", gate: "J12", action: "delete", reason: "用户 /memory forget" });
        hardDelete(db, m.id);
        ctx.ui.notify(`已删除 [${m.id}]`, "info");
        return;
      }

      ctx.ui.notify(statusText(r), "info");
    },
  });
}
