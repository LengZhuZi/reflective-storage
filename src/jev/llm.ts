/**
 * OpenAI 兼容的判断引擎 —— 让这套东西不只绑在 JEV 上。
 *
 * 为什么这个形状最省事：整套设计里判断引擎只需要回答一件事 ——
 * 「给我一段 state 和一组带类型的问题，返回同名的类型化答案」。JEV HTTP 是这样，
 * 任何 chat completions 端点也能这样。于是这里只做两件事：
 *
 *   1. 把 Questions 编译成一段要求「只回 JSON」的 prompt；
 *   2. 把回复解析回和 JEV 完全一样的 JevResponse 形状。
 *
 * 之后 createJevAdapter() 不用改一行 —— 它只依赖 client.ask(state, questions, opts)。
 * 这就是 DESIGN §5「判断与传输分离」想要的效果：换引擎不换流程，也不换失败姿态。
 *
 * 铁律不变：只让模型输出数字和枚举标签，**不让它生成记忆原文**（§15 原则 1）。
 *
 * 能用的端点（都实现 /chat/completions）：OpenAI、DeepSeek、Ollama
 * (`http://localhost:11434/v1`)、LM Studio、vLLM、DashScope 兼容模式等。
 * 本地小模型的判断质量一定不如 JEV —— 分数尺度也不同，所以阈值跟着引擎走
 * （见 JevAdapter.relevanceThreshold）。
 */

import { JevUnavailableError, type Answer, type AskOptions, type JevResponse, type Question, type Questions } from "./http.ts";

export interface LlmClientConfig {
  /** 形如 https://api.deepseek.com/v1 或 http://localhost:11434/v1（不带 /chat/completions）。 */
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function compile(state: string, questions: Questions): string {
  const lines: string[] = [];
  for (const [key, q] of Object.entries(questions)) {
    lines.push(`- key "${key}" (${q.type}): ${q.instructions}`);
    if (q.type === "choice") {
      lines.push(`  allowed values: ${Object.entries(q.criteria).map(([v, d]) => `${v} = ${d}`).join("; ")}`);
    }
  }
  return [
    "You are a strict classification component. Answer the questions about STATE below.",
    "Reply with JSON only, no prose, no markdown fences. Exact shape:",
    '{"answers":{"<key>":{"noul":0.0},"<key>":{"choice":"<one allowed value>","confidence":0.0,"probabilities":{"<value>":0.0}}}}',
    "Rules: include every key exactly once; noul and confidence are 0..1; probabilities sum to about 1;",
    "never add keys that were not asked; never write explanations; never invent text.",
    "",
    "STATE:",
    state,
    "",
    "QUESTIONS:",
    ...lines,
  ].join("\n");
}

/** 模型爱裹 ```json 围栏、爱加前后缀，这里只做最小清洗，不做「猜」。 */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("回复里没有 JSON 对象");
  return JSON.parse(body.slice(start, end + 1));
}

const clamp01 = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
};

/**
 * 把模型的 JSON 归一成 JevResponse。
 *
 * 答案缺失或类型不对时**不补默认值**，直接不放进 answers —— 上层的 missingAnswers()
 * 会把 status 标成 degraded，和「模型说无关」区分开（§6.2 的核心要求）。
 */
export function parseAnswers(raw: unknown, questions: Questions): Record<string, Answer> {
  const answers = (raw as { answers?: Record<string, unknown> })?.answers;
  const out: Record<string, Answer> = {};
  if (!answers || typeof answers !== "object") return out;

  for (const [key, q] of Object.entries(questions)) {
    const a = (answers as Record<string, unknown>)[key] as Record<string, unknown> | undefined;
    if (!a || typeof a !== "object") continue;
    if (q.type === "noul") {
      if (a.noul === undefined) continue;
      out[key] = { type: "noul", noul: clamp01(a.noul) };
      continue;
    }
    if (q.type === "choice") {
      const choice = typeof a.choice === "string" ? a.choice.trim() : "";
      if (!choice) continue;
      const probs: Record<string, number> = {};
      for (const opt of Object.keys(q.criteria)) {
        const p = (a.probabilities as Record<string, unknown> | undefined)?.[opt];
        if (p !== undefined) probs[opt] = clamp01(p);
      }
      out[key] = { type: "choice", choice, confidence: clamp01(a.confidence ?? 0), probabilities: probs };
    }
  }
  return out;
}

export class LlmClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: LlmClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs ?? 3000;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async ask(state: string, questions: Questions, opts: AskOptions = {}): Promise<JevResponse> {
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: compile(state, questions) }],
          temperature: 0,
          // JSON 模式：支持的端点会强约束输出；不支持的端点忽略这个字段。
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // 复用同一个错误类：adapter 靠它区分「没连上」(unavailable) 和「答案不全」(degraded)。
      throw new JevUnavailableError(`LLM 请求失败: ${(e as Error).message}`, e);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new JevUnavailableError(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const payload = (await res.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = payload.choices?.[0]?.message?.content ?? "";
    const parsed = parseAnswers(extractJson(content), questions);
    return {
      model: payload.model ?? this.model,
      answers: parsed,
      usage: {
        input_tokens: payload.usage?.prompt_tokens ?? 0,
        output_tokens: payload.usage?.completion_tokens ?? 0,
      },
    };
  }
}
