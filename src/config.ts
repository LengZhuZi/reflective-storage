/**
 * 配置与凭据解析。
 *
 * 优先级：环境变量 > 配置文件 > 报错。
 *
 *   TYPESAFE_API_KEY    / config.typesafe.apiKey
 *   TYPESAFE_BASE_URL   / config.typesafe.baseUrl
 *   TYPESAFE_MODEL      / config.typesafe.model
 *   REFLECTIVE_PROXY    / config.proxy.http
 *
 * 凭据只在这两处、只在本机，绝不进仓库、日志和记忆。所以这个文件：
 *   - 不打印任何值，报错只说「哪个位置没拿到」，不说内容；
 *   - 权限不是 600 就**不读它**，并把原因写进 problems —— 权限不合规是能修的，
 *     静默使用只会让人永远不修（DESIGN.md §6.2：降级必须可见）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const ROOT = process.env.REFLECTIVE_HOME ?? path.join(os.homedir(), ".pi/agent/reflective-storage");
export const CONFIG_PATH = path.join(ROOT, "config.json");

/** 配置文件要求的权限位。600 = 只有属主可读写。 */
const REQUIRED_MODE = 0o600;

export interface JevConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  /** 配置文件里的 proxy.http。进程内改代理无效，所以这里只用来提示怎么启动。 */
  proxy?: string;
}

/**
 * 判断模型。**硬要求** —— 没有它这个扩展不启动（跟跑 Java 要 JDK 一样）。
 * 只接受「按类型化问题打分、不生成文本」的判断模型（JEV 就是这种）。
 */
export type JudgeProvider = "jev";

export interface JudgeConfig {
  provider: JudgeProvider;
  /** 判断模型可用吗。不可用 = 扩展不启动。 */
  ready: boolean;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** 交互路径（J7/J8）超时。宁可不注入，也不能拖住用户。 */
  timeoutMs: number;
  /** 写入路径（J1/J2/J3）超时。质量比延迟重要，且必须成功。 */
  writeTimeoutMs: number;
  /** 相关性阈值。JEV 标定值是 0.7；本地小模型分数普遍偏低时调小。 */
  relevanceThreshold: number;
  /** 配置不完整（例如 openai 没给 baseUrl）时的原因，降级时必须能说出来。 */
  problems: string[];
}

export interface LoadedConfig {
  config: JevConfig;
  judge: JudgeConfig;
  inject: InjectConfig;
  lifecycle: LifecycleConfig;
  recall: RecallConfig;
  proactive: ProactiveConfig;
  ui: UiConfig;
  refine: RefineConfig;
  /** 读取时发现的问题。降级时必须把这些说出去，不能静默（§6.2）。 */
  problems: string[];
}

/**
 * 本地网页面板（`/memory ui`）。面板是常驻进程（第一个会话把它 detached 起，之后所有会话
 * 共用同一份），所以端口默认固定：URL 能收藏，别的会话也能靠它找到已经在跑的面板。
 * `port: 0` 仍然有效 —— 让系统挑，实际端口写进 `ui.json` 供其他会话发现。
 */
export interface UiConfig {
  port: number;
}

/** 面板默认端口。改这里或 config.json 的 `ui.port`。 */
export const DEFAULT_UI_PORT = 4319;

/**
 * 提炼层（可选）。干的活是**生成**：把长回复压成一条记忆 + 给个主题名。
 * 判断还是 JEV 的，这里不做判断。不配就是关的（默认零外部依赖）。
 *
 * 只要能说 OpenAI 的 `/chat/completions`，云端和本机就是同一份代码，
 * 所以这里只有一张 provider 表，没有每个厂商一套实现。
 */
export interface RefineConfig {
  /** "off" = 不提炼，存原文。其他值见 REFINE_PROVIDERS，没登记的就当自定义端点。 */
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** 写入在后台队列里跑，可以给宽一点。 */
  timeoutMs: number;
  /** 提炼后的记忆上限（字）。长了截断，不丢整条。 */
  maxSummaryChars: number;
  problems: string[];
}

