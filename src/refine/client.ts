/**
 * 提炼层：**可选**的生成后端。
 *
 * 干的活只有两件，都是「生成」：把一段长的助手回复压成一条精炼记忆、给个主题名。
 * 判断的活还是 JEV 的（§15 原则 1）—— 这里不判「值不值得记」，那是 J1；也不打分。
 *
 * 为什么做成可换的后端而不是内置本地模型：
 *  - 默认零外部进程、零模型文件是这个项目的卖点，装一个 GB 级模型当默认依赖就把它毁了。
 *  - 只要能说 OpenAI 的 `/chat/completions`，云端（混元 Lite 免费 / DeepSeek / OpenAI）和
 *    本机（ollama / llama.cpp / vLLM）就是同一份代码，多一个 provider 表都不用。
 *  所以这里只做**一个**接口：OpenAI 兼容的 chat completions。
 *
 * 失败姿态是 fail-open：提炼失败就存原文。提炼是有损的，宁可存长了也不能丢。
 */

import type { RefineConfig } from "../config.ts";

export class ChatUnavailableError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
    this.name = "ChatUnavailableError";
  }
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface ChatClientConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  /** 注入点，测试时替换掉 fetch。 */
  fetchImpl?: typeof fetch;
}

/** 只做传输：组请求、发请求、取正文。不含任何提炼口径（那在 refine.ts）。 */
export class ChatClient {
  readonly baseUrl: string;
  readonly model: string;
  readonly problems: readonly string[];
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly noKeyReason: string;

  constructor(cfg: ChatClientConfig & { problems?: readonly string[]; noKeyReason?: string } = {}) {
    this.apiKey = cfg.apiKey;
    this.baseUrl = (cfg.baseUrl ?? "").replace(/\/+$/, "");
    this.model = cfg.model ?? "";
    // 0 = 不超时：提炼是生成，摘要是必须的，慢也得等（默认就不设上限）。
    this.timeoutMs = cfg.timeoutMs ?? 0;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.problems = cfg.problems ?? [];
    this.noKeyReason = cfg.noKeyReason ?? "没配置提炼后端的 key";
  }

  get available(): boolean {
    return Boolean(this.apiKey && this.baseUrl && this.model);
  }

  /**
   * 一次非流式补全，返回正文。
   *
   * 带一次重试：实测这条链路（走本机代理 + 云端 API）会偶发挂到超时，
   * 而重试一次基本都能过 —— 和 JEV 客户端同一个结论。
   */
  async complete(messages: ChatMessage[], opts: { timeoutMs?: number; json?: boolean } = {}): Promise<string> {
    if (!this.available) throw new ChatUnavailableError(this.noKeyReason);
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.once(messages, timeoutMs, opts.json ?? false);
      } catch (e) {
        lastError = e;
        // 4xx 是服务端的确定回答（key 错、模型名错），重试没意义。
        if (e instanceof ChatUnavailableError && /^HTTP 4/.test(e.message)) break;
      }
    }
    throw lastError;
  }

  private async once(messages: ChatMessage[], timeoutMs: number, json: boolean): Promise<string> {
    const ac = new AbortController();
    // timeoutMs <= 0 = 不设上限：不加计时器，请求一直等着（摘要是必须的）。
    const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(), timeoutMs) : null;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0,
          ...(json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: ac.signal,
      });
    } catch (e) {
      if (timer) clearTimeout(timer);
      const aborted = (e as Error)?.name === "AbortError";
      throw new ChatUnavailableError(aborted ? `超时 ${timeoutMs}ms` : `连不上 ${this.baseUrl}：${(e as Error).message}`, e);
    }
    if (timer) clearTimeout(timer);

    const text = await res.text();
    if (!res.ok) throw new ChatUnavailableError(`HTTP ${res.status}：${text.slice(0, 200)}`);
    let body: { choices?: Array<{ message?: { content?: unknown } }> };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new ChatUnavailableError(`回的不是 JSON：${text.slice(0, 120)}`);
    }
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new ChatUnavailableError("回复是空的");
    return content;
  }
}
