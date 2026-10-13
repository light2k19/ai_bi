import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Database, FileUp, Package, Puzzle, Sparkles, XCircle } from "lucide-react";
import { api, upload } from "../lib/api";
import { useProject } from "../lib/hooks";
import { Badge, Button, Card, ErrorBox, Field, Input, PageLoader, Select, Table, confirmDialog, cx, toast } from "../components/ui";
import { Container } from "../components/Layout";

interface Report {
  importId: string;
  kind: "package" | "bundle" | "page";
  manifest: { name: string; version: string; title: string; exportedAt: string; exportedBy?: { name?: string; email?: string } } | null;
  title: string;
  pageId: string;
  stats: Record<string, number>;
  errors: { path: string; message: string }[];
  warnings: { path: string; message: string }[];
  skills: { id: string; range: string; status: string; installed?: string }[];
  modules: { name: string; version: string; status: string; bundled: boolean }[];
  sources: { alias: string; dialect?: string; skill?: string; tables: string[]; candidates: { alias: string; name: string; skill: string; dialect?: string; coverage: { missingTables: string[]; missingColumns: Record<string, string[]>; ok: boolean; checked: boolean } }[]; suggested: string | null }[];
  origin: { id: string; slug: string; name: string } | null;
  conflict: { existingPageId: string; title: string; currentVersion: number } | null;
  modes: ("new" | "version" | "copy")[];
}

export function ImportWizard() {
  const { slug } = useProject();
  const [params] = useSearchParams();
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = params.get("id");
    if (id) api<{ report: Report }>(`/projects/${slug}/import/${id}`).then((r) => setReport(r.report)).catch(setError);
  }, [params, slug]);

  const analyze = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      setReport(await upload<Report>(`/projects/${slug}/import/analyze`, file, file.name));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Container className="max-w-5xl">
      <h1 className="text-xl font-semibold">Import a page</h1>
      <p className="mt-1 mb-6 text-muted">
        Bring in a page package (.aibi) exported from this project, a page built by your local AI with the authoring kit, or a page JSON. A page package can only be imported into the project it was exported from; to move a whole project, use Export project and Import project on the Projects page. Nothing is saved until you confirm.
      </p>
      {!report ? (
        <>
          <div
            onDragOver={(e) => (e.preventDefault(), setOver(true))}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              const f = e.dataTransfer.files[0];
              if (f) void analyze(f);
            }}
            className={cx("flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-6 py-16 text-center", over ? "border-accent bg-accent-soft" : "border-line bg-surface")}
          >
            <FileUp className="size-9 text-accent" />
            <div className="text-base font-medium">Drop a .aibi package or page JSON here</div>
            <Button variant="primary" loading={busy} onClick={() => input.current?.click()}>Choose file</Button>
            <input ref={input} type="file" accept=".aibi,.zip,.json" className="hidden" onChange={(e) => e.target.files?.[0] && void analyze(e.target.files[0])} />
          </div>
          <ErrorBox error={error} className="mt-4" />
        </>
      ) : (
        <ReportView slug={slug} report={report} onReset={() => setReport(null)} />
      )}
    </Container>
  );
}

const statusIcon = (ok: boolean, warn = false) => (ok ? <CheckCircle2 className="size-4 text-success" /> : warn ? <AlertTriangle className="size-4 text-warning" /> : <XCircle className="size-4 text-danger" />);

