import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ClientSkillModule, WidgetRenderProps } from "@aibi/runtime-api";
import { bindingFormatters } from "@aibi/page-spec";
import { hardenLinks, interpolate, renderMarkdown } from "./markdown";
import "./styles.css";

type Tone = "plain" | "info" | "success" | "warning" | "danger";
const TONES = new Set<Tone>(["plain", "info", "success", "warning", "danger"]);
const SIZES = new Set(["sm", "md", "lg", "xl"]);
const ALIGNS = new Set(["left", "center", "right"]);

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function toneOf(v: unknown): Tone {
  return typeof v === "string" && TONES.has(v as Tone) ? (v as Tone) : "plain";
}

const TONE_ICON: Record<Exclude<Tone, "plain">, ReactNode> = {
  info: (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10 9v5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="10" cy="6.2" r="1.1" fill="currentColor" />
    </svg>
  ),
  success: (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6.3 10.4l2.4 2.4 5-5.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  warning: (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <path d="M10 2.5l8 14.5H2z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M10 8v4.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="10" cy="14.6" r="1" fill="currentColor" />
    </svg>
  ),
  danger: (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7 7l6 6M13 7l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
};

function Markdown({ html, className }: { html: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => hardenLinks(ref.current), [html]);
  return <div ref={ref} className={`aibi-md${className ? ` ${className}` : ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

function Callout({ tone, children, className, style }: { tone: Tone; children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={`aibi-text-box${tone !== "plain" ? ` aibi-tone aibi-tone-${tone}` : ""}${className ? ` ${className}` : ""}`} style={style}>
      {tone !== "plain" && <span className="aibi-tone-icon">{TONE_ICON[tone]}</span>}
      <div className="aibi-text-content">{children}</div>
    </div>
  );
}

/* ───────────────────────── text ───────────────────────── */

function TextWidget(rp: WidgetRenderProps) {
  const { props, data, datasets, api, format, setHandle, theme } = rp;
  const textProp = str(props.text) ?? "";
  const [override, setOverride] = useState<string | null>(null);
  useEffect(() => setOverride(null), [textProp]);
  useEffect(() => {
    setHandle({ setText: (md: unknown) => setOverride(md === undefined || md === null ? "" : String(md)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtersKey = JSON.stringify(api.filters.values);
  const html = useMemo(() => {
    const dataScope: Record<string, { rows: Record<string, unknown>[]; columns: unknown[] }> = {};
    for (const [id, f] of Object.entries(datasets)) if (f) dataScope[id] = { rows: f.rows, columns: f.columns };
    const scope = {
      rows: data?.rows ?? [],
      row: data?.rows[0] ?? {},
      data: dataScope,
      filters: api.filters.values,
      page: { id: api.page.id, title: api.page.title },
    };
    const fmts = bindingFormatters({ locale: api.page.locale, currency: api.page.currency });
    const display = (v: unknown): string => {
      if (v === null || v === undefined) return "";
      if (typeof v === "number") return format(v);
      if (Array.isArray(v)) return v.map((x) => (typeof x === "number" ? format(x) : x === null || x === undefined ? "" : typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ");
      if (typeof v === "object") return JSON.stringify(v);
      return String(v);
    };
    return renderMarkdown(interpolate(override ?? textProp, scope, fmts, display));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [override, textProp, data, datasets, filtersKey, api.page.locale, api.page.currency, format]);

  const tone = toneOf(props.tone);
  const size = typeof props.size === "string" && SIZES.has(props.size) ? props.size : "md";
  const align = typeof props.align === "string" && ALIGNS.has(props.align) ? props.align : "left";

  return (
    <div className={`aibi-text aibi-size-${size} aibi-align-${align}`} style={{ ["--aibi-r" as string]: `${theme.radius}px` }}>
      <Callout tone={tone}>
        <Markdown html={html} />
      </Callout>
    </div>
  );
}

/* ───────────────────────── narrative ───────────────────────── */

type NarrState = { status: "idle" | "loading" | "done" | "error"; text?: string; error?: string };

function Skeleton() {
  return (
    <div className="aibi-skeleton" aria-label="Writing commentary" role="status">
      <span style={{ width: "92%" }} />
      <span style={{ width: "78%" }} />
      <span style={{ width: "85%" }} />
      <span style={{ width: "54%" }} />
    </div>
  );
}

function NarrativeWidget(rp: WidgetRenderProps) {
  const { widget, props, datasets, api, setHandle, theme } = rp;
  const listed = Array.isArray(props.datasets) ? props.datasets.filter((x): x is string => typeof x === "string" && !!x) : [];
  const ids = listed.length ? listed : widget.dataset ? [widget.dataset] : [];
  const idsKey = ids.join("|");
  const ready = ids.every((id) => id in datasets && datasets[id] !== undefined);
  const key = ready
    ? JSON.stringify({
        d: ids.map((id) => {
          const f = datasets[id]!;
          return [f.rows.length, f.rows[0] ?? null];
        }),
        f: api.filters.values,
      })
    : null;
  const auto = props.auto !== false;
  const [state, setState] = useState<NarrState>({ status: "idle" });

  const keyRef = useRef(key);
  keyRef.current = key;
  const reqRef = useRef(0);
  const optsRef = useRef({ prompt: "", ids, maxWords: undefined as number | undefined });
  optsRef.current = {
    prompt: str(props.prompt) ?? "Summarise the key insights in the data.",
    ids,
    maxWords: typeof props.maxWords === "number" ? props.maxWords : Number.isFinite(Number(props.maxWords)) && props.maxWords !== undefined ? Number(props.maxWords) : undefined,
  };

  const generate = useCallback(
    (refresh: boolean) => {
      const k = keyRef.current;
      if (k === null) return;
      const id = ++reqRef.current;
      const o = optsRef.current;
      setState({ status: "loading" });
      api.ai
        .narrative({ widgetId: widget.id, prompt: o.prompt, datasets: o.ids, maxWords: o.maxWords, refresh })
        .then((text) => {
          if (id !== reqRef.current || keyRef.current !== k) return; // stale
          setState({ status: "done", text });
        })
        .catch((e: unknown) => {
          if (id !== reqRef.current || keyRef.current !== k) return;
          setState({ status: "error", error: e instanceof Error ? e.message : String(e) });
        });
    },
    [api, widget.id],
  );

  useEffect(() => {
    if (key === null) return;
    if (auto) generate(false);
    else {
      reqRef.current++; // drop in-flight results for the previous state
      setState({ status: "idle" });
    }
  }, [key, auto, idsKey, props.prompt, props.maxWords, generate]);

  useEffect(() => {
    setHandle({
      regenerate: () => generate(true),
      setText: (md: unknown) => {
        reqRef.current++;
        setState({ status: "done", text: md === undefined || md === null ? "" : String(md) });
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const html = useMemo(() => (state.status === "done" ? renderMarkdown(state.text ?? "") : ""), [state]);
  const tone = toneOf(props.tone);
  const busy = state.status === "loading" || key === null;

  let body: ReactNode;
  if (key === null || state.status === "loading") body = <Skeleton />;
  else if (state.status === "error")
    body = (
      <div className="aibi-narr-error" role="alert">
        <span>Couldn’t write the commentary: {state.error || "unknown error"}</span>
        <button type="button" className="aibi-link-btn" onClick={() => generate(true)}>
          Try again
        </button>
      </div>
    );
  else if (state.status === "idle")
    body = (
      <div className="aibi-narr-cta">
        <button type="button" className="aibi-btn" onClick={() => generate(false)}>
          <span aria-hidden="true">✦</span> Generate commentary
        </button>
      </div>
    );
  else body = <Markdown html={html} className="aibi-narr-md" />;

  return (
    <div className="aibi-text aibi-narrative aibi-size-md" style={{ ["--aibi-r" as string]: `${theme.radius}px` }}>
      <Callout tone={tone} className="aibi-narr-box">
        <div className="aibi-narr-head">
          <span className="aibi-narr-badge">
            <span aria-hidden="true">✦</span> AI commentary
          </span>
          {(state.status === "done" || state.status === "error") && (
            <button type="button" className="aibi-icon-btn" onClick={() => generate(true)} disabled={busy} title="Regenerate" aria-label="Regenerate commentary">
              <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
                <path d="M16 10a6 6 0 1 1-1.8-4.3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path d="M16.2 3.2v3.6h-3.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
        <div className="aibi-narr-body">{body}</div>
      </Callout>
    </div>
  );
}

/* ───────────────────────── image ───────────────────────── */

function imageSrc(src: string, api: WidgetRenderProps["api"]): { url?: string; error?: string } {
  const s = src.trim();
  if (s.startsWith("asset:")) {
    const name = s.slice(6).trim();
    const content = api.page.asset(name);
    if (!content) return { error: `Asset “${name}” was not found in the page assets.` };
    const c = content.trim();
    if (c.startsWith("data:")) return { url: c };
    if (/^<(\?xml|svg|!--)/i.test(c)) return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(c)}` };
    if (/^https:\/\//i.test(c)) return { url: c };
    if (/^[A-Za-z0-9+/=\s]{32,}$/.test(c)) {
      const ext = name.split(".").pop()?.toLowerCase();
      const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : ext === "svg" ? "image/svg+xml" : "image/png";
      return { url: `data:${mime};base64,${c.replace(/\s+/g, "")}` };
    }
    return { error: `Asset “${name}” is not an image.` };
  }
  if (/^https:\/\//i.test(s) || /^data:image\//i.test(s)) return { url: s };
  return { error: "Use an https:// URL or asset:<name> for images." };
}

function ImageWidget(rp: WidgetRenderProps) {
  const { props, api, theme } = rp;
  const src = str(props.src) ?? "";
  const [failed, setFailed] = useState(false);
  const resolved = useMemo(() => (src ? imageSrc(src, api) : { error: "Set `src` to an image." }), [src, api]);
  useEffect(() => setFailed(false), [resolved.url]);
  const fit = props.fit === "cover" ? "cover" : "contain";
  const error = resolved.error ?? (failed ? "The image could not be loaded." : undefined);
  return (
    <div className="aibi-image" style={{ ["--aibi-r" as string]: `${theme.radius}px` }}>
      {error ? (
        <div className="aibi-notice">{error}</div>
      ) : (
        <img src={resolved.url} alt={str(props.alt) ?? ""} style={{ objectFit: fit }} draggable={false} onError={() => setFailed(true)} />
      )}
    </div>
  );
}

/* ───────────────────────── embed ───────────────────────── */

function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((a) => {
    const x = a.trim().toLowerCase();
    if (!x) return false;
    if (x.startsWith("*.")) return h.endsWith(x.slice(1)) && h.length > x.length - 1;
    return h === x;
  });
}

function EmbedWidget(rp: WidgetRenderProps) {
  const { props, api, widget, editMode, theme } = rp;
  const url = str(props.url) ?? "";
  let parsed: URL | null = null;
  try {
    parsed = url ? new URL(url) : null;
  } catch {
    parsed = null;
  }
  let notice: ReactNode = null;
  if (!url) notice = "Set `url` to the page to embed.";
  else if (!parsed || !/^https?:$/.test(parsed.protocol)) notice = <>“{url}” is not a valid web address.</>;
  else if (!hostAllowed(parsed.host, api.page.embedHosts ?? []))
    notice = (
      <>
        <strong>{parsed.host}</strong> is not an allowed embed host for this project. Ask a project admin to add it to the allowed embed hosts in the project settings.
      </>
    );
  else if (parsed.protocol !== "https:") notice = "Only https:// pages can be embedded.";

  return (
    <div className="aibi-embed" style={{ ["--aibi-r" as string]: `${theme.radius}px` }}>
      {notice || !parsed ? (
        <div className="aibi-notice">
          <span className="aibi-notice-icon" aria-hidden="true">
            ⧉
          </span>
          <div>{notice}</div>
        </div>
      ) : (
        <iframe
          src={parsed.href}
          title={widget.title ?? parsed.host}
          sandbox="allow-scripts allow-same-origin allow-popups"
          referrerPolicy="no-referrer"
          loading="lazy"
          style={{ pointerEvents: editMode ? "none" : "auto" }}
        />
      )}
    </div>
  );
}

const mod: ClientSkillModule = {
  widgets: [
    { type: "text", component: TextWidget },
    { type: "narrative", component: NarrativeWidget },
    { type: "image", component: ImageWidget },
    { type: "embed", component: EmbedWidget },
  ],
};

export default mod;
