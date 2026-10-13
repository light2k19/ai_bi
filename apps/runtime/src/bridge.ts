import { PROTOCOL, type HostToRuntime, type RuntimeToHost, type DatasetSummary } from "@aibi/runtime-api/protocol";
import type { QueryResult } from "@aibi/transforms";

let hostOrigin: string | null = null;
let seq = 0;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
type Handler = (m: HostToRuntime) => void;
const handlers = new Set<Handler>();

export function send(msg: RuntimeToHost) {
  if (window.parent === window) return;
  // before init the host origin is unknown; only the data-free hello goes out with "*"
  if (!hostOrigin && msg.type !== "hello") return;
  window.parent.postMessage({ ...msg, protocol: PROTOCOL }, hostOrigin ?? "*");
}

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== window.parent) return;
  const d = e.data as HostToRuntime & { protocol?: string };
  if (!d || d.protocol !== PROTOCOL) return;
  if (d.type === "init") hostOrigin = e.origin;
  else if (!hostOrigin || e.origin !== hostOrigin) return;
  if (d.type === "queryResult" || d.type === "aiResult") {
    const p = pending.get(d.reqId);
    if (!p) return;
    pending.delete(d.reqId);
    clearTimeout(p.timer);
    if (d.error) p.reject(new Error(d.error));
    else p.resolve(d.type === "queryResult" ? d.result : d.text);
    return;
  }
  for (const h of handlers) h(d);
});

export function onHostMessage(h: Handler) {
  handlers.add(h);
  return () => handlers.delete(h);
}

function request<T>(build: (reqId: string) => RuntimeToHost, timeoutMs: number): Promise<T> {
  const reqId = `r${++seq}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error("The request timed out"));
    }, timeoutMs);
    pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject, timer });
    send(build(reqId));
  });
}

/**
 * Standalone render mode (PDF export, AI screenshots): the runtime is the top-level page and talks to
 * the API directly with a short-lived render token instead of going through a host frame.
 */
interface DirectTransport {
  query(datasetId: string, source: string, req: Record<string, unknown>, filters: Record<string, unknown>): Promise<QueryResult>;
  ai(prompt: string, datasets: DatasetSummary[], filters: Record<string, unknown>, opts: { widgetId?: string; maxWords?: number }): Promise<string>;
}
let direct: DirectTransport | null = null;
export function useDirectTransport(t: DirectTransport) {
  direct = t;
}
export const isDirect = () => direct !== null;

export function queryDataset(datasetId: string, source: string, req: Record<string, unknown>, filters: Record<string, unknown>): Promise<QueryResult> {
  if (direct) return direct.query(datasetId, source, req, filters);
  return request<QueryResult>((reqId) => ({ type: "query", reqId, datasetId, source, request: req, filters }), 330_000);
}

export function askAi(kind: "narrative" | "ask", prompt: string, datasets: DatasetSummary[], filters: Record<string, unknown>, opts: { widgetId?: string; maxWords?: number; refresh?: boolean } = {}): Promise<string> {
  if (direct) return direct.ai(prompt, datasets, filters, opts);
  return request<string>((reqId) => ({ type: "ai", reqId, kind, prompt, datasets, filters, ...opts }), 240_000);
}
