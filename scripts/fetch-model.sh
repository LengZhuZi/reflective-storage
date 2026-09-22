#!/usr/bin/env bash
# 下载本地 embedding 模型（bge-small-zh-v1.5 的 ONNX 量化版，24MB）。
#
# 为什么需要一个脚本而不是直接把模型提交进仓库：
#   - 24MB 的二进制进 git 之后每次改动都会翻倍，仓库会烂掉；
#   - 模型是第三方产物，不是我们的源码。
# 所以仓库里只留这个脚本，模型文件由使用者自己拉一次。
#
# 用法：bash scripts/fetch-model.sh
# 网络：默认走本机代理（GLOBAL_PROXY 可覆盖）；也可以把 PROXY 设为空走直连。
set -euo pipefail

REPO="${MODEL_REPO:-Xenova/bge-small-zh-v1.5}"
BASE="${MODEL_BASE:-https://huggingface.co/$REPO/resolve/main}"
PROXY="${GLOBAL_PROXY:-http://127.0.0.1:7897}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/models/bge-small-zh-v1.5"

# 代理不通就退回直连（hf-mirror 直连可用）
CURL=(curl -fsSL)
if [ -n "$PROXY" ] && curl -s -o /dev/null --max-time 3 -x "$PROXY" https://huggingface.co; then
  CURL+=(--proxy "$PROXY")
  echo "使用代理 $PROXY"
else
  echo "代理不可用，走直连"
  BASE="${MODEL_BASE_FALLBACK:-https://hf-mirror.com/$REPO/resolve/main}"
fi

mkdir -p "$OUT/onnx"
for f in config.json tokenizer.json tokenizer_config.json special_tokens_map.json vocab.txt; do
  printf '  %-26s' "$f"
  "${CURL[@]}" -o "$OUT/$f" "$BASE/$f"
  echo "ok"
done

printf '  %-26s' "onnx/model_quantized.onnx"
"${CURL[@]}" -o "$OUT/onnx/model_quantized.onnx" "$BASE/onnx/model_quantized.onnx"
echo "ok"

echo "模型已就位：$OUT"
du -sh "$OUT"