/** 常见端点。ollama / llama.cpp / vLLM 都是本机，keyless。 */
export const REFINE_PROVIDERS: Record<string, { baseUrl: string; model: string; keyless?: boolean }> = {
  hunyuan: { baseUrl: "https://api.hunyuan.cloud.tencent.com/v1", model: "hunyuan-lite" },
  zhipu: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  ollama: { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b", keyless: true },
};

/**
 * J16 主动召回（§4）。默认**开**，但每会话最多一次 —— 主动打扰的频率必须先保证不烦人。
 * 关掉就设 `proactive.enabled = false`。
 */
export interface ProactiveConfig {
  enabled: boolean;
  maxPerSession: number;
}

/**
 * 混合排序的权重（§10.2：`final_score = w1×jev_relevance + w2×vector + …`，默认偏向 JEV）。
 * 以前写死在代码里，现在可配 —— 有了 J15 的 cited 数据，「哪个权重更值」就有依据了。
 */
export interface RecallWeights {
  relevance: number;
  vector: number;
  topic: number;
  importance: number;
  recency: number;
}

export interface RecallConfig {
  weights: RecallWeights;
  /** 每一路召回各取多少条再合并（默认 50）。库里记忆多了可以调大，代价是本地排序压力。 */
  perSourceLimit: number;
}

export const DEFAULT_RECALL_WEIGHTS: RecallWeights = {
  relevance: 0.55, vector: 0.15, topic: 0.1, importance: 0.15, recency: 0.05,
};

/**
 * 生命周期开关（§9）。
 *
 * **删除是不可逆的，所以自动清理默认关**。打开之后：`scope='session'` 且超过
 * `sessionTtlDays` 天没被召回命中过的记忆直接销毁（不是归档）。
 * 只碰 session 作用域 —— global / project 记忆的清理仍走归档那条软路。
 */
export interface LifecycleConfig {
  autoCleanup: boolean;
  sessionTtlDays: number;
}

/** 注入策略（§8.3）。只管机械约束（次数上限、隔多少轮）；「是不是同一话题」归 J5。 */
export interface InjectConfig {
  maxPerSession: number;
  minTurnsBetween: number;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/** 每次调用都重新读。一次会话读一遍，几百字节，不值得做缓存。 */
export function loadConfig(): LoadedConfig {
  const problems: string[] = [];
  let file: Record<string, unknown> | null = null;

  if (!fs.existsSync(CONFIG_PATH)) {
    problems.push(`配置文件不存在：${CONFIG_PATH}`);
  } else {
    const mode = fs.statSync(CONFIG_PATH).mode & 0o777;
    if (mode !== REQUIRED_MODE) {
      problems.push(
        `配置文件权限是 0${mode.toString(8)}，要求 0${REQUIRED_MODE.toString(8)}；权限改对之前不读它：chmod 600 ${CONFIG_PATH}`,
      );
    } else {
      try {
        file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
      } catch (e) {
        problems.push(`配置文件解析失败（${CONFIG_PATH}）：${(e as Error).message}`);
      }
    }
  }

  const typesafe = (file?.typesafe ?? {}) as Record<string, unknown>;
  const proxy = (file?.proxy ?? {}) as Record<string, unknown>;
  const judge = (file?.judge ?? {}) as Record<string, unknown>;

  // 环境变量优先，配置文件的对应项当后备。
  const pick = (envKey: string, fromFile: unknown): string | undefined =>
    str(process.env[envKey]) ?? str(fromFile);

  const config: JevConfig = {
    apiKey: pick("TYPESAFE_API_KEY", typesafe.apiKey),
    baseUrl: pick("TYPESAFE_BASE_URL", typesafe.baseUrl),
    model: pick("TYPESAFE_MODEL", typesafe.model),
    proxy: pick("REFLECTIVE_PROXY", proxy.http),
  };
  const timeout = typesafe.timeoutMs;
  if (typeof timeout === "number" && timeout > 0) config.timeoutMs = timeout;

  return {
    config,
    judge: resolveJudge(judge, config),
    inject: resolveInject(file?.inject),
    lifecycle: resolveLifecycle(file?.lifecycle),
    recall: resolveRecall(file?.recall),
    proactive: resolveProactive(file?.proactive),
    ui: resolveUi(file?.ui),
    refine: resolveRefine(file?.refine),
    problems,
  };
}

/** 本地 UI 的端口。默认固定（见 DEFAULT_UI_PORT）；显示写 `port: 0` 才是「系统挑」。 */
function resolveUi(raw: unknown): UiConfig {
  const file = (raw ?? {}) as Record<string, unknown>;
  const p = file.port;
  return { port: typeof p === "number" && Number.isInteger(p) && p >= 0 && p < 65536 ? p : DEFAULT_UI_PORT };
}

/**
 * 提炼层。没配 provider（或 provider=off）就是关的 —— 默认不调任何外部模型。
 * 环境变量优先于配置文件，和 typesafe 那边一套规矩。
 */
function resolveRefine(raw: unknown): RefineConfig {
  const file = (raw ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  const env = (k: string) => str(process.env[k]);
  const provider = (env("REFLECTIVE_REFINE_PROVIDER") ?? str(file.provider) ?? "off").toLowerCase();
  const preset = REFINE_PROVIDERS[provider];
  const baseUrl = env("REFLECTIVE_REFINE_BASE_URL") ?? str(file.baseUrl) ?? preset?.baseUrl;
  const model = env("REFLECTIVE_REFINE_MODEL") ?? str(file.model) ?? preset?.model;
  const apiKey = env("REFLECTIVE_REFINE_API_KEY") ?? str(file.apiKey);
  // **默认不超时**（0）：摘要是必须的，慢也得等。
  //
  // 原来是 8s，而提炼的输入现在是回复全文（实测 6465 字 ≈ 3.5k 输入 token，glm-4-flash
  // 要 11.2s）—— 8s 会让长回复的提炼**全部静默超时**，表现像“提炼得真烂”，
  // 真相是根本没提炼（fail-open 存原文，只有轨迹里看得见）。
  // 想设上限仍然可以（`refine.timeoutMs: 20000`），但别为了省等待把摘要丢掉。
  // 代价：写入队列在 `session_shutdown` 会被等，端点挂着不回就是退出时等（无上限）。
  const timeout = typeof file.timeoutMs === "number" && file.timeoutMs > 0 ? file.timeoutMs : 0;
  // 默认 600：提炼要的是**要点**（文件名/路径/版本号/结论），不是一句话总结。
  // 原来 120 字只能容纳一句抽象结论，下个会话问细节就只能看到“质量集中在某目录”这种。
  const maxChars = typeof file.maxSummaryChars === "number" && file.maxSummaryChars > 0 ? file.maxSummaryChars : 600;

  const off = provider === "off" || provider === "none" || provider === "";
  if (!off) {
    if (!baseUrl) problems.push(`提炼后端 ${provider} 没有端点：填 refine.baseUrl，或换成登记过的 provider（${Object.keys(REFINE_PROVIDERS).join(" / ")}）`);
    if (!model) problems.push(`提炼后端 ${provider} 没有模型名：填 refine.model`);
    if (!apiKey && !preset?.keyless) problems.push("提炼后端没有 key：填 refine.apiKey 或设 REFLECTIVE_REFINE_API_KEY");
  }

  return {
    provider: off ? "off" : provider,
    apiKey,
    baseUrl,
    model,
    timeoutMs: timeout > 0 ? Math.max(500, Math.floor(timeout)) : 0,
    maxSummaryChars: Math.max(24, Math.floor(maxChars)),
    problems,
  };
}

/** J16 开关。默认开、每会话 1 次。 */
function resolveProactive(raw: unknown): ProactiveConfig {
  const file = (raw ?? {}) as Record<string, unknown>;
  const n = file.maxPerSession;
  return {
    enabled: file.enabled !== false,
    maxPerSession: typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1,
  };
}

/** 召回权重。只从配置文件读；缺项或给了非法值就按默认。 */
function resolveRecall(raw: unknown): RecallConfig {
  const file = (raw ?? {}) as Record<string, unknown>;
  const w = (file.weights ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
  const limit = file.perSourceLimit;
  return {
    perSourceLimit: typeof limit === "number" && Number.isInteger(limit) && limit >= 5 ? limit : 50,
    weights: {
      relevance: num(w.relevance, DEFAULT_RECALL_WEIGHTS.relevance),
      vector: num(w.vector, DEFAULT_RECALL_WEIGHTS.vector),
      topic: num(w.topic, DEFAULT_RECALL_WEIGHTS.topic),
      importance: num(w.importance, DEFAULT_RECALL_WEIGHTS.importance),
      recency: num(w.recency, DEFAULT_RECALL_WEIGHTS.recency),
    },
  };
}

/** 生命周期开关。同样只从配置文件读。 */
function resolveLifecycle(raw: unknown): LifecycleConfig {
  const file = (raw ?? {}) as Record<string, unknown>;
  const days = typeof file.sessionTtlDays === "number" && file.sessionTtlDays >= 1 ? Math.floor(file.sessionTtlDays) : 90;
  return { autoCleanup: file.autoCleanup === true, sessionTtlDays: days };
}

/** 注入策略。只从配置文件读 —— 行为开关放文件里，环境变量留给凭据和端点。 */
function resolveInject(raw: unknown): InjectConfig {
  const file = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER) =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
  return {
    maxPerSession: num(file.maxPerSession, 5, 1),
    minTurnsBetween: num(file.minTurnsBetween, 1, 1),
  };
}

/**
 * 判断引擎档位与它自己的参数。
 *
 * 优先级：`REFLECTIVE_JUDGE_*` 环境变量 > `TYPESAFE_*` 环境变量 > `judge.*` 配置
 * > `typesafe.*` 配置 > 默认值。两套环境变量名都认，是为了让只想换模型、不想重写
 * 配置文件的人只改一个变量。
 *
 * 判断模型是硬要求：没配就没有可用的判断模型，扩展拒绝启动（不退化）。
 * 不会出现「没配 key 于是什么都不发生」这种默认体验。
 */
function resolveJudge(file: Record<string, unknown>, base: JevConfig): JudgeConfig {
  const problems: string[] = [];
  const env = (key: string) => str(process.env[key]);

  const explicit = env("REFLECTIVE_JUDGE_PROVIDER") ?? str(file.provider);
  const provider: JudgeProvider = "jev";
  if (explicit && explicit !== "jev") {
    problems.push(`judge.provider 只支持 jev（判断模型是硬要求，没有就退化成规则这类档位不存在）：收到 ${explicit}`);
  }

  const slot = (envJudge: string, fileJudge: unknown, inherited: string | undefined): string | undefined =>
    env(envJudge) ?? str(fileJudge) ?? inherited;
  const apiKey = slot("REFLECTIVE_JUDGE_API_KEY", file.apiKey, base.apiKey);
  const baseUrl = slot("REFLECTIVE_JUDGE_BASE_URL", file.baseUrl, base.baseUrl);
  const model = slot("REFLECTIVE_JUDGE_MODEL", file.model, base.model);
  if (!apiKey) {
    problems.push(`没有判断模型的 key：环境变量 TYPESAFE_API_KEY / REFLECTIVE_JUDGE_API_KEY，或 ${CONFIG_PATH} 的 typesafe.apiKey`);
  }

  const num = (envKey: string, fallback: number): number => {
    const n = Number(process.env[envKey]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const fileNumber = (v: unknown, fallback: number): number => (typeof v === "number" && v >= 0 ? v : fallback);
  const threshold = env("REFLECTIVE_JUDGE_THRESHOLD");

  return {
    provider,
    ready: Boolean(apiKey),
    apiKey,
    baseUrl,
    model,
    timeoutMs: num("REFLECTIVE_JUDGE_TIMEOUT_MS", fileNumber(file.timeoutMs, 2500)),
    writeTimeoutMs: num("REFLECTIVE_JUDGE_WRITE_TIMEOUT_MS", fileNumber(file.writeTimeoutMs, 8000)),
    relevanceThreshold: threshold !== undefined && Number.isFinite(Number(threshold))
      ? Number(threshold)
      : fileNumber(file.relevanceThreshold, 0.7),
    problems,
  };
}

/**
 * 没拿到 key 时的报错。要能照着修，所以写清两个位置和权限要求 —— 只报一句
 * 「未设置」会让人去翻代码找路径（§6.2）。
 */
export function missingKeyReason(problems: readonly string[]): string {
  return [
    `JEV 不可用：没拿到 TYPESAFE_API_KEY（环境变量，或 ${CONFIG_PATH} 的 typesafe.apiKey，权限必须 600）`,
    ...problems,
  ].join(" ｜ ");
}

/**
 * 代理提示。
 *
 * Node 的内置 fetch（undici）只有在**进程启动前**设了 NODE_USE_ENV_PROXY=1 才读
 * HTTP_PROXY/HTTPS_PROXY；进程内再设没用。所以这里只能提示，不能自己修 ——
 * 但必须提示：不提示的话表现就是「JEV 一直超时」，看不出是代理没生效。
 */
export function proxyHint(config: JevConfig): string | null {
  if (!config.proxy) return null;
  const envProxy = process.env.HTTP_PROXY ?? process.env.HTTPS_PROXY;
  if (envProxy && process.env.NODE_USE_ENV_PROXY === "1") return null;
  const p = config.proxy;
  return [
    `reflective-storage：配置里有代理 ${p}，但这次启动没让它生效。`,
    envProxy
      ? "HTTP_PROXY 有值，缺 NODE_USE_ENV_PROXY=1 —— Node 的内置 fetch 默认不读代理变量。"
      : "环境里没有 HTTP_PROXY。",
    "两者都必须在**进程启动前**设好，进程内改无效。退出后这样启动 pi：",
    `  NODE_USE_ENV_PROXY=1 HTTP_PROXY=${p} HTTPS_PROXY=${p} pi`,
  ].join("\n");
}
