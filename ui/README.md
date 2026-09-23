# 面板（ui/）

`/memory ui` 打开的本机网页面板。Vite + Preact + TypeScript，**零运行时依赖**：
构建产物 `ui/dist/` 提交进仓库，由 `src/ui/server.ts` 当静态目录发出去 —— 使用者
不需要 npm install 就能用面板。

视觉规范在 [DESIGN.md](./DESIGN.md)，改样式前先读它（色值、字号、间距、圆角都只在那里定义一次）。

## 开发

```bash
cd ui
npm install
npm run dev        # http://127.0.0.1:5173，Vite 直接代理不到后端
```

`npm run dev` 只热更新前端；要连着真数据看，用下面这条：随便起一个 pi 会话（`/memory ui`），
把面板地址记下来，然后在 dev server 里调 API 时指向它 —— 面板的 `/api/*` 请求是相对路径，
所以更省事的办法是直接 `npm run build`，刷新 `127.0.0.1:<port>`。

## 构建（改完必须跑）

```bash
cd ui && npm run build     # 产物落 ui/dist，记得一起提交
```

## 自检

```bash
npm test                                  # 仓库根：包含 tests/ui.ts（接口 + 安全线，不起浏览器）
npx tsc --noEmit                          # 类型检查（Vite 不做类型检查）
node test/e2e.mjs                         # 真浏览器自检（需要 playwright）
node test/e2e.mjs --shots /tmp/shots      # 顺便截图（暗色 + 浅色，供设计走查）
```

`test/e2e.mjs` 不装依赖时不进 CI：它需要 `npm i -D playwright && npx playwright install chromium`。
它钉的是浏览器里才看得出来的事：六个视图两种主题都渲染、图谱点击与键盘可用、记忆原文
（含 `<img onerror>`）只当文字、控制台无报错。

## 结构

```
src/
  main.tsx        挂载 + 启动时问 /api/session（账号名不进 HTML）
  app.tsx         外壳：命令栏 / 左栏 / 主区 / 检视栏、hash 路由、全局键盘、命令面板
  graph.tsx       图谱：确定性径向布局（焦点居中 / 1 跳内环 / 2 跳外环）、缩放平移、筛选
  views.tsx       概览 / 记忆 / 待确认 / 近义堆 / 设置 + 右侧检视栏
  components.tsx  控件、图标、骨架、空状态、轨迹时间线、弹层、toast
  api.ts          /api/* 的类型与调用（改状态带 x-csrf）
  format.ts       时间、百分比、状态/类型/关系的中文标签
  styles/         tokens.css（唯一色值来源）+ app.css（布局与组件）
```

## 两条硬约束

1. **记忆原文是不可信输入。** 渲染只走 Preact 的文本节点；`ui/src` 里不许出现
   `innerHTML` / `dangerouslySetInnerHTML` / `__html`（`tests/ui.ts` 会扫源码断言这条）。
2. **接口形状不改。** 面板只消费 `src/ui/server.ts` 已有的 `/api/*`；要加字段就在服务端加，
   别在面板里造第二套（`tests/ui.ts` 钉着接口行为）。
