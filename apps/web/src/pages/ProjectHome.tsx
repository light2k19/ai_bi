import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "dexie-react-hooks";
import { FileText, HardDrive, LayoutGrid, Lock, Package, Plus, Search, Sparkles, Trash2, Upload, Users } from "lucide-react";
import { api, type PageMeta } from "../lib/api";
import { canBuild, timeAgo, useProject } from "../lib/hooks";
import { localDb, storageEstimate, type LocalPage } from "../lib/local-db";
import { Badge, Button, Card, EmptyState, Input, PageLoader, Tabs, confirmDialog, toast } from "../components/ui";
import { Container } from "../components/Layout";
import { OpenLocalDialog } from "../local/OpenLocal";

type Tab = "pages" | "local" | "gallery";

export function ProjectHome() {
  const { slug, data: project, isLoading } = useProject();
  const [tab, setTab] = useState<Tab>("pages");
  const [q, setQ] = useState("");
  const [openLocal, setOpenLocal] = useState(false);
  const nav = useNavigate();
  const pages = useQuery({ queryKey: ["pages", slug], queryFn: () => api<PageMeta[]>(`/projects/${slug}/pages`) });
  const local = useLiveQuery(() => localDb.pages.where("projectSlug").equals(slug).reverse().sortBy("updatedAt"), [slug]);
  const gallery = useQuery({ queryKey: ["gallery", slug], queryFn: () => api<{ id: string; kind: string; title: string; description?: string; version?: string; size: number; createdAt: string; createdBy?: string }[]>(`/projects/${slug}/gallery`), enabled: tab === "gallery" });

  const filtered = useMemo(() => (pages.data ?? []).filter((p) => !q || `${p.title} ${p.description ?? ""} ${p.tags.join(" ")}`.toLowerCase().includes(q.toLowerCase())), [pages.data, q]);

  if (isLoading || !project) return <PageLoader />;
  const builder = canBuild(project.role);
  const aiOn = project.ai?.available !== false;

  return (
    <Container>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{project.name}</h1>
          <p className="mt-1 text-muted">{project.description}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {builder && (
            <>
              <Button icon={<HardDrive className="size-4" />} onClick={() => setOpenLocal(true)}>
                Open local file
              </Button>
              <Button icon={<Upload className="size-4" />} onClick={() => nav(`/p/${slug}/import`)}>
                Import
              </Button>
              {aiOn && (
                <Button variant="primary" icon={<Sparkles className="size-4" />} onClick={() => nav(`/p/${slug}/new`)}>
                  New page with AI
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      {builder && !aiOn && (
        <div className="mb-5 rounded-lg border border-warning/30 bg-warning/10 px-4 py-2 text-[13px]">
          AI is off: {project.ai.message}. Pages can still be imported or opened from a local file.
        </div>
      )}

      <Tabs<Tab>
        className="mb-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "pages", label: "Pages", badge: <Badge>{pages.data?.length ?? 0}</Badge> },
          ...(builder ? [{ id: "local" as Tab, label: "On this browser", badge: <Badge>{local?.length ?? 0}</Badge> }] : []),
          { id: "gallery", label: "Gallery" },
        ]}
      />

      {tab === "pages" && (
        <>
          <div className="mb-4 flex max-w-sm items-center gap-2">
            <div className="relative w-full">
              <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted" />
              <Input className="pl-8" placeholder="Search pages" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
          {pages.isLoading ? (
            <PageLoader />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<LayoutGrid className="size-8" />}
              title={q ? "No pages match" : "No pages yet"}
              text={builder ? (aiOn ? "Describe the analysis you need and the AI builds a live page from your data." : "Import a page or open one from a local file.") : "Pages shared with you will appear here."}
              action={
                builder && aiOn && (
                  <Button variant="primary" icon={<Sparkles className="size-4" />} onClick={() => nav(`/p/${slug}/new`)}>
                    New page with AI
                  </Button>
                )
              }
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {filtered.map((p) => (
                <Link key={p.id} to={`/p/${slug}/pages/${p.id}`}>
                  <Card className="flex h-full flex-col p-5 transition hover:border-accent/50 hover:shadow-md">
                    <div className="flex items-start justify-between gap-2">
                      <div className="grid size-9 place-items-center rounded-lg bg-accent-soft text-accent">
                        <FileText className="size-4.5" />
                      </div>
                      <div className="flex gap-1">
                        {p.visibility === "private" ? (
                          <Badge>
                            <Lock className="size-3" /> private
                          </Badge>
                        ) : (
                          <Badge>
                            <Users className="size-3" /> project
                          </Badge>
                        )}
                        <Badge>v{p.currentVersion}</Badge>
                        {!p.available && (
                          <span className="cursor-help" title={p.disabledSources.length + p.missingSources.length ? `Data source ${[...p.disabledSources, ...p.missingSources].join(", ")} is disabled or missing` : "Every version of this page is disabled"}>
                            <Badge tone="danger">disabled</Badge>
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="mt-3 font-semibold">{p.title}</div>
                    <div className="mt-1 line-clamp-2 flex-1 text-[13px] text-muted">{p.description}</div>
                    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                      {p.tags.slice(0, 4).map((t) => (
                        <Badge key={t}>{t}</Badge>
                      ))}
                      <span className="ml-auto" title={p.owner ? `Owner: ${p.owner.name ?? p.owner.login}` : undefined}>
                        {p.owner ? `Owner ${p.owner.name ?? p.owner.login} · ` : ""}updated {timeAgo(p.updatedAt)}
                      </span>
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </>
      )}

      {tab === "local" && <LocalPages slug={slug} pages={local ?? []} onOpen={() => setOpenLocal(true)} />}
      {tab === "gallery" && <Gallery slug={slug} items={gallery.data} loading={gallery.isLoading} canImport={builder} />}

      <OpenLocalDialog slug={slug} open={openLocal} onClose={() => setOpenLocal(false)} />
    </Container>
  );
}

function LocalPages({ slug, pages, onOpen }: { slug: string; pages: LocalPage[]; onOpen: () => void }) {
  const est = useQuery({ queryKey: ["storage-estimate"], queryFn: storageEstimate });
  return (
    <div>
      <div className="mb-4 rounded-xl border border-line bg-surface2 px-4 py-3 text-[13px] text-muted">
        Pages here live only in this browser profile. They can use live data, but nobody else can see them until you use <b>Save to project</b>.
        {est.data && (
          <span className="ml-1">
            Storage used {(est.data.usage / 1e6).toFixed(1)} MB of {(est.data.quota / 1e9).toFixed(1)} GB{est.data.persisted ? " (persistent)" : ""}.
          </span>
        )}
      </div>
      {pages.length === 0 ? (
        <EmptyState icon={<HardDrive className="size-8" />} title="No local pages" text="Open a page.json or an .aibi package from your computer to work on it here." action={<Button onClick={onOpen}>Open local file</Button>} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {pages.map((p) => (
            <Card key={p.id} className="flex items-start gap-3 p-4">
              <Link to={`/p/${slug}/local/${p.id}`} className="flex flex-1 items-start gap-3">
                <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface2 text-muted">
                  <HardDrive className="size-4" />
                </div>
                <div className="min-w-0">
                  <div className="truncate font-medium">{p.title}</div>
                  <div className="text-xs text-muted">
                    {p.origin}
                    {p.fileName ? ` · ${p.fileName}` : ""} · {timeAgo(p.updatedAt)}
                  </div>
                </div>
              </Link>
              <button
                className="text-muted hover:text-danger"
                aria-label="Delete local page"
                onClick={async () => {
                  if (await confirmDialog("Delete local page", `Delete “${p.title}” from this browser? This cannot be undone.`, true)) {
                    await localDb.pages.delete(p.id);
                    await localDb.handles.delete(p.id);
                    toast.success("Local page deleted");
                  }
                }}
              >
                <Trash2 className="size-4" />
              </button>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function Gallery({ slug, items, loading, canImport }: { slug: string; items?: { id: string; kind: string; title: string; description?: string; version?: string; size: number; createdAt: string; createdBy?: string }[]; loading: boolean; canImport: boolean }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  if (loading) return <PageLoader />;
  if (!items?.length) return <EmptyState icon={<Package className="size-8" />} title="The gallery is empty" text="Publish a page design to the gallery from its Export menu so colleagues can import a copy." />;
  return (
    <>
    <p className="mb-4 text-[13px] text-muted">
      The gallery shares page designs only: no data and no logins. A copy you import shows the data your own data source accounts can see.
    </p>
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((g) => (
        <Card key={g.id} className="flex flex-col p-5">
          <div className="flex items-start justify-between">
            <div className="grid size-9 place-items-center rounded-lg bg-accent-soft text-accent">
              <Package className="size-4.5" />
            </div>
            <Badge tone={g.kind === "template" ? "accent" : "neutral"}>{g.kind === "template" ? "template" : `v${g.version}`}</Badge>
          </div>
          <div className="mt-3 font-semibold">{g.title}</div>
          <div className="mt-1 line-clamp-2 flex-1 text-[13px] text-muted">{g.description}</div>
          <div className="mt-3 text-xs text-muted">
            {g.createdBy} · {timeAgo(g.createdAt)} · {(g.size / 1024).toFixed(0)} KB
          </div>
          {canImport && (
            <div className="mt-4 flex gap-2">
              <Button
                size="sm"
                variant="primary"
                icon={<Plus className="size-4" />}
                onClick={async () => {
                  try {
                    const rep = await api<{ importId: string }>(`/projects/${slug}/packages/${g.id}/analyze`, { body: {} });
                    await qc.invalidateQueries({ queryKey: ["import"] });
                    nav(`/p/${slug}/import?id=${rep.importId}`);
                  } catch (e) {
                    toast.error(e);
                  }
                }}
              >
                Import a copy
              </Button>
              <a className="inline-flex h-8 items-center rounded-lg border border-line px-2.5 text-[13px] hover:bg-surface2" href={`/api/projects/${slug}/packages/${g.id}/download`}>
                Download
              </a>
            </div>
          )}
        </Card>
      ))}
    </div>
    </>
  );
}