function ReportView({ slug, report, onReset }: { slug: string; report: Report; onReset: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [mapping, setMapping] = useState<Record<string, string>>(() => Object.fromEntries(report.sources.map((s) => [s.alias, s.suggested ?? ""])));
  const [mode, setMode] = useState<Report["modes"][number]>(report.modes[0]);
  const [title, setTitle] = useState(report.title);
  const [rewrites, setRewrites] = useState<Record<string, { original: string; proposed: string; ok: boolean; errors: string[]; accept: boolean }>>({});
  const [busy, setBusy] = useState(false);
  const [rewriting, setRewriting] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (!report) return <PageLoader />;

  const coverageFor = (alias: string) => report.sources.find((s) => s.alias === alias)?.candidates.find((c) => c.alias === mapping[alias])?.coverage;
  const blocking = report.errors.length > 0 || report.sources.some((s) => !mapping[s.alias]);

  const rewrite = async (alias: string) => {
    setRewriting(alias);
    try {
      const r = await api<Record<string, { original: string; proposed: string; ok: boolean; errors: string[] }>>(`/projects/${slug}/import/${report.importId}/rewrite`, { body: { alias, target: mapping[alias] } });
      setRewrites((cur) => ({ ...cur, ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { ...v, accept: v.ok }])) }));
    } catch (e) {
      toast.error(e);
    } finally {
      setRewriting(null);
    }
  };

  const commit = async () => {
    const overwrite = mode === "version" && !!report.conflict;
    if (
      overwrite &&
      !(await confirmDialog(
        `Overwrite “${report.conflict!.title}”?`,
        `The imported page replaces what everyone sees on “${report.conflict!.title}”. It is saved as version ${report.conflict!.currentVersion + 1}; version ${report.conflict!.currentVersion} stays in the page history and can be restored.`,
        true,
      ))
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const sqlOverrides = Object.fromEntries(Object.entries(rewrites).filter(([, v]) => v.accept && v.ok).map(([k, v]) => [k, v.proposed]));
      const r = await api<{ id: string; versionNo: number }>(`/projects/${slug}/import/${report.importId}/commit`, { body: { mapping, mode, title: title !== report.title ? title : undefined, sqlOverrides, overwrite } });
      await qc.invalidateQueries({ queryKey: ["pages", slug] });
      toast.success(mode === "version" ? `Imported as version ${r.versionNo}` : "Page imported");
      nav(`/p/${slug}/pages/${r.id}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <Card className="flex flex-wrap items-center gap-4 p-5">
        <div className="grid size-11 place-items-center rounded-xl bg-accent-soft text-accent">
          <Package className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold">{report.title}</div>
          <div className="text-[13px] text-muted">
            {report.manifest ? `Package ${report.manifest.name}@${report.manifest.version}${report.origin ? ` from project “${report.origin.name}”` : ""}, exported ${new Date(report.manifest.exportedAt).toLocaleString()}${report.manifest.exportedBy?.email ? ` by ${report.manifest.exportedBy.email}` : ""}` : report.kind === "bundle" ? "Page bundle JSON" : "Page JSON"}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {Object.entries(report.stats).map(([k, v]) => (
              <Badge key={k}>
                {v} {k}
              </Badge>
            ))}
          </div>
        </div>
        <Button variant="ghost" onClick={onReset}>Choose another file</Button>
      </Card>

      {(report.errors.length > 0 || report.warnings.length > 0) && (
        <Card className="p-4">
          <div className="mb-2 font-semibold">Checks</div>
          {report.errors.map((e, i) => (
            <div key={i} className="flex gap-2 py-0.5 text-[13px] text-danger">
              <XCircle className="mt-0.5 size-4 shrink-0" /> <code className="text-xs">{e.path}</code> {e.message}
            </div>
          ))}
          {report.warnings.map((e, i) => (
            <div key={i} className="flex gap-2 py-0.5 text-[13px] text-warning">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" /> <code className="text-xs">{e.path}</code> {e.message}
            </div>
          ))}
        </Card>
      )}

      <section>
        <h2 className="mb-2 flex items-center gap-2 font-semibold"><Database className="size-4 text-accent" /> Data sources</h2>
        <p className="mb-3 text-[13px] text-muted">The page refers to data sources by alias. Choose which of this project's connections each one should use. Credentials are never part of a package.</p>
        <div className="flex flex-col gap-3">
          {report.sources.map((s) => {
            const cov = coverageFor(s.alias);
            return (
              <Card key={s.alias} className="p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-40">
                    <div className="font-medium">{s.alias}</div>
                    <div className="text-xs text-muted">{s.dialect ?? s.skill ?? "any"} · {s.tables.length} tables</div>
                  </div>
                  <span className="text-muted">→</span>
                  <Select className="max-w-xs" value={mapping[s.alias] ?? ""} onChange={(e) => setMapping({ ...mapping, [s.alias]: e.target.value })}>
                    <option value="">Choose a data source…</option>
                    {s.candidates.map((c) => (
                      <option key={c.alias} value={c.alias}>
                        {c.alias} — {c.name}
                      </option>
                    ))}
                  </Select>
                  {cov && (
                    <span className="flex items-center gap-1.5 text-[13px]">
                      {statusIcon(cov.ok, !cov.checked)}
                      {!cov.checked ? "schema not loaded" : cov.ok ? "all tables and columns found" : "missing tables or columns"}
                    </span>
                  )}
                </div>
                {cov && !cov.ok && cov.checked && (
                  <div className="mt-3 rounded-lg bg-warning/10 p-3 text-[13px]">
                    {cov.missingTables.length > 0 && <div>Missing tables: {cov.missingTables.map((t) => <code key={t} className="mr-1">{t}</code>)}</div>}
                    {Object.entries(cov.missingColumns).map(([t, cols]) => (
                      <div key={t}>
                        Missing in <code>{t}</code>: {cols.map((c) => <code key={c} className="mr-1">{c}</code>)}
                      </div>
                    ))}
                    <Button size="sm" className="mt-2" icon={<Sparkles className="size-3.5" />} loading={rewriting === s.alias} onClick={() => void rewrite(s.alias)}>
                      Let AI adapt the queries
                    </Button>
                  </div>
                )}
                {!s.candidates.length && <div className="mt-2 text-[13px] text-danger">No compatible data source in this project. Ask an admin to add a {s.dialect ?? s.skill} connection.</div>}
              </Card>
            );
          })}
          {report.sources.length === 0 && <div className="text-[13px] text-muted">The page uses no data sources.</div>}
        </div>
      </section>

      {Object.keys(rewrites).length > 0 && (
        <section>
          <h2 className="mb-2 font-semibold">Proposed query changes</h2>
          <div className="flex flex-col gap-3">
            {Object.entries(rewrites).map(([id, r]) => (
              <Card key={id} className="p-4">
                <label className="mb-2 flex items-center gap-2 text-[13px] font-medium">
                  <input type="checkbox" checked={r.accept} disabled={!r.ok} onChange={(e) => setRewrites({ ...rewrites, [id]: { ...r, accept: e.target.checked } })} />
                  Use the new query for dataset <code>{id}</code>
                  {!r.ok && <Badge tone="danger">rejected: {r.errors.join("; ")}</Badge>}
                </label>
                <div className="grid gap-2 md:grid-cols-2">
                  <pre className="max-h-60 overflow-auto rounded-lg bg-danger/5 p-2 font-mono text-[11.5px] whitespace-pre-wrap">{r.original}</pre>
                  <pre className="max-h-60 overflow-auto rounded-lg bg-success/5 p-2 font-mono text-[11.5px] whitespace-pre-wrap">{r.proposed}</pre>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        <section>
          <h2 className="mb-2 flex items-center gap-2 font-semibold"><Puzzle className="size-4 text-accent" /> Skills</h2>
          <Table head={["Skill", "Needs", "Status"]}>
            {report.skills.map((s) => (
              <tr key={s.id}>
                <td className="px-3 py-1.5">{s.id}</td>
                <td className="px-3 py-1.5 text-muted">{s.range}</td>
                <td className="px-3 py-1.5">
                  <span className="flex items-center gap-1.5">{statusIcon(s.status === "ok", s.status === "disabled" || s.status === "version")} {s.status === "disabled" ? "will be enabled" : s.status}</span>
                </td>
              </tr>
            ))}
          </Table>
        </section>
        <section>
          <h2 className="mb-2 flex items-center gap-2 font-semibold"><Package className="size-4 text-accent" /> Modules</h2>
          {report.modules.length === 0 ? (
            <div className="text-[13px] text-muted">No extra modules.</div>
          ) : (
            <Table head={["Module", "Status"]}>
              {report.modules.map((m) => (
                <tr key={m.name}>
                  <td className="px-3 py-1.5">{m.name}@{m.version}</td>
                  <td className="px-3 py-1.5 text-muted">{m.status === "reused" ? "already in the module store" : m.status === "vendored" ? "bundled in the package" : m.status === "fetch" ? "will be fetched from the registry" : "missing"}</td>
                </tr>
              ))}
            </Table>
          )}
        </section>
      </div>

      <Card className="p-5">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Title">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Import as" hint={report.conflict ? <span className="text-warning">This page already exists in the project: “{report.conflict.title}” (v{report.conflict.currentVersion}).</span> : undefined}>
            <Select value={mode} onChange={(e) => setMode(e.target.value as Report["modes"][number])}>
              {report.modes.includes("new") && <option value="new">A new page</option>}
              {report.modes.includes("version") && <option value="version">Overwrite “{report.conflict?.title}” (old version kept in history)</option>}
              {report.modes.includes("copy") && <option value="copy">A copy (new page)</option>}
            </Select>
          </Field>
        </div>
        <ErrorBox error={error} className="mt-4" />
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onReset}>Cancel</Button>
          <Button variant={mode === "version" && report.conflict ? "danger" : "primary"} loading={busy} disabled={blocking} onClick={commit}>
            {mode === "version" && report.conflict ? "Overwrite page…" : "Import page"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
