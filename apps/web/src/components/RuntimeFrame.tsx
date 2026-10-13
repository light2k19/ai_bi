import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { PageBundle, Grid } from "@aibi/page-spec";
import { PROTOCOL, type HostToRuntime, type RuntimeToHost, type RuntimeConfig, type RuntimeMode, type LocalModuleSource, type DatasetSummary } from "@aibi/runtime-api/protocol";
import { api, stream } from "../lib/api";

export type DataSource =
  | { kind: "page"; pageId: string; versionNo?: number }
  | { kind: "draft" }
  | { kind: "render"; token: string };

export interface RuntimeState {
  filtersRaw: Record<string, unknown>;
  filterValues: Record<string, unknown>;
  datasets: DatasetSummary[];
}

export interface RuntimeFrameHandle {
  getState(): Promise<RuntimeState>;
  refresh(): void;
  print(): void;
  runScript(name: string): void;
  setFilters(raw: Record<string, unknown>): void;
}

export interface RuntimeFrameProps {
  slug: string;
  runtimeUrl: string;
  bundle: PageBundle;
  config: RuntimeConfig;
  mode: RuntimeMode;
  data: DataSource;
  filters?: Record<string, unknown>;
  localModules?: Record<string, LocalModuleSource>;
  selected?: string | null;
  colorMode?: "auto" | "light" | "dark";
  autoHeight?: boolean;
  minHeight?: number;
  className?: string;
  onSelect?: (id: string | null) => void;
  onLayout?: (grids: Record<string, Grid>) => void;
  onFiltersChange?: (raw: Record<string, unknown>) => void;
  onAskWidget?: (m: Extract<RuntimeToHost, { type: "askWidget" }>) => void;
  onReady?: (errors: Record<string, string>) => void;
  onLog?: (m: Extract<RuntimeToHost, { type: "log" }>) => void;
  onEvent?: (name: string, payload: unknown) => void;
}

