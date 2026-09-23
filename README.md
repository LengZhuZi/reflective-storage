# Reflective Storage

JEV 驱动的长期记忆运行时，作为 [pi](https://pi.dev) 的原生扩展运行。

记忆在写入前先反思，在召回时先判断，在使用后能进化。

**不需要任何 API key 也能用**：默认走纯规则引擎（离线、零成本）。配上 key 或用任何 OpenAI 兼容的本地模型，判断质量会好很多。判断引擎可替换，流程和失败姿态不变 —— 详见 [DESIGN.md](./DESIGN.md) §5.2。

## 这套东西解决什么

| 痛点 | 对应机制 |
| --- | --- |
| 跨会话记忆丢失 | 写入闸 + 作用域库 + 会话开始时注入 |
| 压缩上下文导致失真 | 注入在 `before_agent_start`；压缩后重新可注入。记忆原文在本地库里，不依赖摘要是否忠实 |
| 缓存输入比输出还贵 | 每会话只注入一次，且只追加在上下文尾部，保住 provider 的前缀缓存 |
| 忘记你不想让它干的事 | 作用域硬过滤在 SQL 层；高 importance 记忆不过滤 |

核心取舍：**判断（JEV）与执行（本地代码）分离**。JEV 只回答类型化的问题，永远不生成文本，所以它不可能"发明"一条记忆；安全边界不建立在概率模型上。

架构与全部设计决定见 [DESIGN.md](./DESIGN.md)。

## 组成

```
index.ts                pi 扩展入口：六个 hook + 三个工具 + /memory 命令
src/config.ts           配置与凭据解析（环境变量 > config.json > 报错）
src/core/types.ts       记忆节点与作用域模型
src/core/governance.ts  J14b 兜底路由（置信度分级）+ J14c 一句人话
src/jev/types.ts        判断结果类型（三态 status）
src/jev/http.ts         JEV 传输层：超时、重试、usage
src/jev/llm.ts          OpenAI 兼容引擎：任何 /chat/completions
src/jev/rule.ts         规则原子（关键词、类型、作用域、相关性）
src/jev/rule-adapter.ts 纯规则引擎：默认档，零配置、离线
src/jev/adapter.ts      四个 gate 的组装、失败姿态、档位选择
src/embed/encoder.ts    本地 bge-small-zh-v1.5，512 维，完全离线
src/storage/db.ts       node:sqlite + FTS5 + sqlite-vec
src/pipeline/write.ts   写入流程：预筛、脱敏、J1+J2+J3、作用域分流、fail-open
src/pipeline/recall.ts  召回流程：多路召回、作用域门禁、J7、J8、预算截断
src/pipeline/inject.ts  注入块组装与「每会话只注入一次」的状态
src/pipeline/lifecycle.ts 生命周期：J10 衰减 / J9 巩固 / J12 归档 / J13 复活（纯后台）
src/pipeline/feedback.ts  J15 事后核对：注入的记忆有没有真被用上（纯本地字符串比对）
src/pipeline/review.ts    待确认队列：低置信冲突 + 合并提议，问用户来拍（pi 的 1/2/3 选择）
```

## 判断引擎（三档，都是正式档位）

| 档位 | 配置 | 依赖 | 说明 |
| --- | --- | --- | --- |
| `rules` | 什么都不配 | 无 | **默认档**。零配置、不联网。判断粗：不做语义冲突检测（一律新建），类型/作用域靠关键词 |
| `jev` | 配了 JEV key 就自动用 | TypeSafe key | 质量最好，本设计的标定基准 |
| `openai` | `judge.provider = "openai"` + baseUrl + model | 任何 `/chat/completions` | DeepSeek / Ollama / LM Studio / vLLM… |

没配 key 时默认`rules`，不会出现「装了什么都没发生」。想换模型只改配置，流程一行不改。

## 依赖

- **Node.js 24+** —— 用到内置的 `node:sqlite`，无需第三方数据库驱动
- 本地 embedding 模型 —— 用 `scripts/fetch-model.sh` 拉一次，之后完全离线
- **可选**：JEV API key（从 https://console.typesafe.ai/keys 获取），或任何 OpenAI 兼容端点。不加也能用（`rules` 档）

```bash
npm install --ignore-scripts   # 见下方说明
bash scripts/fetch-model.sh
```

`--ignore-scripts` 是必需的：`onnxruntime-node` 的 postinstall 会去 `api.nuget.org` 下载 CUDA EP，而 CPU 版动态库本来就打包在 npm 包里，下不到也不影响运行。

## 运行自检

```bash
node tests/smoke.ts       # storage + embedding + 四个 gate 的成功路径与三条失败路径
node tests/config.ts      # 配置与凭据：环境变量覆盖、600 权限把关、报错可读、代理提示
node tests/judge.ts       # 三档引擎、阈值跟着引擎走、OpenAI 兼容的编译与解析
node tests/governance.ts  # J14b 置信度分级（作用域只许收窄）+ J14c 一句人话
node tests/lifecycle.ts   # J10 衰减公式、J9 巩固、J12 归档（高 importance 不动）、J13 复活、fail-silent
node tests/feedback.ts    # J15 事后核对：确凿用上的判定、换了说法的盲区、空回复不覆盖
node tests/review.ts      # 待确认队列：只提议不动数据、三种处置、被取代的不再召回
node tests/write.ts       # 写入流程：预筛、脱敏、作用域分流、fail-open
node tests/recall.ts      # 召回流程：门禁、阈值、fail-degraded、fail-closed、预算
node tests/inject.ts      # 注入块：声明、转义、预算截断、状态机
node tests/extension.ts   # pi 绑定：hook/工具/命令、每会话一次、压缩后解锁、降级可见
```

自检不联网（判断引擎用假的 fetch），断言风格，不用测试框架。

## 真 pi 验收（无感闭环）

自检用的是假 pi —— 真正挂进 pi 是另一回事。用临时记忆库跑一遍，不动你本地的库：

```bash
D=/tmp/reflect-test; rm -rf $D; mkdir -p $D
cp ~/.pi/agent/reflective-storage/config.json $D/config.json && chmod 600 $D/config.json

# 会话 1：顺口说一条约定（不说「记住」，也不调任何工具）
env REFLECTIVE_HOME=$D pi -ne -e ./index.ts -p "以后这个仓库的提交都必须一个模块一个提交" --session-dir /tmp/reflect-s1

# 会话 2：新会话直接问
env REFLECTIVE_HOME=$D pi -ne -e ./index.ts -p "提交要怎么拆？" --session-dir /tmp/reflect-s2

# 看库里到底发生了什么
sqlite3 $D/projects/*.db "select content,type,scope from memories; select gate,action,user_visible from reflection_traces;"
```

`-ne` 关掉其他扩展的自动发现（只跑这个，同时避开 cognee 等扩展的副作用），`REFLECTIVE_HOME` 指向临时目录。
验收标准（DESIGN.md §16）：能回答「记了什么、为什么记住、怎么删掉」，且全程零命令。

**为什么必须跑这一步**：假 pi 查不出真的三类问题 —— 模型会主动调 `memory_add`（导致重复入库）、
`getBranch()` 给的是会话条目而不是裸消息、问句会被当成记忆。这三个都是真跑时才暴露的。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `TYPESAFE_API_KEY` | JEV API key。配置文件或环境变量，两者都只在本机，不落盘到仓库、不入库、不进日志 |
| `TYPESAFE_BASE_URL` / `TYPESAFE_MODEL` | JEV 端点和模型，缺省 `https://api.typesafe.ai` / `jev-latest` |
| `REFLECTIVE_JUDGE_PROVIDER` | `rules` / `jev` / `openai`。缺省：有 key 走 jev，没 key 走 rules |
| `REFLECTIVE_JUDGE_API_KEY` / `_BASE_URL` / `_MODEL` | 判断引擎自己的凭据和端点，覆盖上面的 `TYPESAFE_*` |
| `REFLECTIVE_JUDGE_TIMEOUT_MS` / `_WRITE_TIMEOUT_MS` | 交互路径 / 写入路径超时，缺省 2500 / 8000。本地模型要调大 |
| `REFLECTIVE_JUDGE_THRESHOLD` | 相关性阈值，缺省 0.7。本地小模型分数普遍偏低时调小 |

行为开关只放配置文件（环境变量留给凭据和端点）：`lifecycle.autoCleanup`（缺省 `false`）、`lifecycle.sessionTtlDays`（缺省 90）、`inject.maxPerSession`（缺省 3，设 1 = 每会话只注入一次）、`inject.minTurnsBetween`（缺省 3）。后两个只管机械约束；「这个提问是不是刚才那件事」由 J5 判断（引擎说了算，不让本地规则兼职）。

`lifecycle.autoCleanup` 打开之后：`scope='session'` 且超过 `sessionTtlDays` 天没被召回命中过的记忆**直接销毁**（不是归档）。删除不可逆，所以默认关；`/memory` 里能看到它开没开。
| `REFLECTIVE_PROXY` | 代理地址，等价于配置文件里的 `proxy.http` |
| `HTTP_PROXY` / `HTTPS_PROXY` | JEV 端点需要代理时用，配合下面的开关 |
| `NODE_USE_ENV_PROXY=1` | **必需**（要用代理时）。Node 的内置 fetch 默认不读代理变量，且必须在启动进程前设置 —— 进程内改无效 |
| `REFLECTIVE_HOME` | 记忆库位置，默认 `~/.pi/agent/reflective-storage` |

环境变量优先级高于配置文件。凭据放在 `~/.pi/agent/reflective-storage/config.json`（**权限必须 600**）：

```json
{
  "typesafe": { "apiKey": "...", "baseUrl": "https://api.typesafe.ai", "model": "jev-latest" },
  "judge": { "provider": "openai", "baseUrl": "http://localhost:11434/v1", "model": "qwen3:8b" },
  "proxy": { "http": "http://127.0.0.1:7897" }
}
```

权限不是 600 就不读这个文件（并把原因显示在 `/memory` 里），权限不对时用环境变量可以照常工作。

## 数据存放

```
~/.pi/agent/reflective-storage/
├── global.db                  # 跨项目的偏好
└── projects/<项目>.db         # 一个项目一个库
```

记忆库是本地数据，已在 `.gitignore` 里排除。

## 已知限制

- **偶发网络卡死**：JEV 链路约每 8–16 次请求出现一次挂到超时。重试一次可恢复。写入路径带一次重试，交互路径不重试（宁可不注入也不拖住用户）。
- **embedding 是弱过滤器**：命中与无关的余弦间隔实测只有 0.046，所以向量只用来生成候选，排名交给 JEV。不能用它单独定阈值。
- **FTS5 对中文是字符三元组**：`影子太黑` 匹配不到 `影子强度`（没有共同三字组），只能当粗筛。
- 向量层缺失时系统照常运行，只是召回少一路语义候选。关系层是事实源，向量层随时可重建。
- 写入口的 J3 候选（跟新内容最相关的 20 条）也靠向量那一路排序。向量层不可用时它会退化成「最近的作用域内记忆」，冲突检测随之变弱 —— 但写入本身不受影响。

## 会问你的两种情况

引擎判不了的事不替用户拍，也不装没看见 —— 排队问，用 pi 的 1/2/3 选择框：

| 什么时候 | 问什么 | 选项（默认第一个，按 Esc 也是它） |
| --- | --- | --- |
| 新记忆和已有某条**看着是同一件事** | 要合并吗 | 保留两条（并存） / 用新的取代旧的 / 保留旧的 |
| 引擎在已有主题里挑不出主题、而这条又够重要 | 要不要起个主题 | 输入名字 / 留空跳过 |
| 引擎给的冲突/取代关系**置信度 < 0.5** | 怎么处理 | 同上 |

只改状态、记关系，**不硬删**。一轮最多问一条；`/memory review` 可以把攒下的一次过；`/memory topics` 看主题、`/memory topic <名>` 看某个主题下的记忆；
`print` 模式不弹窗，只排队。

## 状态

Phase 1 完成；Phase 2 第一片（生命周期）也做完了。已完成：存储层、embedding、四个 gate（J1/J2/J3、J5、J7、J8）与其失败姿态、写入流程、召回流程、判断引擎可插拔（rules / jev / openai）、治理（J14a 硬过滤 + J14b 兜底路由 + J14c 理由）、J15 轻量反馈日志、生命周期（J9 巩固 / J10 衰减 / J12 归档 / J13 复活）、pi 扩展入口（hooks / 工具 / `/memory` 命令）。

J14b 只有作用域分级：低置信度时作用域**只许收窄**（引擎说 global 但只有 0.55 → 收窄到 project）。宽窄代价不对称 —— 放宽会把项目内的步骤带去别的项目，收窄只是少看见几条。

J15 记事实（query / 召回集 / 注入集）+ 事后核对（`cited_ids` = 回复里出现了该记忆连续 4 个以上二字组的原样片段）。这个信号只是**下限**：换了说法就抓不到，所以它标记的是「确凿用上」，不是「准确率」。`user_feedback` 留空，要等 UI。

J5 目前不调用：§10.4 的本地规则已经覆盖了「要不要花这次钱」，而本会话只注入一次，所以 J5 在首轮永远是一次白花的调用。`adapter.judgeRecallNeed` 留着给压缩后重注入和将来的主动召回。

待做：J11 合并（需要引擎级语义判断；J3 的 `supersedes` 已覆盖最常见的情形）、J4 树路由、J14c 的复核 UI、J15 的 `cited` 事后核对与用户反馈入口。路线图见 DESIGN.md §14。

真 pi 无感闭环已验证：会话 1 顺口说一条约定（零命令、没说「记住」）→ 自动入库一条；会话 2 新会话直接问 → 自动召回 + 注入，回答直接用上。跑法见上面「真 pi 验收」。
