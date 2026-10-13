/** Import a whole project from a project package (.aibi): as a new project, or over the existing one after confirmation. */
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Database, FileText, FileUp, FolderKanban, Puzzle, XCircle } from "lucide-react";
import { ApiError, api, upload } from "../lib/api";
import { LoginFields, type LoginField } from "../components/SourceLogin";
import { useMe } from "../lib/hooks";
import { Badge, Button, Card, ErrorBox, Field, Input, Table, confirmDialog, cx, toast } from "../components/ui";
import { Container } from "../components/Layout";

interface Report {
  importId: string;
  manifest: { name: string; version: string; title: string; exportedAt: string; exportedBy?: { name?: string; email?: string } };
  project: { id: string; name: string; slug: string; description: string | null };
  pages: { id: string; title: string; widgets: number; datasets: number; action: "create" | "update" }[];
  sources: { alias: string; name: string; skill: string; action: "create" | "update"; credentialMode: "shared" | "user"; fields: LoginField[]; canKeep: boolean }[];
  skills: { id: string; range: string; status: string; installed?: string }[];
  modules: number;
  errors: { path: string; message: string }[];
  warnings: { path: string; message: string }[];
  conflict: { id: string; slug: string; name: string; archived: boolean; matchedBy: "id" | "slug"; pages: number; pagesKept: number } | null;
  suggestedSlug: string;
  modes: ("new" | "overwrite")[];
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

export function ProjectImport() {
  const me = useMe();
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  if (me.data && !me.data.user.isPlatformAdmin) return <Container><ErrorBox error="Importing a project requires a platform administrator" /></Container>;

  const analyze = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      setReport(await upload<Report>("/project-imports/analyze", file, file.name));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Container className="max-w-5xl">
      <h1 className="text-xl font-semibold">Import a project</h1>
      <p className="mt-1 mb-6 text-muted">
        A project package (.aibi from Export project) holds the project's settings, skills, data sources and pages. Credentials are never included. To import a single page, open its project and use Import page. Nothing is saved until you confirm.
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
            <div className="text-base font-medium">Drop a project package here</div>
            <Button variant="primary" loading={busy} onClick={() => input.current?.click()}>Choose file</Button>
            <input ref={input} type="file" accept=".aibi,.zip" className="hidden" onChange={(e) => e.target.files?.[0] && void analyze(e.target.files[0])} />
          </div>
          <ErrorBox error={error} className="mt-4" />
        </>
      ) : (
        <ReportView report={report} onReset={() => setReport(null)} />
      )}
    </Container>
  );
}

const icon = (ok: boolean, warn = false) => (ok ? <CheckCircle2 className="size-4 text-success" /> : warn ? <AlertTriangle className="size-4 text-warning" /> : <XCircle className="size-4 text-danger" />);

