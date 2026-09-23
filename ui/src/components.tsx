/** 通用控件。视觉规范在 ui/DESIGN.md，样式在 styles/app.css，这里只负责结构与行为。 */
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import { STATE_LABEL, STATE_TONE, TYPE_LABEL, ago, stamp } from "./format";

/* ------------------------------------------------------------------ 图标 */

/** 一套自用的 16px 线性图标：统一 1.5px stroke、currentColor、不填色。
 *  它们是功能性的（导航/动作），不是装饰；一致性靠这一处统一设置保证。 */
const PATHS: Record<string, string> = {
  overview: "M2.5 9.5 8 3l5.5 6.5M4 8.5V13h8V8.5",
  graph: "M8 2.6a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 0 0 0-3.8ZM3.4 9.6a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4Zm9.2 0a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4ZM6.9 5.9 4.4 9.3m4.7-3.4 2.5 3.4M5.1 11.3h5.8",
  list: "M3 4.5h10M3 8h10M3 11.5h6",
  review: "M8 2.8 13.5 12H2.5L8 2.8Zm0 3.4v2.6m0 1.6v.1",
  stack: "M8 2.8 13.5 6 8 9.2 2.5 6 8 2.8Zm5.5 5.4L8 11.4 2.5 8.2m11 2.9L8 14.4 2.5 11.1",
  settings: "M8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6Zm5 .6-1.3-.3a3.9 3.9 0 0 0-.4-.9l.7-1.1-1.5-1.5-1.1.7a3.9 3.9 0 0 0-.9-.4L8.2 2h-2l-.3 1.3a3.9 3.9 0 0 0-.9.4L3.9 3 2.4 4.5l.7 1.1a3.9 3.9 0 0 0-.4.9L1.4 6.8v2l1.3.3c.1.3.2.6.4.9l-.7 1.1L3.9 12.6l1.1-.7c.3.2.6.3.9.4L6.2 14h2l.3-1.3c.3-.1.6-.2.9-.4l1.1.7 1.5-1.5-.7-1.1c.2-.3.3-.6.4-.9l1.3-.3v-2Z",
  search: "M7.2 3a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 0-8.4Zm3.1 7.3L13 13",
  copy: "M5.5 5.5V3.2h7.3v7.3h-2.3M3.2 5.5h7.3v7.3H3.2z",
  trash: "M3 4.5h10M6.3 4.5V3.2h3.4v1.3M4.5 4.5l.6 8.3h5.8l.6-8.3M6.6 6.8v4M9.4 6.8v4",
  close: "M4 4l8 8M12 4l-8 8",
  refresh: "M13 8a5 5 0 1 1-1.6-3.7M13 2.6V5.4h-2.8",
  chevron: "M6.2 3.5 10.5 8l-4.3 4.5",
  check: "M3.2 8.4 6.4 11.6 12.8 4.8",
  sun: "M8 5.4A2.6 2.6 0 1 0 8 10.6 2.6 2.6 0 0 0 8 5.4ZM8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3 3.6 12.4",
  moon: "M12.6 9.6A5.2 5.2 0 0 1 6.4 3.4a5.2 5.2 0 1 0 6.2 6.2Z",
};

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.overview!} />
    </svg>
  );
}

/* ------------------------------------------------------------------ 基础 */

type Tone = "accent" | "warn" | "bad" | "info" | "";

export function Chip({ tone = "", children, title }: { tone?: Tone; children: ComponentChildren; title?: string }) {
  return (
    <span class={`chip ${tone}`} title={title}>
      {children}
    </span>
  );
}

export function StateChip({ state }: { state: string }) {
  return <Chip tone={STATE_TONE[state] ?? ""}>{STATE_LABEL[state] ?? state}</Chip>;
}

export function TypeChip({ type }: { type: string }) {
  return <Chip title={type}>{TYPE_LABEL[type] ?? type}</Chip>;
}

export function Button({
  variant = "",
  size = "",
  icon,
  children,
  ...rest
}: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" | ""; size?: "sm" | ""; icon?: string }) {
  return (
    <button type="button" class={`btn ${variant} ${size}`} {...rest}>
      {icon ? <Icon name={icon} size={14} /> : null}
      {children}
    </button>
  );
}

export function KeyHint({ keys }: { keys: string[] }) {
  return (
    <span class="nowrap">
      {keys.map((k, i) => (
        <span key={k}>
          {i > 0 ? " " : ""}
          <kbd>{k}</kbd>
        </span>
      ))}
    </span>
  );
}

