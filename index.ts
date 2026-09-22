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
import { loadConfig, proxyHint } from "./src/config.ts";
import {
  addTrace, countMemories, getMemory, hardDelete, listInScope, openGlobalDb, openProjectDb,
  projectIdFor, recentRecalls, tracesFor, type OpenedDb,
} from "./src/storage/db.ts";
import { writeFlow } from "./src/pipeline/write.ts";
import { recallFlow, worthRecalling } from "./src/pipeline/recall.ts";
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
  /** 配置读取时发现的问题（文件缺失 / 权限不对 / 解析失败），/memory 要能看见。 */
  configProblems: string[];
  /** 本会话用哪个判断引擎（rules / jev / openai），/memory 要能看见。 */
  engine: string;
  lastRecall?: { status: JudgeMeta["status"] | "skipped"; candidates: number; injected: number; detail?: string; at: number };
  lastWrite?: { action: string; reason?: string; at: number };
  error?: string;
}

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
    `本会话注入：${r.state.doneThisSession ? `${r.state.injectedIds.size} 条` : "未注入"}`,
    `判断引擎：${r.engine}`,
  ];
  const lr = r.lastRecall;
  if (lr) lines.push(`上次召回：${label(lr.status)}，候选 ${lr.candidates} → 注入 ${lr.injected}${lr.detail ? `（${lr.detail}）` : ""}`);
  if (r.lastWrite) lines.push(`上次写入：${r.lastWrite.action}${r.lastWrite.reason ? `（${r.lastWrite.reason}）` : ""}`);
  // J15：最近几次召回的事实（没注入的时候最需要看到这个）
  const recalls = recentRecalls(r.projectDb, 3);
  for (const q of recalls) {
    const injected = JSON.parse(String(q.injected_ids ?? "[]")) as unknown[];
    const recalled = JSON.parse(String(q.recalled_ids ?? "[]")) as unknown[];
    lines.push(`召回记录：候选 ${recalled.length} → 注入 ${injected.length} 「${String(q.query).slice(0, 24)}」`);
  }
  for (const p of r.configProblems) lines.push(`配置：${p}`);
  if (r.error) lines.push(`最近错误：${r.error}`);
  return lines.join("\n");
}

function foundLine(r: { memory: MemoryNode; relevance: number }): string {
  return `[${r.memory.id}] (${r.memory.type}/${r.memory.scope}) ${r.relevance.toFixed(2)} ${r.memory.content}`;
}

export default function reflectiveStorage(pi: ExtensionAPI): void {
  let rt: Runtime | null = null;

  pi.on("session_start", async (_event, ctx) => {
    const projectDb = openProjectDb(ctx.cwd);
    const globalDb = openGlobalDb();
    const loaded = loadConfig();
    const judge = loaded.judge;

    // 代理只影响判断引擎能不能连上，连不上就是召回 fail-degraded、注入 fail-closed。
    // 但必须提示：不提示的话表现是「一直超时」，看不出是代理没生效。
    const hint = loaded.config.proxy ? proxyHint(loaded.config) : null;
    if (hint && ctx.hasUI) ctx.ui.notify(hint, "warning");
    // 引擎配错了（openai 缺 baseUrl 之类）也要当场说，否则表现只是「judge 一直降级」。
    if (judge.problems.length && ctx.hasUI) {
      ctx.ui.notify(`reflective-storage 判断引擎配置：\n${judge.problems.join("\n")}`, "warning");
    }

    rt = {
      projectDb,
      globalDb,
      adapter: createJudgeAdapter(judge),
      engine: judge.provider,
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
    };
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    const r = rt;
    if (!r || r.state.doneThisSession) return;

    const pre = worthRecalling(event.prompt ?? "");
    if (!pre.ok) {
      // 跳过不打「已注入」标记：这一轮不花那个钱，下一轮话够长还会查。
      r.lastRecall = { status: "skipped", candidates: 0, injected: 0, detail: pre.reason, at: Date.now() };
      return;
    }

    try {
      const res = await recallFlow(event.prompt, {
        projectDb: r.projectDb,
        globalDb: r.globalDb,
        adapter: r.adapter,
        session: r.session,
        budget: { maxTokens: DEFAULT_MAX_TOKENS },
      });
      r.lastRecall = {
        status: res.status, candidates: res.candidates.length,
        injected: res.injected.length, detail: res.detail, at: Date.now(),
      };
      if (res.injected.length === 0) return;   // fail-closed：沉默优于噪声
      r.state.markInjected(res.injected.map((x) => x.memory.id));
      return { message: { customType: "reflective-memory", content: res.block, display: true } };
    } catch (e) {
      // 注入 fail-closed：任何意外都不许穿透到 agent 启动
      r.error = errText(e);
      return;
    }
  });

  pi.on("agent_end", async (event) => {
    const r = rt;
    if (!r) return;
    const texts = userTexts(event.messages).filter((t) => !r.digested.has(t));
    if (texts.length === 0) return;
    for (const t of texts) r.digested.add(t);
    const context = assistantText(event.messages);
    // 写入 fail-open 且不该拖住用户：排队后台跑，session_shutdown 冲刷。
    r.pending = r.pending
      .then(async () => {
        const res = await writeFlow(r.projectDb, r.globalDb, r.adapter, r.session, { userTexts: texts, context });
        r.lastWrite = { action: res.action, reason: res.reason, at: Date.now() };
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
    description: "长期记忆状态 / 搜索 / 查为什么 / 删除（/memory、search <词>、why <id>、forget <id>）",
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
