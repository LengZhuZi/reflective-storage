/**
 * 配置与凭据自检：环境变量覆盖配置文件、权限把关、缺失/损坏时报错可读。
 *
 * 跑法：node tests/config.ts
 * 不联网。这里用一个临时 REFLECTIVE_HOME，所以不碰真实的 ~/.pi 配置，
 * 也永远不会打印任何凭据 —— 断言只检查「哪个位置拿到了/没拿到」。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reflect-config-"));
process.env.REFLECTIVE_HOME = tmp;
for (const k of ["TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "TYPESAFE_MODEL", "REFLECTIVE_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "NODE_USE_ENV_PROXY"]) {
  delete process.env[k];
}

const { loadConfig, missingKeyReason, proxyHint, CONFIG_PATH } = await import("../src/config.ts");
const { JevHttpClient, JevUnavailableError } = await import("../src/jev/http.ts");

const write = (body: string, mode = 0o600) => {
  fs.writeFileSync(CONFIG_PATH, body, { mode });
  fs.chmodSync(CONFIG_PATH, mode);
};

assert.equal(CONFIG_PATH, path.join(tmp, "config.json"), "配置文件路径必须跟着 REFLECTIVE_HOME 走");

// ------------------------------------------------------------ 文件不存在
assert.ok(!fs.existsSync(CONFIG_PATH));
const missing = loadConfig();
assert.equal(missing.config.apiKey, undefined);
assert.equal(missing.problems.length, 1);
assert.match(missing.problems[0], /配置文件不存在/);
assert.ok(missing.problems[0].includes(CONFIG_PATH), "报错要带路径，否则得自己去翻代码找");
const reason = missingKeyReason(missing.problems);
assert.ok(reason.includes(CONFIG_PATH) && reason.includes("600"), "没拿到 key 的报错要写清两个来源和权限要求");
assert.equal(new JevHttpClient().available, false);
const thrown = await new JevHttpClient().ask("s", {}).catch((e: unknown) => e);
assert.ok(thrown instanceof JevUnavailableError);
assert.ok(String((thrown as Error).message).includes(CONFIG_PATH), "JEV 不可用的报错也要能照着修");
assert.ok(String((thrown as Error).message).length < 300, "这条会进 reflection_traces 的 detail，别长到被截掉关键信息");
console.log("✓ 文件不存在：不静默，报错写明路径和两个来源");

// ------------------------------------------------------------ 配置文件生效
const BODY = JSON.stringify({
  typesafe: { apiKey: "file-key", baseUrl: "https://file.example", model: "file-model", timeoutMs: 4321 },
  proxy: { http: "http://127.0.0.1:7897" },
});
write(BODY);
const fromFile = loadConfig();
assert.deepEqual(fromFile.problems, [], "600 权限的健康文件不该报问题");
assert.equal(fromFile.config.apiKey, "file-key");
assert.equal(fromFile.config.baseUrl, "https://file.example");
assert.equal(fromFile.config.model, "file-model");
assert.equal(fromFile.config.timeoutMs, 4321);
assert.equal(fromFile.config.proxy, "http://127.0.0.1:7897");

const client = new JevHttpClient({ fetchImpl: async () => new Response("{}") });
assert.equal(client.available, true);
assert.equal(client.config.model, "file-model");
assert.equal(client.config.timeoutMs, 4321);
console.log("✓ 配置文件生效（含 proxy 和 timeoutMs）");

// ------------------------------------------------------------ 环境变量覆盖
process.env.TYPESAFE_API_KEY = "env-key";
process.env.TYPESAFE_BASE_URL = "https://env.example";
process.env.TYPESAFE_MODEL = "env-model";
process.env.REFLECTIVE_PROXY = "http://env-proxy:1080";
const overridden = loadConfig();
assert.equal(overridden.config.apiKey, "env-key", "环境变量必须覆盖配置文件");
assert.equal(overridden.config.baseUrl, "https://env.example");
assert.equal(overridden.config.model, "env-model");
assert.equal(overridden.config.proxy, "http://env-proxy:1080");
assert.equal(overridden.config.timeoutMs, 4321, "没有对应环境变量的项仍然用配置文件的值");
assert.equal(new JevHttpClient().config.apiKey, "env-key");
console.log("✓ 环境变量覆盖配置文件，未覆盖的项仍走文件");

for (const k of ["TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "TYPESAFE_MODEL", "REFLECTIVE_PROXY"]) delete process.env[k];

// ------------------------------------------------------------ 权限过于宽松
write(BODY, 0o644);
const loose = loadConfig();
assert.equal(loose.problems.length, 1);
assert.match(loose.problems[0], /权限/);
assert.match(loose.problems[0], /0644/, "要说清实际权限是什么");
assert.match(loose.problems[0], /600/, "要说清要求是什么");
assert.match(loose.problems[0], /chmod 600/, "要给出可直接执行的修法");
assert.equal(loose.config.apiKey, undefined, "权限不合规就不读它：一个 644 的文件不该被当成可用凭据源");
assert.equal(new JevHttpClient().available, false);
// 但环境变量仍然优先，不受文件权限影响
process.env.TYPESAFE_API_KEY = "env-key";
assert.equal(loadConfig().config.apiKey, "env-key", "环境变量不该被一个权限不对的文件拖住");
assert.equal(loadConfig().problems.length, 1, "问题仍然要报出来，不能因为环境变量兜住了就静默");
delete process.env.TYPESAFE_API_KEY;
console.log("✓ 权限不是 600 就不读该文件，并说清实际权限、要求和修法");

// ------------------------------------------------------------ 文件坏了
write("{ 这不是 json");
const broken = loadConfig();
assert.equal(broken.config.apiKey, undefined);
assert.match(broken.problems[0], /解析失败/);
assert.ok(broken.problems[0].includes(CONFIG_PATH));
console.log("✓ JSON 解析失败时报错可读，不静默吞掉");

// ------------------------------------------------------------ 代理提示
write(BODY);
assert.match(proxyHint(loadConfig().config)!, /NODE_USE_ENV_PROXY=1/, "有代理但没开开关时必须提示开关");
assert.match(proxyHint(loadConfig().config)!, /HTTP_PROXY/, "提示里要给出可直接照抄的启动命令");
assert.match(proxyHint(loadConfig().config)!, /进程启动前/, "要说清进程内改无效，否则用户会白折腾");
process.env.HTTP_PROXY = "http://127.0.0.1:7897";
assert.match(proxyHint(loadConfig().config)!, /NODE_USE_ENV_PROXY=1/, "只设了 HTTP_PROXY 而没开开关，照样是没生效");
process.env.NODE_USE_ENV_PROXY = "1";
assert.equal(proxyHint(loadConfig().config), null, "开关和代理都齐了就不该再打扰用户");
delete process.env.HTTP_PROXY;
delete process.env.NODE_USE_ENV_PROXY;
assert.equal(proxyHint({}), null, "没有配代理就没什么可提示的");
console.log("✓ 代理提示：开关没开就说，齐了就闭嘴");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n全部通过");
