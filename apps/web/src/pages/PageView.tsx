import { useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, FileDown, FileSpreadsheet, GalleryHorizontalEnd, History, Lock, Package, Pencil, Printer, RefreshCw, Share2, Sparkles, Trash2, Users } from "lucide-react";
import type { PageBundle } from "@aibi/page-spec";
import { api, download, type PageMeta } from "../lib/api";
import { useConfig, useProject, useRuntimeConfig, timeAgo, isAdmin } from "../lib/hooks";
import { Badge, Button, ErrorBox, IconButton, Menu, MenuItem, Modal, PageLoader, Select, Field, confirmDialog, toast } from "../components/ui";
import { RuntimeFrame, type RuntimeFrameHandle } from "../components/RuntimeFrame";
import { AskPanel, type AskContext } from "../components/AskPanel";
import { useColorMode } from "../components/Layout";

interface PageResponse {
  meta: PageMeta;
  version: { versionNo: number; enabled?: boolean; message: string | null; source: string; createdAt: string };
  /** null when the page is off for this member (all versions disabled) */
  bundle: PageBundle | null;
  canEdit: boolean;
}

export function PageView() {
  const { pageId } = useParams();
  const [params, setParams] = useSearchParams();
  const versionParam = params.get("version");
  const { slug, data: project } = useProject();
  const cfg = useConfig();
  const rc = useRuntimeConfig(slug);
  const nav = useNavigate();
  const qc = useQueryClient();
  const frame = useRef<RuntimeFrameHandle>(null);
  const [colorMode] = useColorMode();
  const [ask, setAsk] = useState<{ open: boolean; ctx: AskContext | null }>({ open: false, ctx: null });
  const [share, setShare] = useState(false);
  const [versions, setVersions] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const page = useQuery({ queryKey: ["page", slug, pageId, versionParam], queryFn: () => api<PageResponse>(`/projects/${slug}/pages/${pageId}${versionParam ? `?version=${versionParam}` : ""}`) });

  if (page.isLoading || rc.isLoading || cfg.isLoading) return <PageLoader />;
  if (page.error) return <div className="p-8"><ErrorBox error={page.error} /></div>;
  if (!page.data || !rc.data || !cfg.data) return null;
  const { meta, bundle, version } = page.data;
  const viewingOld = version.versionNo !== meta.currentVersion;

  const exportFile = async (format: "pdf" | "xlsx") => {
    setExporting(format);
    try {
      const st = await frame.current?.getState();
      await download(`/projects/${slug}/pages/${meta.id}/export/${format}`, { body: { versionNo: version.versionNo, filters: st?.filtersRaw ?? {} } });
    } catch (e) {
      if (format === "pdf") {
        toast.info("Server PDF is unavailable; opening the print dialog instead.");
        frame.current?.print();
      } else toast.error(e);
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1600px] px-4 pt-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <Link to={`/p/${slug}`} className="mb-1 inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
                <ArrowLeft className="size-3.5" /> {project?.name}
              </Link>
              <h1 className="truncate text-xl font-semibold">{bundle?.page.title ?? meta.title}</h1>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                {(bundle?.page.description ?? meta.description) && <span className="text-[13px]">{bundle?.page.description ?? meta.description}</span>}
                <Badge>v{version.versionNo}</Badge>
                {meta.visibility === "private" ? <Badge><Lock className="size-3" /> private</Badge> : <Badge><Users className="size-3" /> project</Badge>}
                <span>updated {timeAgo(meta.updatedAt)}</span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {meta.available && (
                <>
              {project?.ai?.available !== false && (
                <Button icon={<Sparkles className="size-4" />} onClick={() => setAsk({ open: !ask.open, ctx: null })}>
                  Ask AI
                </Button>
              )}
              <Button icon={<RefreshCw className="size-4" />} onClick={() => frame.current?.refresh()} aria-label="Refresh data" title="Refresh data" />
              <Menu
                trigger={(t) => (
                  <Button icon={<Download className="size-4" />} onClick={t} loading={!!exporting}>
                    Export
                  </Button>
                )}
              >
                {(close) => (
                  <>
                    <MenuItem icon={<FileDown />} onClick={() => (close(), void exportFile("pdf"))}>PDF (current filters)</MenuItem>
                    <MenuItem icon={<FileSpreadsheet />} onClick={() => (close(), void exportFile("xlsx"))}>Excel workbook (current filters)</MenuItem>
                    <MenuItem icon={<Printer />} onClick={() => (close(), frame.current?.print())}>Print</MenuItem>
                    <div className="my-1 border-t border-line" />
                    <MenuItem icon={<Package />} onClick={() => (close(), void download(`/projects/${slug}/pages/${meta.id}/export?version=${version.versionNo}`).catch(toast.error))}>Page package (.aibi)</MenuItem>
                    {page.data.canEdit && (
                      <MenuItem
                        icon={<GalleryHorizontalEnd />}
                        onClick={async () => {
                          close();
                          try {
                            await download(`/projects/${slug}/pages/${meta.id}/export?version=${version.versionNo}&gallery=1`);
                            await qc.invalidateQueries({ queryKey: ["gallery", slug] });
                            toast.success("Published the page design to the project gallery (no data, no logins)");
                          } catch (e) {
                            toast.error(e);
                          }
                        }}
                      >
                        Publish design to gallery
                      </MenuItem>
                    )}
                  </>
                )}
              </Menu>
                </>
              )}
              <Button icon={<History className="size-4" />} onClick={() => setVersions(true)}>
                Versions
              </Button>
              {page.data.canEdit && (
                <>
                  <Button icon={<Share2 className="size-4" />} onClick={() => setShare(true)}>
                    Share
                  </Button>
                  {project?.ai?.available !== false && (
                    <Button variant="primary" icon={<Pencil className="size-4" />} onClick={() => nav(`/p/${slug}/pages/${meta.id}/edit`)}>
                      Edit
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
          {meta.versionsDisabled && isAdmin(project?.role) && (
            <div className="mb-3 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-[13px]">
              Every version of this page is disabled: members cannot open it until you enable one in Versions.
            </div>
          )}
          {viewingOld && (
            <div className="mb-3 flex items-center justify-between rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[13px]">
              <span>You are viewing version {version.versionNo}{version.enabled === false ? " (disabled: only admins can see it)" : ""}. The default version is {meta.currentVersion}.</span>
              <Button size="sm" onClick={() => setParams({})}>View default</Button>
            </div>
          )}
        </div>
        <div className="mx-auto max-w-[1600px] px-1 pb-8 sm:px-0">
          {meta.available && bundle ? (
          <RuntimeFrame
            ref={frame}
            slug={slug}
            runtimeUrl={cfg.data.runtimeOrigin}
            bundle={bundle}
            config={rc.data}
            mode="view"
            colorMode={colorMode}
            data={{ kind: "page", pageId: meta.id, versionNo: version.versionNo }}
            onAskWidget={(m) => setAsk({ open: true, ctx: { widgetId: m.widgetId, title: m.title, widgetType: m.widgetType, props: m.props, dataset: m.dataset } })}
          />
          ) : (
            <div className="mx-4 mt-6 rounded-xl border border-danger/40 bg-danger/5 p-6 sm:mx-0">
              <div className="flex items-center gap-2 font-semibold text-danger"><Lock className="size-4" /> This page is disabled</div>
              {meta.disabledSources.length + meta.missingSources.length > 0 ? (
                <p className="mt-2 text-[13px] text-muted">
                  It reads from {[...meta.disabledSources, ...meta.missingSources].map((a) => <code key={a} className="mx-0.5 rounded bg-surface2 px-1.5">{a}</code>)}, which {meta.disabledSources.length + meta.missingSources.length === 1 ? "is" : "are"} {meta.missingSources.length ? "missing or " : ""}disabled in this project. The page becomes available again as soon as an administrator enables the data source.
                </p>
              ) : (
                <p className="mt-2 text-[13px] text-muted">Every version of this page has been switched off. It becomes available again as soon as an administrator enables a version.</p>
              )}
              {isAdmin(project?.role) && meta.disabledSources.length + meta.missingSources.length > 0 && (
                <Link to={`/p/${slug}/admin`} className="mt-3 inline-block text-[13px] text-accent hover:underline">Open data sources</Link>
              )}
            </div>
          )}
        </div>
      </div>
      {ask.open && bundle && (
        <div className="hidden w-[400px] shrink-0 md:block">
          <AskPanel slug={slug} bundle={bundle} getState={() => frame.current!.getState()} context={ask.ctx} onClose={() => setAsk({ open: false, ctx: null })} />
        </div>
      )}
      <ShareDialog open={share} onClose={() => setShare(false)} slug={slug} meta={meta} admin={isAdmin(project?.role)} onChanged={() => void page.refetch()} />
      <VersionsDialog open={versions} onClose={() => setVersions(false)} slug={slug} meta={meta} admin={isAdmin(project?.role)} onChanged={(current, deleted) => (deleted === version.versionNo || current !== meta.currentVersion ? setParams({}) : undefined, void page.refetch(), void qc.invalidateQueries({ queryKey: ["pages", slug] }))} onView={(n) => (setVersions(false), setParams(n === meta.currentVersion ? {} : { version: String(n) }))} onPageDeleted={() => (void qc.invalidateQueries({ queryKey: ["pages", slug] }), nav(`/p/${slug}`))} />
    </div>
  );
}

function ShareDialog({ open, onClose, slug, meta, admin, onChanged }: { open: boolean; onClose: () => void; slug: string; meta: PageMeta; admin: boolean; onChanged: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const members = useQuery({ queryKey: ["members", slug], queryFn: () => api<{ userId: string; email: string; role: string }[]>(`/projects/${slug}/members`), enabled: open });
  const [vis, setVis] = useState(meta.visibility);
  const [owner, setOwner] = useState(meta.owner?.id ?? "");
  const save = async () => {
    try {
      await api(`/projects/${slug}/pages/${meta.id}`, { method: "PATCH", body: { visibility: vis, ownerId: owner !== meta.owner?.id ? owner : undefined } });
      toast.success("Sharing updated");
      onChanged();
      onClose();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Share page" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Who can view" hint="Project members always see pages shared with the project. Private pages are visible to you and project admins.">
          <Select value={vis} onChange={(e) => setVis(e.target.value as "private" | "project")}>
            <option value="project">Everyone in the project</option>
            <option value="private">Only me (and project admins)</option>
          </Select>
        </Field>
        <Field label="Owner">
          <Select value={owner} onChange={(e) => setOwner(e.target.value)}>
            {(members.data ?? []).filter((m) => m.role !== "viewer").map((m) => (
              <option key={m.userId} value={m.userId}>{m.email}</option>
            ))}
          </Select>
        </Field>
        <div className="rounded-lg bg-surface2 px-3 py-2 text-[13px] text-muted">To share with people outside this project, export the page package (.aibi) and send it; they import it into their project.</div>
        {admin && (
          <Button
            variant="ghost"
            className="self-start text-danger"
            icon={<Trash2 className="size-4" />}
            onClick={async () => {
              if (!(await confirmDialog("Delete page", `Delete “${meta.title}”? Its versions are kept for audit but it disappears for everyone.`, true))) return;
              await api(`/projects/${slug}/pages/${meta.id}`, { method: "DELETE" }).catch(toast.error);
              await qc.invalidateQueries({ queryKey: ["pages", slug] });
              nav(`/p/${slug}`);
            }}
          >
            Delete page
          </Button>
        )}
      </div>
    </Modal>
  );
}

/**
 * Every save makes a new version. Admins pick which one is the default (what everybody opens) and can switch
 * versions off: a disabled version is listed and viewable for admins only. Nothing is ever restored in place.
 */
function VersionsDialog({ open, onClose, slug, meta, admin, onChanged, onView, onPageDeleted }: { open: boolean; onClose: () => void; slug: string; meta: PageMeta; admin: boolean; onChanged: (currentVersion: number, deleted?: number) => void; onView: (n: number) => void; onPageDeleted: () => void }) {
  const versions = useQuery({ queryKey: ["versions", slug, meta.id], queryFn: () => api<{ versionNo: number; enabled: boolean; message: string | null; source: string; createdBy: string | null; createdAt: string }[]>(`/projects/${slug}/pages/${meta.id}/versions`), enabled: open });
  const [diff, setDiff] = useState<{ n: number; ops: { op: string; path: string }[] } | null>(null);
  type VersionItem = { versionNo: number; enabled: boolean };
  // decisions about "the only enabled version" / "the only version" use the list as it is now, not as rendered
  const fresh = () => api<VersionItem[]>(`/projects/${slug}/pages/${meta.id}/versions`);
  const act = async (label: string, fn: () => Promise<{ currentVersion?: number }>) => {
    try {
      const r = await fn();
      toast.success(label);
      await versions.refetch();
      onChanged(r.currentVersion ?? meta.currentVersion);
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Version history" width="max-w-2xl">
      {versions.isLoading ? (
        <PageLoader />
      ) : (
        <div className="flex max-h-[60vh] flex-col divide-y divide-line overflow-y-auto">
          {admin && <p className="pb-2 text-xs text-muted">Every edit saves a new version. The default version is the one members open; a disabled version is visible to admins only.</p>}
          {(versions.data ?? []).map((v, i, list) => (
            <div key={v.versionNo} className="py-2.5">
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone={v.versionNo === meta.currentVersion ? "accent" : "neutral"}>v{v.versionNo}</Badge>
                {v.versionNo === meta.currentVersion && <Badge tone="accent">default</Badge>}
                {!v.enabled && <Badge tone="danger">disabled</Badge>}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px]">{v.message ?? "(no message)"}</div>
                  <div className="text-xs text-muted">
                    {v.source} · {v.createdBy} · {new Date(v.createdAt).toLocaleString()}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => onView(v.versionNo)}>View</Button>
                {list[i + 1] && (
                  <Button
                    size="sm"
                    variant="ghost"
                    title={`Changes since v${list[i + 1].versionNo}`}
                    onClick={async () => setDiff({ n: v.versionNo, ops: await api(`/projects/${slug}/pages/${meta.id}/diff?from=${list[i + 1].versionNo}&to=${v.versionNo}`) })}
                  >
                    Changes
                  </Button>
                )}
                {admin && v.versionNo !== meta.currentVersion && v.enabled && (
                  <Button size="sm" onClick={() => void act(`v${v.versionNo} is now the default version`, () => api(`/projects/${slug}/pages/${meta.id}/versions/${v.versionNo}/default`, { method: "PUT", body: {} }))}>
                    Make default
                  </Button>
                )}
                {admin && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      if (v.enabled && v.versionNo === meta.currentVersion) {
                        const others = (await fresh()).some((x) => x.enabled && x.versionNo !== v.versionNo);
                        const text = others ? `v${v.versionNo} is the default version. The newest enabled version becomes the default instead.` : `v${v.versionNo} is the only enabled version. After disabling it the page is switched off for all members until you enable a version again.`;
                        if (!(await confirmDialog(`Disable version ${v.versionNo}?`, text, !others))) return;
                      }
                      await act(v.enabled ? `Disabled v${v.versionNo}` : `Enabled v${v.versionNo}`, () => api(`/projects/${slug}/pages/${meta.id}/versions/${v.versionNo}`, { method: "PATCH", body: { enabled: !v.enabled } }));
                    }}
                  >
                    {v.enabled ? "Disable" : "Enable"}
                  </Button>
                )}
                {admin && (
                  <IconButton
                    label={`Delete version ${v.versionNo}`}
                    className="hover:text-danger"
                    onClick={async () => {
                      const only = (await fresh()).length === 1;
                      const isCurrent = v.versionNo === meta.currentVersion;
                      const text = only
                        ? `v${v.versionNo} is the only version of “${meta.title}”. Deleting it deletes the page for everyone. This cannot be undone.`
                        : isCurrent
                          ? `v${v.versionNo} is the default version. After deleting it, the newest enabled version becomes the default that everyone opens. This cannot be undone.`
                          : `Delete v${v.versionNo} from the history of this page? This cannot be undone.`;
                      if (!(await confirmDialog(only ? "Delete the page?" : `Delete version ${v.versionNo}?`, text, true))) return;
                      try {
                        const r = await api<{ currentVersion: number; pageDeleted: boolean }>(`/projects/${slug}/pages/${meta.id}/versions/${v.versionNo}${only ? "?deletePage=1" : ""}`, { method: "DELETE" });
                        if (r.pageDeleted) {
                          toast.success(`Deleted “${meta.title}”`);
                          onPageDeleted();
                          return;
                        }
                        toast.success(`Deleted v${v.versionNo}`);
                        await versions.refetch();
                        onChanged(r.currentVersion, v.versionNo);
                      } catch (e) {
                        toast.error(e);
                      }
                    }}
                  >
                    <Trash2 className="size-4" />
                  </IconButton>
                )}
              </div>
              {diff?.n === v.versionNo && (
                <div className="mt-2 max-h-48 overflow-y-auto rounded-lg bg-surface2 p-2 font-mono text-[11.5px]">
                  {diff.ops.length === 0 ? "No changes" : diff.ops.slice(0, 200).map((o, i) => (
                    <div key={i} className={o.op === "add" ? "text-success" : o.op === "remove" ? "text-danger" : "text-ink"}>
                      {o.op === "add" ? "+" : o.op === "remove" ? "−" : "~"} {o.path}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
