export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
  }
}

async function parse(r: Response) {
  const ct = r.headers.get("content-type") ?? "";
  const body = ct.includes("application/json") ? await r.json().catch(() => null) : await r.text();
  if (!r.ok) {
    const msg = (body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : typeof body === "string" && body ? body.slice(0, 300) : r.statusText) || `HTTP ${r.status}`;
    throw new ApiError(msg, r.status, body && typeof body === "object" ? (body as { details?: unknown }).details : undefined);
  }
  return body;
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers: opts.body === undefined ? {} : { "content-type": "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: "same-origin",
    signal: opts.signal,
  });
  return (await parse(r)) as T;
}

export async function upload<T = unknown>(path: string, file: File | Blob, filename: string, fields: Record<string, string> = {}): Promise<T> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append("file", file, filename);
  const r = await fetch(`/api${path}`, { method: "POST", body: fd, credentials: "same-origin" });
  return (await parse(r)) as T;
}

/** Download a file from a GET or POST endpoint and save it in the browser. */
export async function download(path: string, opts: { method?: string; body?: unknown; fallbackName?: string } = {}) {
  const r = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers: opts.body === undefined ? {} : { "content-type": "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: "same-origin",
  });
  if (!r.ok) await parse(r);
  const cd = r.headers.get("content-disposition") ?? "";
  const name = /filename="?([^";]+)"?/.exec(cd)?.[1] ?? opts.fallbackName ?? "download";
  saveBlob(await r.blob(), name);
}

export function saveBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** POST and read a Server-Sent Events stream; calls onEvent for each JSON event. */
export async function stream(path: string, body: unknown, onEvent: (e: Record<string, unknown> & { type: string }) => void, signal?: AbortSignal) {
  const r = await fetch(`/api${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin", signal });
  if (!r.ok || !r.body) await parse(r);
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          onEvent(JSON.parse(line.slice(5)));
        } catch {
          /* ignore malformed chunk */
        }
      }
    }
  }
}

/* ───────── shared types ───────── */

export interface Me {
  user: { id: string; login: string; email: string | null; displayName: string | null; isPlatformAdmin: boolean; authProvider: string };
  projects: ProjectSummary[];
}
export interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  role: "admin" | "builder" | "viewer" | null;
  /** saved logins for the project's per-user data sources */
  dataSourceLogins: number;
}
export interface AppConfig {
  version: string;
  webOrigin: string;
  runtimeOrigin: string;
  apiUrl: string;
  needsSetup: boolean;
  providers: { id: string; label: string; kind: "password" | "redirect" }[];
  ai: { configured: boolean; model: string; baseUrl: string; available: boolean; reason?: "not-configured" | "invalid-key" | "unreachable" | "disabled"; message: string };
}
export interface PageMeta {
  id: string;
  title: string;
  description: string | null;
  tags: string[];
  visibility: "private" | "project";
  owner: { id: string; login: string; email: string | null; name: string | null } | null;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
  /** false while a data source the page reads from is disabled or missing */
  available: boolean;
  disabledSources: string[];
  missingSources: string[];
  /** every version is switched off: only admins can open the page */
  versionsDisabled: boolean;
}
export interface Issue {
  path: string;
  message: string;
}
