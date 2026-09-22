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

export interface LoadedConfig {
  config: JevConfig;
  /** 读取时发现的问题。降级时必须把这些说出去，不能静默（§6.2）。 */
  problems: string[];
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

  return { config, problems };
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
