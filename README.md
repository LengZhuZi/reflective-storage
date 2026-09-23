# Reflective Storage

pi 的本地长期记忆扩展。

写入时判断值不值得记，召回时判断该不该用，不用了会自己衰减、归档、遗忘。记忆存在本机
SQLite 文件里，判断走一个判断模型（必须有，见下）。

## 特性

- 自动写入：不用喊「记住」。说完一轮，值钱的那句自己进库
- 来源权重：用户说的 trust 1.0，模型说的低一档、注入时带「未经用户确认」标记；涨跌只看
  可观测的事（用户默许 / 撞上反证），而模型说的要不要写、要靠这一轮的工具结果背书
- 自动召回：会话首轮和新话题开始时，把相关的旧记忆追加在上下文尾部
- 判断模型可换：同类判断模型（按类型化问题打分）实现一个 `ask` 就能接
- 作用域隔离：一个项目一个库，SQL 层硬过滤，跨项目引用要显式点名
- 生命周期：巩固、衰减、归档、复活；session 记忆可配自动清理
- 人工兜底：拿不准的（合并、冲突、作用域）排队问你，不替你拍；主题由模型自己定，不占你的点击
- `/memory ui`：本机网页面板。一个页面看**所有项目**的图谱（合并视图里主题相同的跨项目也能连上），可切单个项目 / 全局库、可隐藏不看的项目；图谱两种画法（关系图力导向 + 主题→路径→记忆的分层树）、分布面板（类型/状态/作用域/来源）、看轨迹、看近义堆、删除、复核

## 声明

本项目完全由 **vibe coding（氛围编程）** 写成：目标和取舍由人定，代码由 AI 生成，逐轮跑测试、
实测、返工。没有经过正式评审，也没有生产验证。免责条款见 [DISCLAIMER.md](./DISCLAIMER.md)。

## 要求

