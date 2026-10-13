import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { resolveBindings, bindingFormatters, evaluate, formatValue, type Widget } from "@aibi/page-spec";
import type { WidgetRenderProps } from "@aibi/runtime-api";
import { api, handles, widgetEls, runInteraction, isVisible, summaries, getState, setState, type RState } from "../engine";
import { send } from "../bridge";
import { TabsWidget } from "./TabsWidget";

class Boundary extends Component<{ children: ReactNode; resetKey: unknown }, { error: Error | null; key: unknown }> {
  override state = { error: null as Error | null, key: this.props.resetKey };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  static getDerivedStateFromProps(p: { resetKey: unknown }, s: { key: unknown }) {
    return p.resetKey !== s.key ? { error: null, key: p.resetKey } : null;
  }
  override render() {
    if (this.state.error) return <div className="rt-error">This widget failed to render: {this.state.error.message}</div>;
    return this.props.children;
  }
}

/** Props are resolved against filters and data; echarts.raw and text resolve their own bindings. */
const SELF_BINDING = new Set(["echarts.raw", "text"]);

function useSize(ref: React.RefObject<HTMLElement>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      setSize((s) => (Math.abs(s.width - width) > 0.5 || Math.abs(s.height - height) > 0.5 ? { width: Math.floor(width), height: Math.floor(height) } : s));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function toCsv(rows: Record<string, unknown>[], cols: string[]) {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map(esc).join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

export function WidgetCard({ w, s, nested = false }: { w: Widget; s: RState; nested?: boolean }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const size = useSize(contentRef);
  const [menu, setMenu] = useState(false);
  const [full, setFull] = useState(false);
  // the menu is rendered outside the card (cards clip their content) at a fixed position next to the button,
  // kept inside the window so narrow widgets cannot cut it off
  const menuBtn = useRef<HTMLButtonElement>(null);
  const menuEl = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const openMenu = () => {
    const r = menuBtn.current?.getBoundingClientRect();
    if (!r) return;
    const width = 208;
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    setMenuPos({ top: r.bottom + 4, left });
    setMenu(true);
  };
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (menuEl.current?.contains(e.target as Node) || menuBtn.current?.contains(e.target as Node)) return;
      setMenu(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", () => setMenu(false), { once: true, capture: true });
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
    };
  }, [menu]);

  // Full screen uses the browser Fullscreen API on the card: a CSS overlay cannot escape the grid's transforms
  // or the page iframe (which is as tall as the page). The CSS overlay stays as a fallback.
  useEffect(() => {
    const onChange = () => setFull(!!cardRef.current && document.fullscreenElement === cardRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFull = async () => {
    const el = cardRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (full) {
      setFull(false);
      return;
    }
    if (document.fullscreenEnabled && el.requestFullscreen) {
      try {
        await el.requestFullscreen({ navigationUI: "hide" });
        return;
      } catch {
        /* not allowed here: fall back to the overlay */
      }
    }
    setFull(true);
  };

  useEffect(() => {
    if (cardRef.current) widgetEls.set(w.id, cardRef.current);
    return () => {
      widgetEls.delete(w.id);
    };
  }, [w.id]);

  const data = w.dataset ? s.frames[w.dataset] : undefined;
  const loading = w.dataset ? !!s.loading[w.dataset] : false;
  const error = w.dataset ? s.errors[w.dataset] : undefined;
  const fmtOpts = { locale: api.page.locale, currency: api.page.currency };

  const props = useMemo(() => {
    const raw = { ...(w.props ?? {}), ...(s.propOverrides[w.id] ?? {}) };
    if (SELF_BINDING.has(w.type)) return raw;
    try {
      return resolveBindings(raw, { filters: s.filterValues, data: s.frames, page: { id: s.bundle?.page.id, title: s.bundle?.page.title }, rows: data?.rows ?? [], row: data?.rows[0] ?? {} }, bindingFormatters(fmtOpts));
    } catch {
      return raw;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w, s.propOverrides[w.id], s.filterValues, s.frames, data]);

  if (!isVisible(w) && s.mode !== "edit") return null;

  if (w.type === "tabs") return <TabsWidget w={w} s={s} />;

  const def = s.widgets.get(w.type);
  const selected = s.mode === "edit" && s.selected === w.id;
  const hiddenInEdit = s.mode === "edit" && !isVisible(w);

  const renderProps: WidgetRenderProps = {
    widget: w,
    props,
    data,
    datasets: s.frames,
    loading,
    error,
    theme: s.theme!,
    width: size.width,
    height: size.height,
    api,
    emit: (event, payload) => runInteraction(w, event, payload as Record<string, unknown>),
    setHandle: (h) => handles.set(w.id, h),
    format: (v, spec) => formatValue(v, spec, fmtOpts),
    styleFor: (row, column, value) => {
      let out: Record<string, string | number> | undefined;
      for (const c of w.conditional ?? []) {
        if (c.column && column && c.column !== column) continue;
        if (c.column && !column) continue;
        try {
          if (evaluate(c.when, { ...row, row, value, column, filters: s.filterValues })) out = { ...(out ?? {}), ...c.style };
        } catch {
          /* invalid expression: ignore */
        }
      }
      return out;
    },
    editMode: s.mode === "edit",
  };

  const bare = def?.bare;
  const showHeader = !bare && (w.title || w.subtitle);
  const onSelect = () => {
    if (s.mode !== "edit") return;
    setState({ selected: w.id });
    send({ type: "selected", widgetId: w.id });
  };

  const downloadCsv = () => {
    if (!data) return;
    const csv = toCsv(data.rows, data.columns.map((c) => c.name));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `${(w.title ?? w.id).replace(/[^\w-]+/g, "_")}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  const askAi = () => {
    const ds = w.dataset ? summaries([w.dataset], 300)[0] : undefined;
    send({ type: "askWidget", widgetId: w.id, title: w.title, widgetType: w.type, props: w.props, dataset: ds });
  };

  return (
    <div
      ref={cardRef}
      className={`rt-card${bare ? " rt-bare" : ""}${selected ? " rt-selected" : ""}${hiddenInEdit ? " rt-hidden-edit" : ""}${full ? " rt-full" : ""}${nested ? " rt-nested" : ""}`}
      style={w.style as React.CSSProperties}
      onMouseDown={onSelect}
      data-widget={w.id}
    >
      {showHeader && (
        <div className="rt-card-head">
          <div className="rt-titles">
            {w.title && <div className="rt-title">{w.title}</div>}
            {w.subtitle && <div className="rt-subtitle">{w.subtitle}</div>}
          </div>
        </div>
      )}
      {s.mode !== "render" && !bare && (
        <div className="rt-menu-wrap" onMouseDown={(e) => e.stopPropagation()}>
          <button ref={menuBtn} className="rt-icon-btn" title="Widget menu" onClick={() => (menu ? setMenu(false) : openMenu())} aria-label="Widget menu">
            ⋯
          </button>
          {menu &&
            menuPos &&
            createPortal(
              <div ref={menuEl} className="rt-menu rt-menu-floating" style={{ top: menuPos.top, left: menuPos.left }} onMouseDown={(e) => e.stopPropagation()}>
                <button onClick={() => (setMenu(false), askAi())}>✦ Ask AI about this</button>
                {data && <button onClick={() => (setMenu(false), downloadCsv())}>⭳ Download CSV</button>}
                <button onClick={() => (setMenu(false), void toggleFull())}>{full ? "⤡ Exit full screen" : "⤢ Full screen"}</button>
                {w.dataset && <button onClick={() => (setMenu(false), void api.data.reload(w.dataset))}>↻ Reload data</button>}
              </div>,
              document.body,
            )}
        </div>
      )}
      <div className="rt-card-body" ref={contentRef}>
        {!def ? (
          <div className="rt-missing">
            Widget type <code>{w.type}</code> is not available{w.type.startsWith("custom.") ? (s.componentErrors[w.type.slice(7)] ? `: ${s.componentErrors[w.type.slice(7)]}` : " (component not compiled yet)") : " — is its skill enabled?"}
          </div>
        ) : error ? (
          <div className="rt-error" title={error}>
            <strong>Data error</strong>
            <span>{error}</span>
          </div>
        ) : size.width > 0 ? (
          <Boundary resetKey={`${w.type}|${JSON.stringify(w.props)}|${s.version > 0 ? data?.meta?.fetchedAt : ""}`}>
            <def.component {...renderProps} />
          </Boundary>
        ) : null}
        {loading && (
          <div className="rt-loading" aria-label="Loading">
            <span className="rt-spinner" />
          </div>
        )}
      </div>
      {full && (
        <button className="rt-full-close" onClick={() => void toggleFull()} aria-label="Exit full screen" title="Exit full screen (Esc)">
          ✕
        </button>
      )}
    </div>
  );
}

export const _internal = { getState };
