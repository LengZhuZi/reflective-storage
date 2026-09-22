/**
 * 本地 embedding 编码器 —— bge-small-zh-v1.5，512 维，完全离线。
 *
 * 选型与实测见 DESIGN.md §13.2。要点：
 *   - 加载 172ms，单条编码约 4ms（100 条 399ms），模型文件 24MB 自带。
 *   - allowRemoteModels=false + localModelPath：不联网，不读任何外部缓存。
 *
 * 为什么它只当候选生成器、不当排名器：实测命中最低 0.437 vs 无关最高 0.391，
 * 间隔只有 0.046，靠它自己定阈值不可靠。排名交给 J7 的 JEV。见 DESIGN.md §13.2。
 */

import { fileURLToPath } from "node:url";
import path from "node:path";

export const EMBED_DIM = 512;
const MODEL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../models/");
const MODEL_ID = "bge-small-zh-v1.5";

type Extractor = (
  text: string | string[],
  options: { pooling: "cls"; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

let extractorPromise: Promise<Extractor> | null = null;
let loadMs = 0;

/** 懒加载单例。第一次调用付 ~170ms，之后复用。 */
async function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    const t0 = Date.now();
    extractorPromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.allowRemoteModels = false;      // 完全离线：只用本地模型目录
      env.localModelPath = MODEL_DIR;
      const pipe = await pipeline("feature-extraction", MODEL_ID, {
        dtype: "q8",
        device: "cpu",
      });
      return pipe as unknown as Extractor;
    })();
    // 只在真正加载完成时记时间，失败不记。
    extractorPromise.then(() => { loadMs = Date.now() - t0; }).catch(() => {});
  }
  return extractorPromise;
}

export function encoderStats() {
  return { loaded: Boolean(extractorPromise), loadMs, dim: EMBED_DIM, model: MODEL_ID };
}

function toUnitVector(data: Float32Array): number[] {
  // normalize:true 已经归一化，这里只转成普通数组；再兜一次防浮点误差。
  let norm = 0;
  for (let i = 0; i < data.length; i++) norm += data[i] * data[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Array<number>(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] / norm;
  return out;
}

export async function embed(text: string): Promise<number[]> {
  const extract = await getExtractor();
  const out = await extract(text, { pooling: "cls", normalize: true });
  return toUnitVector(out.data);
}

/** 批量编码。向量批量进模型，比逐条省一遍调度开销。 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extract = await getExtractor();
  const out = await extract(texts, { pooling: "cls", normalize: true });
  const dim = out.dims[out.dims.length - 1];
  const rows: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    rows.push(toUnitVector(out.data.subarray(i * dim, (i + 1) * dim)));
  }
  return rows;
}

/** 余弦相似度。两个向量都归一化时等价于点积。 */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export function toVecBlob(v: number[]): Uint8Array {
  // sqlite-vec 接受 JSON 文本或 float32 blob；blob 更小更快。
  return new Uint8Array(new Float32Array(v).buffer);
}