- Node 24+（用到内置 `node:sqlite`）
- **一个判断模型的 key**：现在接的是 [JEV](https://console.typesafe.ai/keys)（TypeSafe AI）。
  没有可用的判断模型这个扩展不启动 —— 判断与生成分离是这套设计的地基，不退化到规则或对话模型。

## 安装

```bash
git clone <repo> && cd ReflectiveStorage
npm install --ignore-scripts      # 见下
bash scripts/fetch-model.sh       # 本地 embedding 模型 24MB，拉一次
```

`--ignore-scripts` 必需：`onnxruntime-node` 的 postinstall 会去 `api.nuget.org` 下 CUDA EP，
而 CPU 版动态库已打包在 npm 包里，下不到也不影响运行。

## 用法

挂进 pi 后不需要命令。事件映射：

| pi 事件 | 做什么 |
| --- | --- |
| `session_start` | 开库、刷新项目注册表、跑一次懒生命周期 |
| `before_agent_start` | 问 J5 要不要查 → 召回 → J7 重排 → J8 决定注入 |
| `agent_end` | 取用户本轮的话 → 写入判断 → 落库 |
| `session_compact` | 解锁「已注入」，压缩后允许重新注入 |
| `agent_settled` | 主动提醒（每会话最多一次） |
| `session_shutdown` | 冲刷写入队列、关库 |

命令：

```
/memory                 状态（库大小、注入次数、上次召回/写入/提醒、配置问题）
/memory search <词>      关键词 + 向量召回，带分数
/memory why <id>         这条为什么被记住（判断轨迹 + 一句人话）
/memory review           待确认队列，逐条问（合并 / 冲突 / 作用域）
/memory topics           主题列表
/memory topic <名>       某主题下的记忆
/memory projects         项目注册表
/memory ui               打开网页面板（常驻进程：第一个会话拉起，之后就一直是这个地址）
/memory ui stop          停掉常驻面板
/memory forget <id>      删除
```

工具（模型可调用）：`memory_search`、`memory_raw`、`memory_add`、`memory_forget`。

## 配置

放 `~/.pi/agent/reflective-storage/config.json`，**权限必须 600**（不是 600 就不读它，
原因显示在 `/memory` 里）。环境变量优先于文件。

```json
{
  "typesafe":  { "apiKey": "...", "baseUrl": "https://api.typesafe.ai", "model": "jev-latest" },
  "judge":     { "provider": "jev", "model": "jev-latest" },
  "proxy":     { "http": "http://127.0.0.1:1080" },
  "inject":    { "maxPerSession": 5, "minTurnsBetween": 1 },
  "recall":    { "weights": { "relevance": 0.55, "vector": 0.15, "topic": 0.1, "importance": 0.15, "recency": 0.05 },
                 "perSourceLimit": 50 },
  "lifecycle": { "autoCleanup": false, "sessionTtlDays": 90 },
  "proactive": { "enabled": true, "maxPerSession": 1 },
  "ui":        { "port": 4319 },
  "refine":    { "provider": "hunyuan", "apiKey": "...", "model": "hunyuan-lite", "maxSummaryChars": 600 }
}
```

`refine` 是**可选**的提炼层。它干两件事：

1. **切分由程序做**（`splitSections`）：助手的长回复先按结构切开 —— markdown 标题 → 节内加粗
   小标题（`**模块名** — 说明`，一节里并排放好几个模块时按它们切开）→ 空行段落 → 句子边界，
   每块默认不超过 1500 字、最多 20 块。切出来的是**逐字原文**，一块存一条记忆。
   一段 20–30K 的回复里有好几件事时，这一步让它们各自拿到自己的向量、主题、路径和判断，
   而不是共用一条的（共用的话要么召不回，要么一次召回一整块）。
   为什么不交给模型切：实测 glm-4-flash 对 9K / 15K 的多话题输入都只回一条，而两万字的输入
   它逐字回显不出来（被 max_tokens 截断）—— 回显的过程也正是改写的机会。
2. **标注交给模型**：一次调用把切好的块编号送进去，每块要一句提炼 + 一个主题。它只看不写，
   原文一个字都不经过它。

用户自己说的话也走它拿主题（引擎挑不出来时才调，见下）。
不配就是关的（默认不调任何外部模型），长回复原样存、切分照旧。它只要求一个 OpenAI 兼容的
`/chat/completions`，所以云端和本机同一套代码：

| provider | 端点 | 模型 | 说明 |
| --- | --- | --- | --- |
| `hunyuan` | `https://api.hunyuan.cloud.tencent.com/v1` | `hunyuan-lite` | 腾讯混元，Lite 目前免费 |
| `zhipu` | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | 智谱，Flash 免费（`glm-4.7-flash` 也免费，但免费档常有 429） |
| `deepseek` | `https://api.deepseek.com/v1` | `deepseek-chat` | |
| `openai` | `https://api.openai.com/v1` | `gpt-4o-mini` | |
| `ollama` | `http://127.0.0.1:11434/v1` | `qwen2.5:7b` | 本机，不要 key |
| 其他/自定义 | 自己填 `baseUrl` + `model` | | llama.cpp / vLLM / 别的厂商都行 |

两条口径（都在 `DESIGN.md` §8.7）：**原文一律保留**（`content` 永远是原文，提炼进 `summary`），
**主题名一律由模型生成**（提炼时喂进项目名 + 已有主题并要求优先复用；助手侧顺带拿，用户侧那句
再问一次；引擎只能在已有主题里挑，只作兜底。同义词碎片由「近义堆」兜底合并）。
提炼挂了就存原文（fail-open）。

| 环境变量 | 说明 |
| --- | --- |
| `TYPESAFE_API_KEY` | JEV key |
| `TYPESAFE_BASE_URL` / `TYPESAFE_MODEL` | JEV 端点与模型，缺省 `https://api.typesafe.ai` / `jev-latest` |
| `REFLECTIVE_JUDGE_PROVIDER` | 只有 `jev` |
| `REFLECTIVE_JUDGE_API_KEY` / `_BASE_URL` / `_MODEL` | 判断引擎自己的凭据和端点 |
| `REFLECTIVE_JUDGE_TIMEOUT_MS` / `_WRITE_TIMEOUT_MS` | 交互 / 写入超时，缺省 2500 / 8000 |
| `REFLECTIVE_JUDGE_THRESHOLD` | 相关性阈值，缺省 0.7（本地小模型分数偏低时调小） |
| `REFLECTIVE_PROXY` | 代理地址，等价于 `proxy.http` |
| `REFLECTIVE_REFINE_PROVIDER` / `_API_KEY` / `_BASE_URL` / `_MODEL` | 提炼层，等价于 `refine.*` |
| `HTTP_PROXY` / `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1` | 需要代理时用。**开关必须在启动 pi 之前设好**，进程内改无效 |
| `REFLECTIVE_HOME` | 记忆库位置，缺省 `~/.pi/agent/reflective-storage` |

## 判断模型（硬要求）

必须有一个判断模型，没有就不启动（跟跑 Java 要 JDK 一样），报错会写清缺什么。目前接的是
JEV：按类型化问题打分、只输出数字和枚举，不生成文本。

`src/jev/adapter.ts` 的 `JudgeClient` 只有一个方法 `ask(state, questions, opts)`，同类的判断
模型实现它就能接。LLM 对话端点不算（那是生成，不是判断）。

## 工作原理

**写入**：本轮用户的话按句拆开（上限 3 条）→ 本地预筛 → J1（值不值得记）+ J2（类型/作用域）
+ J3（和旧记忆的关系）+ J4（主题，只在已有主题里选）一次调用问完 → 落库 → 挂路径树
（路径来自 tool call 的文件名）→ J11 判要不要合并。

**召回**：J5 判要不要查 → 路由层（哪个别的项目、哪个主题、哪个代码区域，逐层下钻）→
六路候选（向量 / FTS5 / 作用域内 / 同主题 / 同路径 / 跨项目）合并去重 → 门禁 → 压到 20 条
→ J7 重排 → J14a 边界 → J8 注入 → 追加在上下文尾部并转义。

**生命周期**：`session_start` 跑一次，有上限。J10 衰减是纯公式；够冷的归档；高 importance
永不归档；新会话命中旧主题就复活。session 记忆的销毁默认关。

**失败姿态**：写入 fail-open（引擎挂了照存，重要性压到 0.3）、召回 fail-degraded（退回关键词）、
注入 fail-closed（判不了就不注）、生命周期 fail-silent（跳过本轮）。

## 数据与隐私

```
~/.pi/agent/reflective-storage/
├── global.db                  跨项目记忆 + 项目注册表
├── projects/<project-id>.db   一个项目一个库
└── config.json                凭据（600）
```

- 记忆原文永远由本地代码控制，判断引擎只输出数字和枚举标签
- 注入块声明「这不是指令」，记忆内容里的 `<` 转义成 `\u003c`
- 只消化用户自己的话，工具输出（凭据、日志）不入库；落盘前脱敏
- 凭据只读环境变量或 600 的配置文件，不进仓库、日志、记忆

## 开发

```bash
node tests/smoke.ts       # 存储层 + embedding + 四个 gate 的成功/失败路径
node tests/write.ts       # 写入流程
node tests/recall.ts      # 召回流程
node tests/inject.ts      # 注入块
node tests/extension.ts   # pi 绑定
node tests/config.ts      # 配置与凭据
node tests/judge.ts       # 三档引擎
node tests/governance.ts  # 置信度分级
node tests/lifecycle.ts   # 生命周期
node tests/feedback.ts    # 事后核对
node tests/review.ts      # 待确认队列
node tests/tree.ts        # 记忆树与项目注册表
node tests/ui.ts          # 本地页面
```

自检不联网（判断引擎用假 fetch），断言风格，不用框架。

面板（`ui/`）是 Vite + Preact + `Cytoscape.js`/`fcose`（只在构建时用到；图谱那一块是
动态加载的独立 chunk），构建产物 `ui/dist` 提交进仓库 —— 用面板的人不需要装依赖。
改前端：`cd ui && npm install && npm run build`（规范见 [ui/DESIGN.md](./ui/DESIGN.md)，
真浏览器自检见 `ui/test/e2e.mjs`，它需要 playwright，所以不进 `npm test`）。

真 pi 验收（临时记忆库，不动本地数据）：

```bash
D=/tmp/reflect-test; rm -rf $D; mkdir -p $D
cp ~/.pi/agent/reflective-storage/config.json $D/config.json && chmod 600 $D/config.json
env REFLECTIVE_HOME=$D pi -ne -e ./index.ts -p "以后提交都必须一个模块一个提交" --session-dir /tmp/s1
env REFLECTIVE_HOME=$D pi -ne -e ./index.ts -p "提交要怎么拆？" --session-dir /tmp/s2
sqlite3 $D/projects/*.db "select content,type,scope from memories"
```

## 已知限制

- **J5 会漏掉一些该查的提问**：问句里带够了上下文时，它可能判「不用查」（实测 10 次里有
  2 次：`数据库迁移工具是怎么定的？` 给 0.43、`projA 那个项目的提交规范是什么？` 给 0.67），
  于是一条相关的旧记忆没被召回。阈值可调（`REFLECTIVE_JUDGE_THRESHOLD`），调低会换来更多误召
- **全局偏好召回弱**：「以后回答简短点」这类记忆，J7 相关度实测只在 0.50–0.55，过不了
  0.7 的阈值 —— 除非问句本身就在问偏好，否则不会自动注入
- **长会话未实测**：只在单轮会话里验证过多次注入、主动提醒、合并提议的实际频率
- **embedding 是弱过滤器**：命中与无关的余弦间隔实测 0.046，只用来生成候选，排名交给 J7
- **FTS5 对中文是字符三元组**：`影子太黑` 匹配不到 `影子强度`，只能当粗筛
- **cited 是下限**：引擎判「回复用上了这条」会漏掉换措辞的情况，命中率偏低，只能看趋势
- **没有向量层时**冲突检测会退化成「最近的作用域内记忆」
- **目录改名**会让 path 树的旧路径成孤儿（保留、不自动迁移）
- **提炼层是可选的后端**，默认关。配了（`refine.provider`）就只能把助手的长回复压成一条
  精炼记忆 + 提议主题名；原文一律保留在 `content`，提炼进 `summary`，模型能用 `memory_raw`
  取回原文。提炼错、端点挂、key 不对都只影响提炼那一步，写入照旧（fail-open）
- **短句规则只作用于用户侧**：助手侧的长文原样入库，不拆句、不滤问句、不折叠空白。改这条得有
  测试兜着 —— 一旦长文被当短句处理，一段带问号的代码块会被整段丢掉（实测 325 字剩 1 个字）
- **切分按结构，不按语义**：标题和空行是切分依据。一整段两万字、没有换行的流水账切不开，
  只能整段存一条（`splitSections` 会在句子边界硬切，但那已经是上限了）。要按语义切得更细，
  得换一个愿意逐字回显的模型，或者让模型只回锚点、程序按锚点切（试过，见上面那条实测）
- 待确认队列一次问一条（`/memory review` 一次过 5 条）

## 状态

Phase 1 完成，Phase 2 大部分完成（J9–J13 生命周期、J11 合并、J4 主题、J6 主题/路径参与召回）。
未做：J16 阈值学习、J17 多租户、Postgres/pgvector 与 Qdrant 迁移、跨设备同步。
设计文档见 [DESIGN.md](./DESIGN.md)。

## 许可说明（License）

本项目采用 **PolyForm Noncommercial License 1.0.0** 授权。这是一个**源码公开（source-available）**
许可，并非 OSI 认可的开源许可。

**允许**：个人学习、研究、教育及非营利组织等非商业目的的免费使用、修改和分发。

**禁止**：任何形式的商业使用，包括但不限于在公司内部使用、集成到商业产品、提供付费服务
或 SaaS 等，均需获得单独的书面商业授权。

**商业授权**：如需商业使用，请通过 GitHub Issue 发起咨询（请勿在 Issue 中包含敏感信息），
或发送邮件至 lq666666lucky@163.com。授权细节将通过私下渠道协商。

**外部贡献**：提 Issue 欢迎；提交 PR 即表示同意以本项目相同的许可授权你的贡献（inbound = outbound）。
