# Reflective Storage

JEV 驱动的长期记忆运行时，作为 [pi](https://pi.dev) 的原生扩展运行。

记忆在写入前先反思，在召回时先判断，在使用后能进化。

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
src/core/types.ts       记忆节点与作用域模型
src/jev/types.ts        判断结果类型（三态 status）
src/jev/http.ts         JEV 传输层：超时、重试、usage
src/jev/rule.ts         JEV 不可用时的规则兜底
src/jev/adapter.ts      四个 gate 的组装与失败姿态
src/embed/encoder.ts    本地 bge-small-zh-v1.5，512 维，完全离线
src/storage/db.ts       node:sqlite + FTS5 + sqlite-vec
tests/smoke.ts          冒烟自检
```

## 依赖

- **Node.js 24+** —— 用到内置的 `node:sqlite`，无需第三方数据库驱动
- **JEV API key** —— 从 https://console.typesafe.ai/keys 获取，只放环境变量
- 本地 embedding 模型 —— 用 `scripts/fetch-model.sh` 拉一次，之后完全离线

```bash
npm install --ignore-scripts   # 见下方说明
bash scripts/fetch-model.sh
```

`--ignore-scripts` 是必需的：`onnxruntime-node` 的 postinstall 会去 `api.nuget.org` 下载 CUDA EP，而 CPU 版动态库本来就打包在 npm 包里，下不到也不影响运行。

## 运行自检

```bash
node tests/smoke.ts
```

自检不联网，覆盖 storage、embedding、四个 gate 的成功路径与三条失败路径。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `TYPESAFE_API_KEY` | JEV API key。只从环境变量读，不落盘、不入库、不进日志 |
| `HTTP_PROXY` / `HTTPS_PROXY` | JEV 端点在部分网络下需要代理 |
| `NODE_USE_ENV_PROXY=1` | **必需**。Node 的内置 fetch 默认不读代理变量，必须在启动进程前设置 |
| `REFLECTIVE_HOME` | 记忆库位置，默认 `~/.pi/agent/reflective-storage` |

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

## 状态

Phase 1 进行中。已完成存储层、embedding、四个 gate（J1/J2/J3、J5、J7、J8）与其失败姿态。待做：写入流程编排、召回流程编排、pi 扩展入口（hooks / 工具 / `/memory` 命令）。路线图见 DESIGN.md §14。
