/**
 * 面板的真浏览器自检（可选，不进 npm test：它需要 playwright 和一个 Chromium）。
 *
 * 跑法：
 *   npm i -D playwright && npx playwright install chromium   # 只在需要时装
 *   node ui/test/e2e.mjs                # 断言
 *   node ui/test/e2e.mjs --shots /tmp/x # 顺便把每个视图截下来（暗色 + 浅色）
 *
 * 它钉三件浏览器里才看得出来的事：
 *   1. 记忆原文（含 <img onerror>）只当文字显示，DOM 里不许出现注入的元素；
 *   2. 每个视图都能渲染出来，且控制台没有报错；
 *   3. 键盘路径真的能用（g+数字切视图、j/k 选行、⌘K 面板）。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as assert from "node:assert/strict";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rs-ui-e2e-"));
process.env.REFLECTIVE_HOME = tmp;
fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ typesafe: { apiKey: "test" } }), { mode: 0o600 });

const { openDb, insertMemory, addTrace, enqueueReview, putEmbedding } = await import("../../src/storage/db.ts");
const { startUi } = await import("../../src/ui/server.ts");
const { embed } = await import("../../src/embed/encoder.ts");
const { chromium } = await import("playwright");

const project = openDb(path.join(tmp, "projects", "projA.db"));
const global = openDb(path.join(tmp, "global.db"));
const ATTACK = '正常内容 <img src=x onerror="window.__xss=1"> 后面还有';
const attack = insertMemory(project, { content: ATTACK, type: "fact", scope: "project", scopeId: "projA", topic: "安全", importance: 0.8 });
const rule = insertMemory(project, { content: "提交一律一个模块一个提交，message 用英文。", type: "preference", scope: "project", scopeId: "projA", topic: "提交流程", importance: 0.9 });
const cold = insertMemory(project, { content: "旧接口 /v1/legacy 已废弃。", type: "fact", scope: "project", scopeId: "projA", importance: 0.3 });
for (const m of [attack, rule, cold]) putEmbedding(project, m.id, await embed(m.content));
addTrace(project, { memoryId: rule.id, stage: "write", gate: "J1+J2+J3", action: "keep", reason: "preference/project → project（0.98/0.95）", confidence: 0.95, status: "ok", latencyMs: 500, userVisible: "记住了这条（引擎判断）" });
enqueueReview(project, { kind: "merge", memoryId: attack.id, otherId: rule.id, question: "这两条要合并吗？", options: ["保留两条", "合并"] });
insertMemory(global, { content: "回答默认用中文。", type: "preference", scope: "global", importance: 0.7 });

const ui = await startUi({ projectDb: project, globalDb: global, projectId: "projA" });
const origin = new URL(ui.url).origin;

const setup = await fetch(`${origin}/api/setup`, { method: "POST", redirect: "manual", body: new URLSearchParams({ username: "me", password: "s3cret-pass" }) });
const cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0];
const cookiePair = cookie.split(";")[0];
assert.match(cookiePair, /^rs_ui=/, "要能登录（首次设置）");

const shotsDir = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1512, height: 950 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
const url = new URL(origin);
await page.context().addCookies([{ name: "rs_ui", value: cookiePair.split("=")[1], domain: url.hostname, path: "/" }]);

const shots = [];
for (const theme of ["dark", "light"]) {
  for (const id of ["overview", "graph", "memories", "pending", "dupes", "settings"]) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(`${origin}/#/${id}`);
    await page.evaluate((t) => localStorage.setItem("rs-theme", t), theme);
    await page.reload();
    await page.waitForSelector(".shell", { timeout: 15000 });
    await page.waitForTimeout(900);   // 等数据 + 动效落地
    if (shotsDir) {
      const file = path.join(shotsDir, `${theme}-${id}.png`);
      await page.screenshot({ path: file, fullPage: false });
      shots.push([theme, file, theme]);
    }
    if (id === "graph") {
      const nodes = await page.locator(".graph-node").count();
      assert.ok(nodes >= 3, `图谱要画得出节点，实际 ${nodes}`);
      // 点节点要能设焦点，并且焦点节点落在画布中心附近（拖动坐标、指针捕获都会破坏这条）
      // 用坐标点击：SVG <g> 的可点击区域是圆和标签的并集，playwright 的稳定性判定
      // 对这种会重排的图不友好（而且用户本来就是点坐标）。
      const dot = await page.locator(".graph-node").first().locator("circle").first().boundingBox();
      await page.mouse.click(dot.x + dot.width / 2, dot.y + dot.height / 2);
      await page.waitForTimeout(600);
      assert.equal(await page.locator(".graph-overlay").getByText(/^焦点/).count(), 1, "点节点要出现焦点标记");
      const canvas = await page.locator(".graph-canvas").boundingBox();
      const node = await page.locator(".graph-node").first().locator("circle").first().boundingBox();
      const off = Math.hypot(node.x + node.width / 2 - (canvas.x + canvas.width / 2), node.y + node.height / 2 - (canvas.y + canvas.height / 2));
      assert.ok(off < 40, `焦点节点要居中，实际偏了 ${Math.round(off)}px`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      assert.equal(await page.locator(".graph-overlay").getByText(/^焦点/).count(), 0, "Esc 要回到全库概览");
    }
    if (id === "memories") {
      const rows = await page.locator("table.grid tbody tr").count();
      assert.ok(rows >= 3, `记忆列表要有行，实际 ${rows}`);
      // 键盘：j 选行 → 右侧详情出现
      await page.locator("body").click({ position: { x: 400, y: 600 } });
      await page.keyboard.press("j");
      await page.waitForTimeout(200);
      assert.equal(await page.locator(".inspector").count(), 1, "按 j 应该打开右侧详情");
    }
    if (id === "pending") {
      assert.ok((await page.locator(".review-option").count()) >= 2, "待确认要有选项按钮");
    }
    if (id === "settings") {
      assert.ok((await page.locator("fieldset").count()) >= 4, "设置要有分组的字段集");
    }
  }
}

// 键盘切视图：g 然后数字
await page.goto(`${origin}/#/overview`);
await page.waitForSelector(".shell");
await page.keyboard.press("g");
await page.keyboard.press("3");
await page.waitForTimeout(300);
assert.equal(await page.locator(".view-head h1").first().textContent(), "记忆", "g 3 应该切到记忆视图");

// ⌘K 命令面板
await page.keyboard.press("Control+k");
await page.waitForTimeout(200);
assert.equal(await page.locator(".palette").count(), 1, "Ctrl+K 应该打开命令面板");
await page.keyboard.press("Escape");

// XSS：攻击串只能当文字，不能变成 DOM，也不能执行
await page.goto(`${origin}/#/memories`);
await page.waitForSelector("table.grid");
const cell = page.locator(`td.cell-content`, { hasText: "正常内容" });
assert.ok((await cell.count()) >= 1, "攻击串应该作为文字出现在列表里");
assert.equal(await page.locator("img").count(), 0, "记忆原文里的 <img> 不许变成 DOM");
assert.equal(await page.evaluate(() => window.__xss), undefined, "onerror 不许执行");
if (shotsDir) {
  await page.locator(`tr:has-text("正常内容")`).first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shotsDir, "dark-inspector.png") });
}

assert.deepEqual(errors, [], `控制台不该有报错：${errors.join(" | ")}`);
await browser.close();
ui.close();
console.log(`✓ 浏览器自检：6 个视图两种主题都渲染、键盘可用、记忆原文没变成 DOM${shotsDir ? `（截图 ${shots.length + 1} 张 → ${shotsDir}）` : ""}`);
