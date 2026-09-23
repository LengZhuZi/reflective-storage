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

const ui = await startUi({ defaultProject: "projA" });
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
    // 图谱库是动态加载的（cytoscape 单独一个 chunk），实例建好之前拿不到 probe
    if (id === "graph") await page.waitForFunction(() => Boolean(window.__rsGraphProbe), { timeout: 20000 });
    if (shotsDir) {
      const file = path.join(shotsDir, `${theme}-${id}.png`);
      await page.screenshot({ path: file, fullPage: false });
      shots.push([theme, file, theme]);
    }
    if (id === "graph") {
      // canvas 画出来的节点 DOM 里没有，所以两端对账：可达列表里有几个，cy 里就有几个。
      const a11y = await page.locator(".graph-node-a11y").count();
      assert.ok(a11y >= 3, `图谱要画得出节点（可达列表），实际 ${a11y}`);
      const drawn = await page.evaluate(() => (window).__rsGraphProbe?.nodeCount() ?? 0);
      assert.equal(drawn, a11y, "canvas 上的节点数要和可达列表一致");
      // 点节点要能设焦点，而且焦点节点落在画布中心附近（焦点居中这条是手感的核心）
      const first = page.locator(".graph-node-a11y").first();
      const id = await first.getAttribute("data-id");
      // 这份列表是故意隐藏的（给键盘和读屏看），指针点不到它 —— 直接派发 click 事件，
      // 走的是同一条处理路径（就当成键盘用户按了 Enter）。
      await first.dispatchEvent("click");
      await page.waitForTimeout(500);
      assert.equal(await page.locator(".graph-overlay").getByText(/^焦点/).count(), 1, "点节点要出现焦点标记");
      const probe = await page.evaluate((nid) => {
        const p = (window).__rsGraphProbe;
        return p ? { pos: p.renderedCenter(nid), canvas: p.canvas() } : null;
      }, id);
      assert.ok(probe?.pos, "要能从 cy 问到节点位置");
      const off = Math.hypot(probe.pos.x - probe.canvas.w / 2, probe.pos.y - probe.canvas.h / 2);
      assert.ok(off < 40, `焦点节点要居中，实际偏了 ${Math.round(off)}px`);
      // 键子选：方向键换节点，Enter 开详情
      await page.locator(".graph-canvas-host").focus();   // 键盘事件要落在这个容器上（canvas 挡住指针）
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(300);
      const moved = await page.locator(".graph-node-a11y[aria-current=true]").count();
      assert.equal(moved, 1, "方向键要能选中下一个节点");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      assert.equal(await page.locator(".graph-overlay").getByText(/^焦点/).count(), 0, "Esc 要回到全库概览");
      // 分层画法：切过去后 cy 里还应该有节点（直接跑一次分层布局）
      await page.locator(".seg-item", { hasText: "分层" }).click();
      await page.waitForTimeout(800);
      const treeNodes = await page.evaluate(() => (window).__rsGraphProbe?.nodeCount() ?? 0);
      assert.equal(treeNodes, a11y, "分层画法也要把节点都画出来");
      await page.locator(".seg-item", { hasText: "关系图" }).click();
      await page.waitForTimeout(500);
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

// 合并视图 = 默认视图：选库的下拉要列出项目，项目过滤能隐藏其中的一个
await page.goto(`${origin}/#/graph`);
await page.waitForSelector(".shell");
await page.waitForTimeout(600);
await page.waitForFunction(() => Boolean(document.querySelector(".graph-node-a11y")) || Boolean(window.__rsGraphProbe), { timeout: 20000 });
const scopeSelect = page.locator(".topbar select");
assert.equal(await scopeSelect.inputValue(), "all", "默认应该看全部项目");
assert.ok((await page.locator(".view-head").getByText("全部项目").count()) >= 1, "视图头要写明当前看的是全部项目");
const before = await page.locator(".graph-node-a11y").count();
await page.getByRole("button", { name: "项目过滤" }).click();
await page.waitForSelector(".dialog", { timeout: 5000 });
assert.equal(await page.locator(".dialog .filterrow").count(), 2, "过滤列表里要有全局库 + 每个项目（磁盘上的库也算）");
await page.locator(".dialog .filterrow input").first().click();   // 取消勾选第一个项目
await page.waitForTimeout(400);
assert.ok((await page.locator(".graph-node-a11y").count()) < before, "隐藏一个项目后节点要变少");
await page.locator(".dialog").getByRole("button", { name: "知道了" }).click();
await page.reload();
await page.waitForSelector(".shell");
await page.waitForTimeout(600);
assert.ok((await page.locator(".graph-node-a11y").count()) < before, "隐藏的选择要记住（localStorage）");
await page.evaluate(() => localStorage.removeItem("rs-hidden-projects"));
console.log("✓ 一个页面看所有项目：默认合并视图 + 项目过滤能隐藏");

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

// 图谱的两种画法：分层图要有主题/路径分组框，折叠要真的收起来，左栏要是同一棵树。
// 这几条是「图谱只是个点云」和「图谱能看出项目结构」的分界，坏了就等于退回上一版。
await page.goto(`${origin}/#/graph`);
await page.waitForSelector(".graph-canvas");
await page.waitForFunction(() => Boolean(window.__rsGraphProbe), { timeout: 20000 });
assert.ok((await page.locator(".rail-tree .rail-head").count()) >= 2, "左栏要是主题 → 路径的结构树，不是平铺列表");
const probe = () => page.evaluate(() => {
  const p = window.__rsGraphProbe;
  return p ? { nodes: p.nodeCount(), visible: p.visibleCount(), groups: p.groupCount() } : null;
});
// 关系图：主题是**复合节点**（不是画的圈），拖动它整团跟着走
assert.ok((await probe()).groups >= 1, "关系图要有主题复合节点（不然节点就是一堆没归属的点）");
await page.getByRole("button", { name: "分层", exact: true }).click();
await page.waitForTimeout(600);
const tree = await probe();
assert.ok(tree.groups >= 3, `分层图要有「库 → 主题 → 路径」的复合节点，实际 ${tree.groups}`);
// 折叠：左栏和画布共用同一份状态，折叠后子节点真的藏起来
const beforeCollapse = tree.visible;
await page.locator(".rail-tree .rail-head").nth(1).click();
await page.waitForTimeout(500);
assert.ok((await probe()).visible < beforeCollapse, "折叠要真的把子树藏起来（左栏和画布同一份状态）");
await page.locator(".rail-tree .rail-head").nth(1).click();
await page.waitForTimeout(400);
assert.equal((await probe()).visible, beforeCollapse, "展开要能回到原样");
if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "dark-tree.png") });
await page.getByRole("button", { name: "关系图", exact: true }).click();
await page.waitForTimeout(300);

assert.deepEqual(errors, [], `控制台不该有报错：${errors.join(" | ")}`);
await browser.close();
ui.close();
console.log(`✓ 浏览器自检：6 个视图两种主题都渲染、图谱两种画法 + 折叠、键盘可用、记忆原文没变成 DOM${shotsDir ? `（截图 ${shots.length + 1} 张 → ${shotsDir}）` : ""}`);
