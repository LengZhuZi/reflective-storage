/** 展示用的格式化。数字与 id 一律等宽，时间一律相对 + 精确时间放 title。 */

export const shortId = (id: string) => id.slice(0, 8);

export function ago(ms: number | null, now = Date.now()): string {
  if (!ms) return "-";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} 天前`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo} 个月前`;
  return `${Math.round(mo / 12)} 年前`;
}

export const stamp = (ms: number | null) => (ms ? new Date(Number(ms)).toLocaleString() : "-");
export const pct = (n: number | null) => (n == null ? "-" : `${(n * 100).toFixed(0)}%`);
export const fixed = (n: number, d = 2) => n.toFixed(d);

export const STATE_TONE: Record<string, "accent" | "warn" | "bad" | "" | "info"> = {
  active: "accent",
  cold: "warn",
  archived: "",
  superseded: "bad",
};

export const STATE_LABEL: Record<string, string> = {
  active: "active",
  cold: "cold",
  archived: "archived",
  superseded: "superseded",
};

export const TYPE_LABEL: Record<string, string> = {
  fact: "事实",
  preference: "偏好",
  procedure: "流程",
  relation: "关系",
  event: "事件",
  emotion: "情绪",
};

export const SCOPE_LABEL: Record<string, string> = {
  project: "项目",
  global: "全局",
  session: "会话",
  all: "全部项目",
};

export const KIND_LABEL: Record<string, string> = {
  supersedes: "取代",
  contradicts: "冲突",
  extends: "延伸",
  depends_on: "依赖",
  related: "相关",
  topic: "同主题",
  path: "同路径",
  similar: "相似",
};

export const STAGE_LABEL: Record<string, string> = {
  write: "写入",
  recall: "召回",
  governance: "治理",
  lifecycle: "生命周期",
  feedback: "事后核对",
};

export function humanTrace(gate: string, action: string): string {
  const key = `${gate} ${action}`;
  const map: Record<string, string> = {
    "J1+J2+J3 keep": "记住了",
    "J1+J2+J3 skip": "没记",
    "dedup duplicate": "已存在，没重复写",
    "J3 superseded": "标为被取代",
    "J5 keep": "判定需要查",
    "J5 skip": "判定不用查",
    "J7 keep": "重排后留下候选",
    "J7 skip": "重排后没有可用候选",
    "J8 inject": "注入进对话",
    "J8 skip": "不注入",
    "J9 promote": "巩固：提权",
    "J12 archive": "归档",
    "J12 delete": "删除",
    "J13 resurrect": "复活",
    "J14a block": "边界判断挡下",
    "J15 cite": "确认用上了",
    "J16 remind": "主动提醒",
    "J14c explain": "一句人话",
  };
  return map[key] ?? `${gate} ${action}`;
}
