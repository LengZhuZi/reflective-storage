# 免责声明 / Disclaimer

## 这个项目是怎么写的

完全由 **vibe coding（氛围编程）** 写成：目标和取舍由人定，代码由 AI 生成，逐轮跑测试、
实测、返工。没有经过正式评审，也没有在生产环境长期运行过。

## 不保证什么

- 不保证正确、稳定、安全。行为会随判断模型、网络和依赖版本变化。
- 记忆的写入、合并、删除都会出错。**合并与删除不可逆**；可选的自动清理默认关闭，
  打开后按天数销毁的条目找不回来。
- 判断来自第三方模型（默认 JEV / TypeSafe AI）。它的输出不由本项目控制，而这些判断
  决定哪些记忆被存下来、哪些被注入到你的对话里。
- 记忆库是本机 SQLite 文件，**请自己备份**。
- 注入转义和作用域隔离按设计实现，但**不要把它当成安全边界**。

## 许可与责任

[PolyForm Noncommercial 1.0.0](./LICENSE) 许可：个人、学习、研究、非营利使用免费；
**商业使用需要单独授权**。按原样提供（AS IS），不提供任何担保，使用风险自负。作者不对
数据丢失、模型账单、被注入的内容或任何间接损失负责。

## English

This project was written entirely by **vibe coding**: humans set the goals and made the
trade-offs, an AI wrote the code, iterating against tests and real runs. It has had no
formal review and has not been run in production for long.

Licensed under PolyForm Noncommercial 1.0.0: free for personal, educational, research and
non-profit use; **commercial use requires a separate license**. Provided AS IS, with no
warranty of any kind. Memory writes, merges,
deletes and the optional auto-cleanup can lose data — merges and deletes are irreversible.
Judgements come from a third-party model (JEV / TypeSafe AI) whose output this project does
not control, and those judgements decide what is stored and what is injected into your
conversations. Back up your memory store. Use at your own risk.