export function SearchInput({ value, onInput, placeholder, autofocus, inputRef }: { value: string; onInput: (v: string) => void; placeholder?: string; autofocus?: boolean; inputRef?: (el: HTMLInputElement | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autofocus) ref.current?.focus();
  }, [autofocus]);
  return (
    <span class="search-wrap">
      <Icon name="search" size={14} />
      <input
        ref={(el) => {
          ref.current = el;
          inputRef?.(el);
        }}
        class="input search"
        type="search"
        value={value}
        placeholder={placeholder ?? "搜索内容"}
        onInput={(e) => onInput((e.currentTarget as HTMLInputElement).value)}
      />
    </span>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ComponentChildren }) {
  return (
    <div class="field">
      <label>{label}</label>
      {children}
      {hint ? <span class="hint">{hint}</span> : null}
    </div>
  );
}

export function Metric({ k, v, h, text }: { k: string; v: ComponentChildren; h?: string; text?: boolean }) {
  return (
    <div class="metric">
      <div class="k">{k}</div>
      <div class={`v ${text ? "text" : ""}`}>{v}</div>
      {h ? <div class="h">{h}</div> : null}
    </div>
  );
}

export function Panel({ title, actions, children, flush, id }: { title?: string; actions?: ComponentChildren; children: ComponentChildren; flush?: boolean; id?: string }) {
  return (
    <section class="panel" id={id}>
      {title || actions ? (
        <header class="panel-head">
          {title ? <h2>{title}</h2> : null}
          <span class="spacer" />
          {actions}
        </header>
      ) : null}
      <div class={`panel-body ${flush ? "flush" : ""}`}>{children}</div>
    </section>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: ComponentChildren; action?: ComponentChildren }) {
  return (
    <div class="empty">
      <h3>{title}</h3>
      {hint ? <p>{hint}</p> : null}
      {action}
    </div>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div style={{ display: "grid", gap: "6px", padding: "12px 14px" }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} class="skeleton" />
      ))}
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div class="empty">
      <h3>读不到数据</h3>
      <p class="mono">{error.message}</p>
      {onRetry ? (
        <Button icon="refresh" onClick={onRetry}>
          重试
        </Button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ 轨迹 */

export function Timeline({ items }: { items: Array<{ gate: string; action: string; reason: string; status: string; userVisible: string }> }) {
  if (items.length === 0) return <p class="dim">这条没有判断轨迹（可能是手工入库的）。</p>;
  return (
    <div class="timeline">
      {items.map((t, i) => (
        <div class="timeline-item" key={`${t.gate}-${t.action}-${i}`}>
          <div class="gate">
            {t.gate} · {t.action}
          </div>
          <div class="what">
            {t.userVisible ? <div>{t.userVisible}</div> : null}
            {t.reason ? <div class="dim">{t.reason}</div> : null}
            {t.status && t.status !== "ok" ? (
              <div>
                <Chip tone="warn">判断降级：{t.status}</Chip>
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ 弹层 */

export function Dialog({ title, children, onClose, actions }: { title: string; children: ComponentChildren; onClose: () => void; actions?: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    ref.current?.querySelector<HTMLElement>("button,input")?.focus();
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div class="overlay" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="dialog" ref={ref}>
        <div class="dialog-head">{title}</div>
        <div class="dialog-body">{children}</div>
        <div class="dialog-actions">{actions}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 提示 */

interface Toast {
  id: number;
  text: string;
  tone: "ok" | "bad";
}
let seq = 0;
const toasts: Toast[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(text: string, tone: "ok" | "bad" = "ok") {
  const t = { id: ++seq, text, tone };
  toasts.push(t);
  emit();
  setTimeout(() => {
    const i = toasts.findIndex((x) => x.id === t.id);
    if (i >= 0) {
      toasts.splice(i, 1);
      emit();
    }
  }, tone === "bad" ? 6000 : 3200);
}

export function ToastHost() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} class={`toast ${t.tone === "bad" ? "bad" : ""}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ 小工具 */

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: Error | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn()
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e: Error) => alive && setError(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload };
}

export function Bool({ value, yes = "是", no = "否" }: { value: boolean; yes?: string; no?: string }) {
  return <span class="mono">{value ? yes : no}</span>;
}

export function TimeCell({ at }: { at: number | null }) {
  return (
    <span class="mono faint" title={stamp(at)}>
      {ago(at)}
    </span>
  );
}
