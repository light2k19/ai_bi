import { StrictMode, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { onHostMessage, send, useDirectTransport, isDirect } from "./bridge";
import { getState, subscribe, setState, init, update, setFilters, setColorMode, loadAll, runScriptByName, summaries, log } from "./engine";
import { Page } from "./components/Page";

function App() {
  const s = useSyncExternalStore(subscribe, getState);
  if (!s.initialized || !s.bundle) {
    return (
      <div className="rt-boot">
        <span className="rt-spinner" />
      </div>
    );
  }
  return <Page s={s} />;
}

let inited = false;
onHostMessage(async (m) => {
  try {
    switch (m.type) {
      case "init":
        inited = true;
        await init(m);
        break;
      case "update":
        await update(m.bundle, m.localModules);
        break;
      case "setFilters":
        await setFilters(m.filters);
        break;
      case "setMode":
        setState({ mode: m.mode });
        break;
      case "setColorMode":
        setColorMode(m.colorMode);
        break;
      case "select":
        setState({ selected: m.widgetId });
        break;
      case "command":
        if (m.name === "refresh") await loadAll(true);
        else if (m.name === "print") window.print();
        else if (m.name === "runScript" && typeof m.args?.name === "string") await runScriptByName(m.args.name);
        else if (m.name === "getState") {
          const st = getState();
          send({ type: "state", filtersRaw: st.filtersRaw, filterValues: st.filterValues as Record<string, unknown>, datasets: summaries(undefined, 500) });
        }
        break;
    }
  } catch (e) {
    log("error", (e as Error).message);
  }
});

const params = new URLSearchParams(location.search);
const renderToken = params.get("token");

if (renderToken && window.parent === window) {
  // standalone render (PDF / screenshots): talk to the API directly with the render token
  inited = true;
  const apiBase = (params.get("api") ?? __AIBI_API__).replace(/\/$/, "");
  const post = async <T,>(path: string, body: unknown): Promise<T> => {
    const r = await fetch(`${apiBase}/api/render/${encodeURIComponent(renderToken)}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "omit" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
    return j as T;
  };
  void (async () => {
    try {
      const r = await fetch(`${apiBase}/api/render/${encodeURIComponent(renderToken)}`, { credentials: "omit" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      useDirectTransport({
        query: (datasetId, source, request, filters) => post("/query", { datasetId, source, request, filters }),
        ai: async (prompt, datasets, filters, o) =>
          (await post<{ text: string }>("/narrative", { widgetId: o.widgetId ?? "w", prompt, maxWords: o.maxWords, datasets, page: { title: d.bundle.page.title, description: d.bundle.page.description, filters } })).text,
      });
      document.body.classList.add("rt-standalone");
      await init({ bundle: d.bundle, config: d.runtimeConfig, filters: d.filters, mode: "render", colorMode: "light" });
    } catch (e) {
      document.body.innerHTML = `<div style="padding:24px;color:#d64545">Render failed: ${String((e as Error).message).replace(/</g, "&lt;")}</div>`;
      document.body.dataset.ready = "1";
    }
  })();
  // never block a PDF forever
  setTimeout(() => (document.body.dataset.ready = "1"), 60_000);
} else {
  // handshake: announce until the host sends init
  const hello = setInterval(() => {
    if (inited) clearInterval(hello);
    else send({ type: "hello" });
  }, 300);
  send({ type: "hello" });
}

// report content height so the host can size the frame
let lastH = 0;
new ResizeObserver(() => {
  const h = Math.ceil(document.documentElement.scrollHeight);
  if (Math.abs(h - lastH) > 2) {
    lastH = h;
    send({ type: "height", height: h });
  }
}).observe(document.body);

window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
  const st = getState();
  if (st.colorMode === "auto") setColorMode("auto");
});

// periodic refresh declared by the page
setInterval(() => {
  const st = getState();
  const sec = st.bundle?.page.settings?.refreshSeconds;
  if (!sec || st.mode === "render" || !Object.keys(st.frames).length) return;
  const last = Math.max(0, ...Object.values(st.frames).map((f) => (f?.meta?.fetchedAt ? Date.parse(f.meta.fetchedAt) : 0)));
  if (Date.now() - last > sec * 1000) void loadAll(true);
}, 5000);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
