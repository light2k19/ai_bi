import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { PageBundle } from "@aibi/page-spec";
import type { RuntimeConfig } from "@aibi/runtime-api/protocol";
import { api } from "../lib/api";
import { useConfig } from "../lib/hooks";
import { RuntimeFrame } from "../components/RuntimeFrame";
import { ErrorBox, PageLoader } from "../components/ui";

interface RenderData {
  projectSlug: string;
  mode: "page" | "draft";
  pageId?: string;
  versionNo?: number;
  filters: Record<string, unknown>;
  bundle: PageBundle;
  runtimeConfig: RuntimeConfig;
}

/** Page rendered for a headless browser (PDF export, AI screenshots). Authenticated by a short-lived token. */
export function Render() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const cfg = useConfig();
  const data = useQuery({ queryKey: ["render", token], queryFn: () => api<RenderData>(`/render/${encodeURIComponent(token)}`), retry: false });
  useEffect(() => {
    document.documentElement.classList.remove("dark");
    document.body.style.background = "#ffffff";
  }, []);
  // never block the PDF forever: mark ready after a ceiling even if some data failed
  useEffect(() => {
    const t = setTimeout(() => (document.body.dataset.ready = "1"), 60_000);
    return () => clearTimeout(t);
  }, []);
  if (data.isLoading || cfg.isLoading) return <PageLoader />;
  if (data.error || !data.data || !cfg.data) {
    document.body.dataset.ready = "1";
    return <div className="p-6"><ErrorBox error={data.error ?? "Render link is invalid"} /></div>;
  }
  const d = data.data;
  return (
    <div className="bg-white px-6 py-5 text-[#151a23]">
      <div className="mb-2 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">{d.bundle.page.title}</h1>
        <span className="text-xs text-[#5f6b7a]">Generated {new Date().toLocaleString()}</span>
      </div>
      {d.bundle.page.description && <p className="mb-3 text-[13px] text-[#5f6b7a]">{d.bundle.page.description}</p>}
      <RuntimeFrame
        slug={d.projectSlug}
        runtimeUrl={cfg.data.runtimeOrigin}
        bundle={d.bundle}
        config={d.runtimeConfig}
        mode="render"
        colorMode="light"
        filters={d.filters}
        data={{ kind: "render", token }}
        onReady={() => {
          // let charts finish their entry animation
          setTimeout(() => (document.body.dataset.ready = "1"), 800);
        }}
      />
    </div>
  );
}