function ReportView({ report, onReset }: { report: Report; onReset: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [mode, setMode] = useState<Report["modes"][number]>(report.modes[0]);
  const [slug, setSlug] = useState(report.suggestedSlug);
  const [name, setName] = useState(report.conflict && report.suggestedSlug !== report.project.slug ? `${report.project.name} (copy)` : report.project.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [logins, setLogins] = useState<Record<string, Record<string, string>>>({});
  const [loginErrors, setLoginErrors] = useState<Record<string, string>>({});
  const c = report.conflict;
  // an overwrite may keep the stored login of an existing data source; everything else needs one entered
  const keeps = (s: Report["sources"][number]) => mode === "overwrite" && s.action === "update" && s.canKeep;
  const blocking = report.errors.length > 0 || (mode === "new" && (!SLUG_RE.test(slug) || !name.trim()));

  const commit = async () => {
    if (mode === "overwrite" && c) {
      const ok = await confirmDialog(
        `Overwrite project “${c.name}”?`,
        `This replaces the settings of “${c.name}” (${c.slug})${c.archived ? " and restores it from the archive" : ""}, updates its data sources (stored credentials are kept), and saves ${report.pages.filter((p) => p.action === "update").length} existing page(s) as new versions. ${c.pagesKept ? `${c.pagesKept} page(s) that are not in the package are kept.` : ""} Old page versions stay in their history.`,
        true,
      );
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    setLoginErrors({});
    try {
      const credentials = Object.fromEntries(Object.entries(logins).map(([alias, v]) => [alias, Object.fromEntries(Object.entries(v).filter(([, x]) => x !== ""))]));
      const r = await api<{ slug: string; pagesCreated: number; pagesUpdated: number }>(`/project-imports/${report.importId}/commit`, {
        body: mode === "overwrite" ? { mode, overwrite: true, credentials } : { mode, slug, name: name.trim(), credentials },
      });
      await qc.invalidateQueries({ queryKey: ["me"] });
      await qc.invalidateQueries({ queryKey: ["archived-projects"] });
      await qc.invalidateQueries({ queryKey: ["project", r.slug] });
      toast.success(`Project imported: ${r.pagesCreated} new page(s), ${r.pagesUpdated} updated; every data source connected`);
      nav(`/p/${r.slug}`);
    } catch (e) {
      const d = e instanceof ApiError ? (e.details as { code?: string; sources?: { alias: string; message: string }[] } | undefined) : undefined;
      if (d?.code === "credentials_invalid" && d.sources) setLoginErrors(Object.fromEntries(d.sources.map((x) => [x.alias, x.message])));
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <Card className="flex flex-wrap items-center gap-4 p-5">
        <div className="grid size-11 place-items-center rounded-xl bg-accent-soft text-accent">
          <FolderKanban className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold">{report.project.name}</div>
          <div className="text-[13px] text-muted">
            Project package <span className="font-mono">{report.project.slug}</span>, exported {new Date(report.manifest.exportedAt).toLocaleString()}
            {report.manifest.exportedBy?.email ? ` by ${report.manifest.exportedBy.email}` : ""}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge>{report.pages.length} pages</Badge>
            <Badge>{report.sources.length} data sources</Badge>
            <Badge>{report.skills.length} skills</Badge>
            <Badge>{report.modules} modules</Badge>
          </div>
        </div>
        <Button variant="ghost" onClick={onReset}>Choose another file</Button>
      </Card>

      {(report.errors.length > 0 || report.warnings.length > 0) && (
        <Card className="p-4">
          <div className="mb-2 font-semibold">Checks</div>
          {report.errors.map((e, i) => (
            <div key={i} className="flex gap-2 py-0.5 text-[13px] text-danger"><XCircle className="mt-0.5 size-4 shrink-0" /> {e.message}</div>
          ))}
          {report.warnings.map((e, i) => (
            <div key={i} className="flex gap-2 py-0.5 text-[13px] text-warning"><AlertTriangle className="mt-0.5 size-4 shrink-0" /> {e.message}</div>
          ))}
        </Card>
      )}

      <Card className="p-5">
        <div className="mb-3 font-semibold">Import as</div>
        {c && (
          <div className="mb-4 flex gap-2 rounded-lg bg-warning/10 p-3 text-[13px]">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <div>
              This project already exists on this server{c.matchedBy === "id" ? "" : " with the same slug"}: <b>{c.name}</b> (<span className="font-mono">{c.slug}</span>){c.archived ? ", archived" : ""}, with {c.pages} page(s). Choose whether to overwrite it or to import a separate copy.
            </div>
          </div>
        )}
        <div className="flex flex-col gap-2.5">
          {report.modes.includes("overwrite") && (
            <label className={cx("flex cursor-pointer gap-3 rounded-lg border p-3", mode === "overwrite" ? "border-danger/60 bg-danger/5" : "border-line")}>
              <input type="radio" name="mode" checked={mode === "overwrite"} onChange={() => setMode("overwrite")} />
              <div>
                <div className="font-medium">Overwrite “{c?.name}”</div>
                <div className="text-[13px] text-muted">Settings and data sources are updated (credentials kept); pages with the same id get a new version; other pages are kept.</div>
              </div>
            </label>
          )}
          <label className={cx("flex cursor-pointer gap-3 rounded-lg border p-3", mode === "new" ? "border-accent/60 bg-accent-soft/40" : "border-line")}>
            <input type="radio" name="mode" checked={mode === "new"} onChange={() => setMode("new")} />
            <div className="flex-1">
              <div className="font-medium">{c ? "A new, separate project" : "A new project"}</div>
              <div className="text-[13px] text-muted">You become its admin. Add members afterwards.</div>
              {mode === "new" && (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
                  <Field label="Slug" hint={!SLUG_RE.test(slug) ? <span className="text-danger">lower-case letters, digits and dashes</span> : "Used in URLs"}>
                    <Input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} />
                  </Field>
                </div>
              )}
            </div>
          </label>
        </div>
      </Card>

      <div className="grid gap-5 md:grid-cols-2">
        <section>
          <h2 className="mb-2 flex items-center gap-2 font-semibold"><FileText className="size-4 text-accent" /> Pages</h2>
          <Table head={["Page", "Widgets", mode === "overwrite" ? "Result" : ""]}>
            {report.pages.map((p) => (
              <tr key={p.id}>
                <td className="px-3 py-1.5">{p.title}</td>
                <td className="px-3 py-1.5 text-muted">{p.widgets}</td>
                <td className="px-3 py-1.5">{mode === "overwrite" ? (p.action === "update" ? <Badge tone="warning">new version</Badge> : <Badge tone="success">new page</Badge>) : null}</td>
              </tr>
            ))}
          </Table>
        </section>
        <section>
          <h2 className="mb-2 flex items-center gap-2 font-semibold"><Puzzle className="size-4 text-accent" /> Skills</h2>
          <Table head={["Skill", "Needs", "Status"]}>
            {report.skills.map((s) => (
              <tr key={s.id}>
                <td className="px-3 py-1.5">{s.id}</td>
                <td className="px-3 py-1.5 text-muted">{s.range}</td>
                <td className="px-3 py-1.5"><span className="flex items-center gap-1.5">{icon(s.status === "ok", s.status === "version")} {s.status}</span></td>
              </tr>
            ))}
          </Table>
        </section>
      </div>

      <section>
        <h2 className="mb-1 flex items-center gap-2 font-semibold"><Database className="size-4 text-accent" /> Data source logins</h2>
        <p className="mb-3 text-[13px] text-muted">
          Packages never contain login ids or passwords. Enter them here: each data source is connection-tested first, and nothing is imported unless every test passes.
        </p>
        <div className="flex flex-col gap-3">
          {report.sources.map((s) => (
            <Card key={s.alias} className={cx("p-4", loginErrors[s.alias] && "border-danger/50")}>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="font-medium">{s.name}</span>
                <code className="rounded bg-surface2 px-1.5 text-xs">{s.alias}</code>
                <span className="text-xs text-muted">{s.skill}</span>
                {s.credentialMode === "user" && <Badge tone="accent">per-user sign-in: this login is yours only</Badge>}
                {keeps(s) && <Badge tone="success">stored login kept unless you enter a new one</Badge>}
              </div>
              {s.fields.length ? (
                <LoginFields fields={s.fields} values={logins[s.alias] ?? {}} onChange={(v) => setLogins({ ...logins, [s.alias]: v })} keepHint={keeps(s)} />
              ) : (
                <div className="text-[13px] text-muted">No login needed; the connection is still tested.</div>
              )}
              {loginErrors[s.alias] && (
                <div className="mt-2 flex gap-2 text-[13px] text-danger"><XCircle className="mt-0.5 size-4 shrink-0" /> {loginErrors[s.alias]}</div>
              )}
            </Card>
          ))}
        </div>
      </section>

      <Card className="p-5">
        <ErrorBox error={error} className="mb-4" />
        <div className="flex justify-end gap-2">
          <Button onClick={onReset}>Cancel</Button>
          <Button variant={mode === "overwrite" ? "danger" : "primary"} loading={busy} disabled={blocking} onClick={commit}>
            {mode === "overwrite" ? "Test logins and overwrite…" : "Test logins and import"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
