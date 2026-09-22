/**
 * JEV HTTP 客户端。
 *
 * 只做传输：组请求、发请求、解析答案、记 usage 和延迟。
 * 不含任何业务判断 —— 判断在 adapter.ts，兜底在 rule.ts。
 *
 * 实测（2026-09-22）：
 *   - 同一次调用里放 3 个问题和放 20 个问题耗时一样（0.99s / 0.97s），问题并行评估，
 *     所以「多次判断合并成一次调用」是本设计的核心省钱手段。
 *   - 单次 68 问题：输入 4946 tokens ≈ $0.0002，1.16s。
 *   - 本机直连 api.typesafe.ai 被掐，必须走代理。Node 内置 fetch（undici）只跑
 *     HTTP/1.1，恰好绕过本机 Clash 的 HTTP/2 故障，所以不需要 ProxyAgent。
 */

export interface NoulQuestion {
  type: "noul";
  instructions: string;
}
export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}
export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

export interface NoulAnswer { type: "noul"; noul: number }
export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
export interface ScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
  legend?: Record<string, string>;
}
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevResponse {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
}

export interface JevClientConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  /** 注入点，测试时替换掉 fetch。 */
  fetchImpl?: typeof fetch;
}

export class JevUnavailableError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
    this.name = "JevUnavailableError";
  }
}

export interface AskOptions {
  /** 本次调用的超时，覆盖客户端默认值。 */
  timeoutMs?: number;
  /** 失败后重试次数（只重试网络/超时，不重试 4xx）。 */
  retries?: number;
}

export class JevHttpClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private apiKey: string | undefined;

  constructor(config: JevClientConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.TYPESAFE_API_KEY;
    this.baseUrl = config.baseUrl ?? "https://api.typesafe.ai";
    this.model = config.model ?? "jev-latest";
    this.timeoutMs = config.timeoutMs ?? 3000;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  get available(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * 一次调用问完所有问题。抛 JevUnavailableError 由调用方降级，
   * 不在这里吞异常 —— 静默失败会让「没有记忆」和「记忆坏了」分不清（§6.2）。
   *
   * 关于重试：实测（2026-09-22）这条链路会偶发卡死 —— 同一段代码连跑时约每 8–16 次
   * 出现一次请求挂到超时（8 秒都回不来），而裸 fetch 连续 24 次又没有复现，
   * curl 走同一条代理也只要 1 秒。无法归因到我们这边，但重试一次能恢复。
   * 所以写入路径留一次重试；交互路径（before_agent_start）不重试 ——
   * 那里宁可不注入，也不能拖住用户。
   */
  async ask(state: string, questions: Questions, opts: AskOptions = {}): Promise<JevResponse> {
    if (!this.apiKey) throw new JevUnavailableError("TYPESAFE_API_KEY 未设置");

    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const attempts = 1 + Math.max(0, opts.retries ?? 0);
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.once(state, questions, timeoutMs);
      } catch (e) {
        lastError = e;
        // 4xx/5xx 是服务端的确定回答，重试没意义。
        if (e instanceof JevUnavailableError && /^HTTP 4/.test(e.message)) break;
      }
    }
    throw lastError;
  }

  private async once(state: string, questions: Questions, timeoutMs: number): Promise<JevResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: this.model, state, questions }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // 超时、DNS、代理挂掉都走这里。
      throw new JevUnavailableError(`请求失败: ${(e as Error).message}`, e);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new JevUnavailableError(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as JevResponse;
  }
}