export const RuntimeFrame = forwardRef<RuntimeFrameHandle, RuntimeFrameProps>(function RuntimeFrame(props, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const initialized = useRef(false);
  const lastSentBundle = useRef<string>("");
  const stateWaiters = useRef<((s: RuntimeState) => void)[]>([]);
  const [height, setHeight] = useState<number>(props.minHeight ?? 600);
  const origin = new URL(props.runtimeUrl).origin;

  const post = useCallback(
    (m: HostToRuntime) => {
      frame.current?.contentWindow?.postMessage({ ...m, protocol: PROTOCOL }, origin);
    },
    [origin],
  );

  const sendInit = useCallback(() => {
    const p = latest.current;
    lastSentBundle.current = JSON.stringify(p.bundle);
    post({ type: "init", bundle: p.bundle, config: p.config, filters: p.filters, mode: p.mode, colorMode: p.colorMode ?? "auto", localModules: p.localModules, selected: p.selected ?? null });
    initialized.current = true;
  }, [post]);

  useImperativeHandle(ref, () => ({
    getState: () =>
      new Promise<RuntimeState>((resolve) => {
        stateWaiters.current.push(resolve);
        post({ type: "command", name: "getState" });
        setTimeout(() => {
          const i = stateWaiters.current.indexOf(resolve);
          if (i >= 0) {
            stateWaiters.current.splice(i, 1);
            resolve({ filtersRaw: latest.current.filters ?? {}, filterValues: {}, datasets: [] });
          }
        }, 3000);
      }),
    refresh: () => post({ type: "command", name: "refresh" }),
    print: () => post({ type: "command", name: "print" }),
    runScript: (name) => post({ type: "command", name: "runScript", args: { name } }),
    setFilters: (raw) => post({ type: "setFilters", filters: raw }),
  }));

  useEffect(() => {
    const onMsg = async (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== origin) return;
      const m = e.data as RuntimeToHost & { protocol?: string };
      if (!m || m.protocol !== PROTOCOL) return;
      const p = latest.current;
      switch (m.type) {
        case "hello":
          sendInit();
          break;
        case "query": {
          try {
            let result;
            if (p.data.kind === "page") {
              result = await api(`/projects/${p.slug}/query/dataset`, { body: { pageId: p.data.pageId, versionNo: p.data.versionNo, datasetId: m.datasetId, filters: m.filters } });
            } else if (p.data.kind === "render") {
              result = await api(`/render/${encodeURIComponent(p.data.token)}/query`, { body: { datasetId: m.datasetId, source: m.source, request: m.request, filters: m.filters } });
            } else {
              result = await api(`/projects/${p.slug}/query/adhoc`, { body: { source: m.source, request: m.request, filters: m.filters, page: { id: p.bundle.page.id, title: p.bundle.page.title } } });
            }
            post({ type: "queryResult", reqId: m.reqId, result: result as never });
          } catch (err) {
            post({ type: "queryResult", reqId: m.reqId, error: (err as Error).message });
          }
          break;
        }
        case "ai": {
          try {
            let text = "";
            if (m.kind === "narrative") {
              const path = p.data.kind === "render" ? `/render/${encodeURIComponent(p.data.token)}/narrative` : `/projects/${p.slug}/ai/narrative`;
              const r = await api<{ text: string }>(path, {
                body: { pageId: p.bundle.page.id, widgetId: m.widgetId, prompt: m.prompt, maxWords: m.maxWords, refresh: m.refresh, datasets: m.datasets, page: { title: p.bundle.page.title, description: p.bundle.page.description, filters: m.filters } },
              });
              text = r.text;
            } else {
              await stream(`/projects/${p.slug}/ai/ask`, { question: m.prompt, datasets: m.datasets, page: { title: p.bundle.page.title, filters: m.filters } }, (ev) => {
                if (ev.type === "text") text += String(ev.delta);
                if (ev.type === "error") throw new Error(String(ev.message));
              });
            }
            post({ type: "aiResult", reqId: m.reqId, text });
          } catch (err) {
            post({ type: "aiResult", reqId: m.reqId, error: (err as Error).message });
          }
          break;
        }
        case "height":
          setHeight(Math.max(p.minHeight ?? 200, m.height));
          break;
        case "layout":
          p.onLayout?.(m.grids);
          break;
        case "selected":
          p.onSelect?.(m.widgetId);
          break;
        case "filtersChanged":
          p.onFiltersChange?.(m.filtersRaw);
          break;
        case "askWidget":
          p.onAskWidget?.(m);
          break;
        case "ready":
          p.onReady?.(m.errors);
          break;
        case "log":
          p.onLog?.(m);
          break;
        case "event":
          p.onEvent?.(m.name, m.payload);
          break;
        case "state": {
          const waiters = stateWaiters.current.splice(0);
          for (const w of waiters) w({ filtersRaw: m.filtersRaw, filterValues: m.filterValues, datasets: m.datasets });
          break;
        }
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [origin, post, sendInit]);

  // push bundle changes (debounced) once initialized
  useEffect(() => {
    if (!initialized.current) return;
    const s = JSON.stringify(props.bundle);
    if (s === lastSentBundle.current) return;
    const t = setTimeout(() => {
      lastSentBundle.current = s;
      post({ type: "update", bundle: latest.current.bundle, localModules: latest.current.localModules });
    }, 200);
    return () => clearTimeout(t);
  }, [props.bundle, props.localModules, post]);

  useEffect(() => {
    if (initialized.current) post({ type: "setMode", mode: props.mode });
  }, [props.mode, post]);
  useEffect(() => {
    if (initialized.current) post({ type: "setColorMode", colorMode: props.colorMode ?? "auto" });
  }, [props.colorMode, post]);
  useEffect(() => {
    if (initialized.current) post({ type: "select", widgetId: props.selected ?? null });
  }, [props.selected, post]);

  // a different page / data source needs a fresh runtime
  const frameKey = `${props.bundle.page.id}|${props.data.kind}|${props.data.kind === "page" ? props.data.versionNo : ""}`;
  useEffect(() => {
    initialized.current = false;
  }, [frameKey]);

  return (
    <iframe
      key={frameKey}
      ref={frame}
      title={props.bundle.page.title}
      src={`${props.runtimeUrl.replace(/\/$/, "")}/index.html`}
      sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals"
      allow="fullscreen"
      referrerPolicy="no-referrer"
      className={props.className}
      style={{ width: "100%", height: props.autoHeight === false ? "100%" : height, border: 0, display: "block", background: "transparent" }}
    />
  );
});
