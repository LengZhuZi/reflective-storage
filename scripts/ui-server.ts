/**
 * 常驻面板进程。
 *
 * 通常不用手动跑：第一个 `/memory ui` 会 detached 起它；之后的会话读 `ui.json` + 探活，
 * 发现它在跑就直接给地址。手动跑也支持（出问题时这样能看到报错）：
 *
 *   node scripts/ui-server.ts        # 端口取 config.json 的 ui.port（默认 4319）
 *   node scripts/ui-server.ts 5200   # 或直接指定
 *
 * 面板不属于任何会话，所以这里的库是它自己按项目 id 开的，不是从会话传进来的。
 */
import { loadConfig } from "../src/config.ts";
import { startUi, writeUiMarker } from "../src/ui/server.ts";

const arg = process.argv[2];
const want = arg && /^\d+$/.test(arg) ? Number(arg) : loadConfig().ui.port;
const ui = await startUi({ port: want }).catch(async (e: Error) => {
  // 端口被别的东西占着：退回让系统挑，实际端口照样写进 ui.json，发现机制不靠固定端口。
  if (!(e as NodeJS.ErrnoException).code || (e as NodeJS.ErrnoException).code !== "EADDRINUSE" || want === 0) throw e;
  console.error(`[reflective-storage] 端口 ${want} 被占用，改用系统挑的空闲端口`);
  return await startUi({ port: 0 });
});

// 实际端口（port=0 时是系统挑的那个）写进 ui.json，别的会话靠它找到这个进程。
writeUiMarker(Number(new URL(ui.url).port));
process.on("SIGTERM", () => {
  try {
    ui.close();
  } catch {
    /* 已经在关了 */
  }
  process.exit(0);
});
console.error(`[reflective-storage] 面板：${ui.url}`);
