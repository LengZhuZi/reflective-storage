import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// 构建产物直接落 ui/dist，由 src/ui/server.ts 当静态目录发出去。
// 相对 base 保证挂在任意路径下都能加载资源。
export default defineConfig({
  base: "./",
  plugins: [preact()],
  // dev 模式把 /api 转给常驻面板（node scripts/ui-server.ts），这样 npm run dev 也能看真数据。
  server: { proxy: { "/api": "http://127.0.0.1:4319" } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    assetsDir: "assets",
    // 压缩：产物是提交进仓库的，cytoscape 那一块（1.3MB 未压缩）不压会让每次改图谱
    // 都在 git 里多一份大文件。要看产物就直接看 ui/src（源码才是给人读的）。
    minify: "esbuild",
    sourcemap: false,
  },
});
