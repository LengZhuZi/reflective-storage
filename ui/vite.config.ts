import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// 构建产物直接落 ui/dist，由 src/ui/server.ts 当静态目录发出去。
// 相对 base 保证挂在任意路径下都能加载资源。
export default defineConfig({
  base: "./",
  plugins: [preact()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    assetsDir: "assets",
    // 面板是本地工具，产物小、可读比压缩重要（排查时能直接看构建后的文件）
    minify: false,
    sourcemap: false,
  },
});
