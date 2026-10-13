import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, CheckCircle2, Database, Download, KeyRound, Plus, Puzzle, RefreshCw, Settings2, Trash2, Users, Activity, ScrollText, Package, XCircle, Copy, Plug, Archive, Pencil } from "lucide-react";
import { SetPasswordDialog } from "../components/SetPassword";
import { EditNameDialog } from "../components/EditName";
import type { JsonSchema } from "@aibi/page-spec";
import { api, download, upload } from "../lib/api";
import { useConfig, useMe, useProject, timeAgo, type ProjectDetail } from "../lib/hooks";
import { loginHint, useLoginCheck } from "../lib/useLoginCheck";
import { DeleteProjectDialog, EditProjectDialog, useProjectActions } from "./ProjectLifecycle";
import { Badge, Button, Card, EmptyState, ErrorBox, Field, Input, Modal, PageLoader, Select, Table, Tabs, Textarea, Toggle, confirmDialog, cx, toast } from "../components/ui";
import { Container } from "../components/Layout";
import { SchemaForm } from "./SchemaForm";
import { LoginFields, MyLoginDialog, SignInStatusDialog, useMyLogins, type MyLogin } from "../components/SourceLogin";

type Tab = "members" | "sources" | "skills" | "modules" | "settings" | "usage" | "audit" | "queries" | "localai";

export function ProjectAdmin() {
  const { slug, data: project, isLoading } = useProject();
  const [params, setParams] = useSearchParams();
  const tab = ((params.get("tab") as Tab | null) ?? "sources") as Tab;
  const setTab = (t: Tab) => setParams(t === "sources" ? {} : { tab: t }, { replace: true });
  if (isLoading || !project) return <PageLoader />;
  if (project.role !== "admin") return <Container><ErrorBox error="Project administration requires the admin role" /></Container>;
  return (
    <Container>
      <h1 className="text-xl font-semibold">{project.name} — administration</h1>
      <Tabs<Tab>
        className="mt-4 mb-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "sources", label: <><Database className="size-4" /> Data sources</> },
          { id: "members", label: <><Users className="size-4" /> Members</> },
          { id: "skills", label: <><Puzzle className="size-4" /> Skills</> },
          { id: "modules", label: <><Package className="size-4" /> Modules</> },
          { id: "settings", label: <><Settings2 className="size-4" /> Settings</> },
          { id: "usage", label: <><Activity className="size-4" /> Usage</> },
          { id: "queries", label: <><ScrollText className="size-4" /> Query log</> },
          { id: "audit", label: <><ScrollText className="size-4" /> Audit</> },
          { id: "localai", label: <><Bot className="size-4" /> Local AI</> },
        ]}
      />
      {tab === "sources" && <Sources slug={slug} />}
      {tab === "members" && <Members slug={slug} />}
      {tab === "skills" && <Skills slug={slug} />}
      {tab === "modules" && <Modules slug={slug} />}
      {tab === "settings" && <SettingsTab slug={slug} project={project} />}
      {tab === "usage" && <Usage slug={slug} />}
      {tab === "queries" && <QueryLog slug={slug} />}
      {tab === "audit" && <Audit slug={slug} />}
      {tab === "localai" && <LocalAi slug={slug} />}
    </Container>
  );
}

/* ───────── data sources ───────── */

interface Instance {
  id: string;
  skill: string;
  name: string;
  alias: string;
  description: string | null;
  status: string;
  statusMessage: string | null;
  config: Record<string, unknown>;
  kind: string;
  dialect?: string;
  credentialMode: "shared" | "user";
  credentialFields: { key: string; title: string; secret: boolean }[];
  systemLogin: boolean;
  systemLoginSupported: boolean;
}
interface SkillInfo {
  id: string;
  version: string;
  type: string;
  name: string;
  description: string;
  enabled: boolean;
  configSchema?: JsonSchema;
  secrets: string[];
  userCredentials: string[];
  source: string;
  approved: boolean;
  defaultEnabled: boolean;
  instances: { name: string; alias: string; status: string; description: string | null }[];
  loadError?: string;
  permissions: string[];
}

function Sources({ slug }: { slug: string }) {
  const sources = useQuery({ queryKey: ["sources", slug], queryFn: () => api<Instance[]>(`/projects/${slug}/sources`) });
  const skills = useQuery({ queryKey: ["project-skills", slug], queryFn: () => api<SkillInfo[]>(`/projects/${slug}/skills`) });
  const [edit, setEdit] = useState<Instance | "new" | null>(null);
  const [schemaFor, setSchemaFor] = useState<Instance | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const myLogins = useMyLogins(slug);
  const [loginFor, setLoginFor] = useState<MyLogin | null>(null);
  const [statusFor, setStatusFor] = useState<Instance | null>(null);
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["sources", slug] });
    void qc.invalidateQueries({ queryKey: ["runtime-config", slug] });
    void qc.invalidateQueries({ queryKey: ["my-credentials", slug] });
  };
  const dsSkills = (skills.data ?? []).filter((s) => s.type === "datasource" && s.enabled);
  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-4">
        <p className="max-w-3xl text-[13px] text-muted">
          Connections use read-only access: every query is checked to be a single SELECT, runs in a read-only transaction that is rolled back, and is limited in rows and time. Still use a database account with SELECT-only grants.
        </p>
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEdit("new")} disabled={!dsSkills.length}>
          Add data source
        </Button>
      </div>
      {sources.isLoading ? (
        <PageLoader />
      ) : !sources.data?.length ? (
        <EmptyState icon={<Database className="size-8" />} title="No data sources" text="Add a MySQL, SQL Server, Oracle, SQLite or HTTP API connection." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {sources.data.map((s) => (
            <Card key={s.id} className="p-4">
              <div className="flex items-start gap-3">
                <div className="grid size-9 place-items-center rounded-lg bg-accent-soft text-accent">
                  <Database className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{s.name}</span>
                    <code className="rounded bg-surface2 px-1.5 text-xs">{s.alias}</code>
                    {s.credentialMode === "user" && <Badge tone="accent">{s.systemLogin ? "AI BI account" : "per-user sign-in"}</Badge>}
                  </div>
                  <div className="text-xs text-muted">
                    {s.skill}
                    {s.dialect ? ` · ${s.dialect}` : ""}
                  </div>
                  {s.description && <div className="mt-1 text-[13px] text-muted">{s.description}</div>}
                  <div className="mt-2 flex items-start gap-1.5 text-[12.5px]">
                    {s.status === "ok" ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" /> : s.status === "error" ? <XCircle className="mt-0.5 size-3.5 shrink-0 text-danger" /> : <span className="mt-1 size-2 shrink-0 rounded-full bg-muted" />}
                    <span className={s.status === "error" ? "text-danger" : s.statusMessage?.includes("WARNING") ? "text-warning" : "text-muted"}>{s.status === "disabled" ? "disabled" : s.statusMessage ?? "not tested yet"}</span>
                  </div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  loading={busy === `t${s.id}`}
                  onClick={async () => {
                    setBusy(`t${s.id}`);
                    try {
                      const r = await api<{ ok: boolean; message: string }>(`/projects/${slug}/sources/${s.id}/test`, { body: {} });
                      r.ok ? toast.success(r.message) : toast.error(r.message);
                    } catch (e) {
                      toast.error(e);
                    } finally {
                      setBusy(null);
                      refresh();
                    }
                  }}
                >
                  Test
                </Button>
                <Button
                  size="sm"
                  icon={<RefreshCw className="size-3.5" />}
                  loading={busy === `i${s.id}`}
                  onClick={async () => {
                    setBusy(`i${s.id}`);
                    try {
                      const r = await api<{ tables: number; endpoints: number }>(`/projects/${slug}/sources/${s.id}/introspect`, { body: {} });
                      toast.success(`Schema loaded: ${r.tables} tables${r.endpoints ? `, ${r.endpoints} endpoints` : ""}`);
                    } catch (e) {
                      toast.error(e);
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  Load schema
                </Button>
                <Button size="sm" onClick={() => setSchemaFor(s)}>Describe for AI</Button>
                {s.credentialMode === "user" && (
                  <>
                    <Button size="sm" onClick={() => setLoginFor(myLogins.data?.find((m) => m.sourceId === s.id) ?? null)} disabled={!myLogins.data?.some((m) => m.sourceId === s.id)}>
                      {myLogins.data?.find((m) => m.sourceId === s.id)?.set ? "My login" : "Sign in"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setStatusFor(s)}>Who signed in</Button>
                  </>
                )}
                <Button size="sm" variant="ghost" onClick={() => setEdit(s)}>Edit</Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await api(`/projects/${slug}/sources/${s.id}`, { method: "PATCH", body: { status: s.status === "disabled" ? "enabled" : "disabled" } }).catch(toast.error);
                    refresh();
                  }}
                >
                  {s.status === "disabled" ? "Enable" : "Disable"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  onClick={async () => {
                    if (!(await confirmDialog("Delete data source", `Delete “${s.name}” (${s.alias})? Pages using it will show data errors.`, true))) return;
                    await api(`/projects/${slug}/sources/${s.id}`, { method: "DELETE" }).catch(toast.error);
                    refresh();
                  }}
                >
                  Delete
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      {edit && <SourceDialog slug={slug} skills={dsSkills} instance={edit === "new" ? null : edit} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), refresh())} />}
      {schemaFor && <AnnotationsDialog slug={slug} instance={schemaFor} onClose={() => setSchemaFor(null)} />}
      <MyLoginDialog slug={slug} item={loginFor} open={!!loginFor} onClose={() => setLoginFor(null)} onSaved={refresh} />
      <SignInStatusDialog slug={slug} source={statusFor} open={!!statusFor} onClose={() => setStatusFor(null)} />
    </div>
  );
}

function SourceDialog({ slug, skills, instance, onClose, onSaved }: { slug: string; skills: SkillInfo[]; instance: Instance | null; onClose: () => void; onSaved: () => void }) {
  const [skill, setSkill] = useState(instance?.skill ?? skills[0]?.id ?? "");
  const [f, setF] = useState({ name: instance?.name ?? "", alias: instance?.alias ?? "", description: instance?.description ?? "" });
  const [cfg, setCfg] = useState<Record<string, unknown>>(instance?.config ?? {});
  const [login, setLogin] = useState<Record<string, string>>({});
  const [systemLogin, setSystemLogin] = useState(instance?.systemLogin ?? false);
  const myLogins = useMyLogins(slug);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const s = skills.find((x) => x.id === skill);
  const loginKeys = s?.userCredentials ?? [];
  // logins are personal: they are not part of the project's connection settings
  const schema = s?.configSchema && loginKeys.length
    ? { ...s.configSchema, properties: Object.fromEntries(Object.entries(s.configSchema.properties ?? {}).filter(([k]) => !loginKeys.includes(k))), required: (s.configSchema.required ?? []).filter((k) => !loginKeys.includes(k)) }
    : s?.configSchema;
  const loginFields = loginKeys.map((k) => {
    const prop = (s?.configSchema?.properties ?? {})[k] as { title?: string; description?: string; format?: string } | undefined;
    return { key: k, title: prop?.title ?? k, description: prop?.description, secret: (s?.secrets ?? []).includes(k) || prop?.format === "password" };
  });
  const myCurrent = instance ? myLogins.data?.find((m) => m.sourceId === instance.id) : undefined;
  // AI BI accounts need a login name and a password field (token systems cannot use them)
  const systemLoginSupported = loginFields.some((f) => !f.secret) && loginFields.some((f) => f.secret && /pass|pwd/i.test(f.key));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const config = Object.fromEntries(Object.entries(cfg).filter(([k, v]) => v !== undefined && v !== "" && !loginKeys.includes(k)));
      const sysLogin = systemLoginSupported ? systemLogin : undefined;
      const saved = instance
        ? await api<{ id: string }>(`/projects/${slug}/sources/${instance.id}`, { method: "PATCH", body: { name: f.name, description: f.description, config, systemLogin: sysLogin } })
        : await api<{ id: string }>(`/projects/${slug}/sources`, { body: { skill, ...f, config, systemLogin: sysLogin } });
      // your own login: tested, then saved for you only
      const values = Object.fromEntries(Object.entries(login).filter(([, v]) => v !== ""));
      if (loginKeys.length && Object.keys(values).length) {
        const r = await api<{ saved: boolean; message: string }>(`/projects/${slug}/sources/${saved.id}/my-credentials`, { method: "PUT", body: { values } });
        await qc.invalidateQueries({ queryKey: ["my-credentials", slug] });
        if (!r.saved) {
          setError(`Settings saved, but your login was not: the connection test failed. ${r.message}`);
          onSaved();
          return;
        }
        toast.success(`Saved. Your login works: ${r.message}`);
      } else toast.success(loginKeys.length ? "Saved. Each member signs in with their own login." : "Saved. Use Test and Load schema next.");
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={instance ? `Edit ${instance.name}` : "Add data source"} width="max-w-2xl" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save} disabled={!f.name || !f.alias}>Save</Button></>}>
      <div className="flex flex-col gap-4">
        {!instance && (
          <Field label="Type">
            <Select value={skill} onChange={(e) => (setSkill(e.target.value), setCfg({}))}>
              {skills.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {s && <p className="-mt-2 text-xs text-muted">{s.description}</p>}
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field label="Name *">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, alias: instance ? f.alias : f.alias || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) })} />
          </Field>
          <Field label="Alias *" hint="Pages refer to the source by this name">
            <Input value={f.alias} disabled={!!instance} onChange={(e) => setF({ ...f, alias: e.target.value })} />
          </Field>
          <Field label="Description (helps the AI)" className="sm:col-span-2">
            <Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="e.g. ERP warehouse: orders, invoices, GL" />
          </Field>
        </div>
        {schema && (
          <div className="rounded-xl border border-line p-4">
            <div className="mb-3 text-[13px] font-semibold">Connection{loginKeys.length ? " (project settings, used by every page)" : ""}</div>
            <SchemaForm schema={schema} value={cfg} onChange={setCfg} secrets={s!.secrets} />
          </div>
        )}
        {systemLoginSupported && (
          <label className="flex items-start gap-2.5 rounded-xl border border-line p-4 text-[13px]">
            <input type="checkbox" className="mt-0.5" checked={systemLogin} onChange={(e) => setSystemLogin(e.target.checked)} />
            <span>
              <span className="font-medium">Members sign in with their AI BI account</span>
              <span className="block text-muted">Same login id and password as AI BI: each member is signed in to this data source when they sign in to AI BI (the login id is tried as the full e-mail, then as the part before the @). The connection is still verified before the project opens. Not for token-based systems.</span>
            </span>
          </label>
        )}
        {loginKeys.length > 0 && !systemLogin && (
          <div className="rounded-xl border border-accent/40 bg-accent-soft/30 p-4">
            <div className="mb-1 text-[13px] font-semibold">Your login (personal)</div>
            <p className="mb-3 text-[12.5px] text-muted">
              Logins are personal: this one is used only for your own queries, tested before it is saved, and never shown to anyone. Every other member signs in with their own account and sees the data that account may see.
              {myCurrent?.set ? " Leave empty to keep your current login." : ""}
            </p>
            <LoginFields fields={loginFields} values={login} onChange={setLogin} keepHint={!!myCurrent?.set} />
          </div>
        )}
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

interface SchemaResp {
  snapshot: { dialect?: string; schemas: { name: string; tables: { name: string; kind: string; rowEstimate?: number; comment?: string; columns: { name: string; type: string; pk?: boolean }[] }[] }[]; endpoints?: { method: string; path: string; description?: string }[] } | null;
  annotations: { tables?: Record<string, { description?: string; hidden?: boolean; columns?: Record<string, string> }>; glossary?: string };
  capturedAt: string | null;
}

function AnnotationsDialog({ slug, instance, onClose }: { slug: string; instance: Instance; onClose: () => void }) {
  const q = useQuery({ queryKey: ["schema", slug, instance.id], queryFn: () => api<SchemaResp>(`/projects/${slug}/sources/${instance.id}/schema`) });
  const [ann, setAnn] = useState<SchemaResp["annotations"] | null>(null);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const a = ann ?? q.data?.annotations ?? {};
  const tables = useMemo(() => (q.data?.snapshot?.schemas ?? []).flatMap((s) => s.tables.map((t) => ({ key: `${s.name}.${t.name}`, ...t }))).filter((t) => !filter || t.key.toLowerCase().includes(filter.toLowerCase())), [q.data, filter]);
  const setTable = (key: string, patch: Partial<{ description: string; hidden: boolean; columns: Record<string, string> }>) => setAnn({ ...a, tables: { ...(a.tables ?? {}), [key]: { ...(a.tables?.[key] ?? {}), ...patch } } });
  return (
    <Modal
      open
      onClose={onClose}
      title={`Describe ${instance.name} for the AI`}
      width="max-w-3xl"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            disabled={!ann}
            onClick={async () => {
              try {
                await api(`/projects/${slug}/sources/${instance.id}/annotations`, { method: "PUT", body: a });
                toast.success("Descriptions saved");
                onClose();
              } catch (e) {
                toast.error(e);
              }
            }}
          >
            Save descriptions
          </Button>
        </>
      }
    >
      {q.isLoading ? (
        <PageLoader />
      ) : !q.data?.snapshot ? (
        <EmptyState title="Schema not loaded" text="Use “Load schema” first." />
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-muted">Business descriptions are the biggest factor in good AI-written queries. Explain what tables mean, how to compute key measures, and hide tables the AI should ignore.</p>
          <Field label="Glossary and rules">
            <Textarea rows={3} value={a.glossary ?? ""} onChange={(e) => setAnn({ ...a, glossary: e.target.value })} placeholder="e.g. Revenue = SUM(amount) WHERE status = 'posted'. Fiscal year starts in April." />
          </Field>
          <Input placeholder="Filter tables" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="max-h-[45vh] overflow-y-auto rounded-xl border border-line">
            {tables.map((t) => {
              const ta = a.tables?.[t.key] ?? {};
              return (
                <div key={t.key} className="border-b border-line px-3 py-2 last:border-0">
                  <div className="flex items-center gap-2">
                    <button className="min-w-0 flex-1 text-left" onClick={() => setOpen(open === t.key ? null : t.key)}>
                      <span className="font-mono text-[13px] font-medium">{t.key}</span>
                      <span className="ml-2 text-xs text-muted">
                        {t.kind}
                        {t.rowEstimate !== undefined ? ` · ≈${t.rowEstimate.toLocaleString()} rows` : ""} · {t.columns.length} columns
                      </span>
                    </button>
                    <label className="flex items-center gap-1.5 text-xs text-muted">
                      hide <Toggle checked={!!ta.hidden} onChange={(v) => setTable(t.key, { hidden: v })} />
                    </label>
                  </div>
                  <Input className="mt-1.5 h-8 text-[13px]" placeholder={t.comment ?? "What does this table contain?"} value={ta.description ?? ""} onChange={(e) => setTable(t.key, { description: e.target.value })} />
                  {open === t.key && (
                    <div className="mt-2 grid gap-1.5 pl-3">
                      {t.columns.map((c) => (
                        <div key={c.name} className="grid grid-cols-[180px_1fr] items-center gap-2">
                          <span className="truncate font-mono text-xs">
                            {c.name} <span className="text-muted">{c.type}</span>
                          </span>
                          <Input className="h-7 text-xs" placeholder="meaning, units, allowed values" value={ta.columns?.[c.name] ?? ""} onChange={(e) => setTable(t.key, { columns: { ...(ta.columns ?? {}), [c.name]: e.target.value } })} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="text-xs text-muted">Schema loaded {timeAgo(q.data.capturedAt)}.</div>
        </div>
      )}
    </Modal>
  );
}

/* ───────── members ───────── */

function Members({ slug }: { slug: string }) {
  const members = useQuery({ queryKey: ["members", slug], queryFn: () => api<{ userId: string; login: string; email: string | null; name: string | null; role: string; enabled: boolean; platformDisabled: boolean; kind: "form" | "ad" | "sso"; lastLoginAt: string | null }[]>(`/projects/${slug}/members`) });
  const cfg = useConfig();
  const adEnabled = cfg.data?.providers.some((p) => p.id === "ldap") ?? false;
  const me = useMe();
  const patchMember = async (userId: string, body: { role?: string; enabled?: boolean; name?: string }) => {
    try {
      await api(`/projects/${slug}/members/${userId}`, { method: "PATCH", body });
    } catch (e) {
      if (body.name !== undefined) throw e;
      toast.error(e);
    }
    void members.refetch();
  };
  const [add, setAdd] = useState(false);
  const [f, setF] = useState({ kind: "form" as "form" | "ad", email: "", login: "", role: "viewer", name: "", password: "" });
  const [pwFor, setPwFor] = useState<{ userId: string; login: string; name: string | null } | null>(null);
  const [nameFor, setNameFor] = useState<{ userId: string; login: string; name: string | null } | null>(null);
  const check = useLoginCheck(add ? f.login : "");
  const hint = loginHint(check.data, f.kind, "project");
  const [error, setError] = useState<unknown>(null);
  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-[13px] text-muted">Viewers open pages and ask the AI about them. Builders create and edit pages. Admins manage data sources, skills and members. A disabled member keeps their role and pages but cannot see the project.</p>
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdd(true)}>Add member</Button>
      </div>
      <Table head={["Member", "Role", "Access", "Last sign-in", ""]}>
        {(members.data ?? []).map((m) => (
          <tr key={m.userId} className={m.enabled && !m.platformDisabled ? "" : "opacity-60"}>
            <td className="px-3 py-2">
              <div className="flex items-center gap-2 font-medium">
                {m.name ?? m.login}
                {m.kind === "ad" && <Badge tone="accent">AD</Badge>}
                {m.kind === "sso" && <Badge>SSO</Badge>}
                {!m.enabled && <Badge tone="danger">disabled</Badge>}
                {m.platformDisabled && <Badge tone="danger" className="cursor-help">disabled on the platform</Badge>}
              </div>
              <div className="text-xs text-muted">{m.login}{m.email && m.email !== m.login ? ` · ${m.email}` : ""}</div>
            </td>
            <td className="px-3 py-2">
              <Select
                className="h-8 w-32"
                value={m.role}
                onChange={(e) => void patchMember(m.userId, { role: e.target.value })}
              >
                <option value="viewer">viewer</option>
                <option value="builder">builder</option>
                <option value="admin">admin</option>
              </Select>
            </td>
            <td className="px-3 py-2">
              <div className="flex items-center gap-2">
                <Toggle checked={m.enabled} label={`${m.enabled ? "Disable" : "Enable"} ${m.login}`} onChange={(v) => void patchMember(m.userId, { enabled: v })} />
                <span className="text-xs text-muted" title={m.platformDisabled ? "The account is disabled under Platform admin → Users; enable it there" : undefined}>{m.userId === me.data?.user.id ? "you" : m.platformDisabled ? "no access (platform)" : m.enabled ? "enabled" : "no access"}</span>
              </div>
            </td>
            <td className="px-3 py-2 text-muted">{m.lastLoginAt ? timeAgo(m.lastLoginAt) : "never"}</td>
            <td className="px-3 py-2 text-right whitespace-nowrap">
              <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setNameFor(m)} title="Change the display name">
                Rename
              </Button>
              {m.kind === "form" && (
                <Button size="sm" variant="ghost" icon={<KeyRound className="size-3.5" />} onClick={() => setPwFor(m)} title="Set a new password for a member who forgot theirs">
                  Set password
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 className="size-3.5" />}
                onClick={async () => {
                  if (!(await confirmDialog("Remove member", `Remove ${m.name ?? m.login} from the project? Their pages move to you.`, true))) return;
                  await api(`/projects/${slug}/members/${m.userId}`, { method: "DELETE" }).catch(toast.error);
                  void members.refetch();
                }}
              >
                Remove
              </Button>
            </td>
          </tr>
        ))}
      </Table>
      <SetPasswordDialog open={!!pwFor} onClose={() => setPwFor(null)} path={`/projects/${slug}/members/${pwFor?.userId}/password`} who={pwFor?.name ?? pwFor?.login ?? ""} />
      {nameFor && <EditNameDialog key={nameFor.userId} open onClose={() => setNameFor(null)} initial={nameFor.name} login={nameFor.login} onSave={(name) => patchMember(nameFor.userId, { name })} />}
      <Modal
        open={add}
        onClose={() => setAdd(false)}
        title="Add member"
        footer={
          <>
            <Button onClick={() => setAdd(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!f.login.trim() || hint?.blocked || (f.kind === "form" && !check.data?.exists && f.password.length < 8)}
              onClick={async () => {
                setError(null);
                try {
                  await api(`/projects/${slug}/members`, { body: f.kind === "ad" ? { kind: "ad", login: f.login, role: f.role, name: f.name || undefined } : { kind: "form", login: f.login, email: f.email || undefined, role: f.role, name: f.name || undefined, password: f.password || undefined } });
                  setAdd(false);
                  setF({ kind: "form", email: "", login: "", role: "viewer", name: "", password: "" });
                  void members.refetch();
                } catch (e) {
                  setError(e);
                }
              }}
            >
              Add
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3.5">
          <Field label="User type">
            <div className="flex gap-4 text-[13px]">
              <label className="flex items-center gap-1.5"><input type="radio" checked={f.kind === "form"} onChange={() => setF({ ...f, kind: "form" })} /> Form user (login id and password)</label>
              <label className={cx("flex items-center gap-1.5", !adEnabled && "text-muted")} title={adEnabled ? undefined : "Enable Active Directory sign-in under Platform admin → Sign-in first"}>
                <input type="radio" disabled={!adEnabled} checked={f.kind === "ad"} onChange={() => setF({ ...f, kind: "ad" })} /> AD user (Windows user id)
              </label>
            </div>
          </Field>
          {f.kind === "ad" ? (
            <Field label="Windows user id" hint="e.g. jsmith — the email and name are read from Active Directory; the password stays there">
              <Input value={f.login} onChange={(e) => setF({ ...f, login: e.target.value })} autoFocus />
              {hint && <div className={cx("mt-1 text-xs", hint.tone === "bad" ? "text-danger" : hint.tone === "warn" ? "text-warning" : "text-success")}>{hint.text}</div>}
            </Field>
          ) : (
            <>
              <Field label="Login id" hint="What they type to sign in: any id without spaces, e.g. kim.lee">
                <Input value={f.login} onChange={(e) => setF({ ...f, login: e.target.value })} autoFocus />
                {hint && <div className={cx("mt-1 text-xs", hint.tone === "bad" ? "text-danger" : hint.tone === "warn" ? "text-warning" : "text-success")}>{hint.text}</div>}
              </Field>
              <Field label="Email (optional)" hint="Can also be used to sign in">
                <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
              </Field>
            </>
          )}
          <Field label="Role">
            <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              <option value="viewer">viewer</option>
              <option value="builder">builder</option>
              <option value="admin">admin</option>
            </Select>
          </Field>
          <Field label={f.kind === "ad" ? "Name (optional, overrides the directory)" : "Name (new users)"}>
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          {f.kind === "form" && !check.data?.exists && (
            <Field label="Initial password" hint="At least 8 characters; they can change it later from the account menu">
              <Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
            </Field>
          )}
          <ErrorBox error={error} />
        </div>
      </Modal>
    </div>
  );
}

/* ───────── skills ───────── */

function Skills({ slug }: { slug: string }) {
  const skills = useQuery({ queryKey: ["project-skills", slug], queryFn: () => api<SkillInfo[]>(`/projects/${slug}/skills`) });
  const qc = useQueryClient();
  const groups = useMemo(() => {
    const g: Record<string, SkillInfo[]> = {};
    for (const s of skills.data ?? []) (g[s.type] ??= []).push(s);
    return g;
  }, [skills.data]);
  if (skills.isLoading) return <PageLoader />;
  return (
    <div className="flex flex-col gap-6">
      <p className="text-[13px] text-muted">Skills are the capabilities a project can use: data source types, filters, transforms, visuals, exports and script libraries. Pages declare the skills they need; the AI only uses enabled ones.</p>
      {Object.entries(groups).map(([type, list]) => (
        <section key={type}>
          <h2 className="mb-2 text-sm font-semibold capitalize">{type}</h2>
          <div className="grid gap-2 md:grid-cols-2">
            {list.map((s) => (
              <Card key={s.id} className="flex items-start gap-3 p-3.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{s.name}</span>
                    <Badge>v{s.version}</Badge>
                    {s.source === "uploaded" && <Badge tone="warning">third-party</Badge>}
                    {!s.approved && <Badge tone="danger">awaiting approval</Badge>}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">{s.description}</div>
                  {s.loadError && <div className="mt-1 text-xs text-danger">Failed to load: {s.loadError}</div>}
                  {/* the project's data sources of this type, each on its own line: the skill is the type, these are the connections */}
                  {s.instances.length > 0 && (
                    <div className="mt-2 border-t border-line pt-2">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-muted">Data sources in this project</div>
                      <ul className="mt-1 flex flex-col gap-1">
                        {s.instances.map((i) => (
                          <li key={i.alias} className="flex flex-wrap items-center gap-2 text-[13px]">
                            <Database className="size-3.5 text-muted" />
                            <span>{i.name}</span>
                            <Badge>{i.alias}</Badge>
                            {i.status === "disabled" && <Badge tone="danger">disabled</Badge>}
                            {i.description && <span className="text-xs text-muted">— {i.description}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
                <Toggle
                  checked={s.enabled}
                  label={`Enable ${s.name}`}
                  onChange={async (v) => {
                    try {
                      await api(`/projects/${slug}/skills/${s.id}`, { method: "PUT", body: { enabled: v } });
                      await qc.invalidateQueries({ queryKey: ["project-skills", slug] });
                      await qc.invalidateQueries({ queryKey: ["runtime-config", slug] });
                    } catch (e) {
                      toast.error(e);
                    }
                  }}
                />
              </Card>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/* ───────── modules ───────── */

function Modules({ slug }: { slug: string }) {
  const mods = useQuery({ queryKey: ["modules", slug], queryFn: () => api<{ name: string; version: string; status: string; addedBy: string | null; addedAt: string; hash?: string; url?: string; size: number; files: number }[]>(`/projects/${slug}/modules`) });
  const [up, setUp] = useState({ name: "", version: "", providesWidgets: "" });
  const [file, setFile] = useState<File | null>(null);
  const setStatus = async (name: string, version: string, status: "approved" | "rejected") => {
    await api(`/projects/${slug}/modules/status`, { body: { name, version, status } }).catch(toast.error);
    void mods.refetch();
  };
  return (
    <div className="flex flex-col gap-5">
      <p className="text-[13px] text-muted">Modules are extra JavaScript libraries used by page scripts and custom components. They are stored content-addressed, pinned with integrity hashes and served to the sandboxed page runtime. Turn on approval in Settings to review new modules before use.</p>
      <Table head={["Module", "Status", "Files", "Source", "Added", ""]}>
        {(mods.data ?? []).map((m) => (
          <tr key={`${m.name}@${m.version}`}>
            <td className="px-3 py-2">
              <div className="font-medium">{m.name}@{m.version}</div>
              <div className="font-mono text-[11px] text-muted">{m.hash?.slice(0, 20)}…</div>
            </td>
            <td className="px-3 py-2"><Badge tone={m.status === "approved" ? "success" : m.status === "pending" ? "warning" : "danger"}>{m.status}</Badge></td>
            <td className="px-3 py-2 text-muted">{m.files} · {(m.size / 1024).toFixed(0)} KB</td>
            <td className="max-w-56 truncate px-3 py-2 text-xs text-muted">{m.url ?? "uploaded"}</td>
            <td className="px-3 py-2 text-muted">{timeAgo(m.addedAt)}</td>
            <td className="px-3 py-2 text-right">
              {m.status !== "approved" && <Button size="sm" onClick={() => void setStatus(m.name, m.version, "approved")}>Approve</Button>}
              {m.status !== "rejected" && <Button size="sm" variant="ghost" onClick={() => void setStatus(m.name, m.version, "rejected")}>Reject</Button>}
            </td>
          </tr>
        ))}
        {!mods.data?.length && <tr><td colSpan={6} className="px-3 py-6 text-center text-muted">No modules yet</td></tr>}
      </Table>
      <Card className="p-4">
        <div className="mb-2 font-semibold">Upload a bundled module</div>
        <p className="mb-3 text-[13px] text-muted">A single-file ES module (e.g. your company's widget library). If it exports <code>register(runtime)</code> it can add widget types.</p>
        <div className="grid gap-3 sm:grid-cols-4">
          <Input placeholder="name, e.g. @acme/widgets" value={up.name} onChange={(e) => setUp({ ...up, name: e.target.value })} />
          <Input placeholder="version, e.g. 1.0.0" value={up.version} onChange={(e) => setUp({ ...up, version: e.target.value })} />
          <Input placeholder="widget types (optional)" value={up.providesWidgets} onChange={(e) => setUp({ ...up, providesWidgets: e.target.value })} />
          <input type="file" accept=".js,.mjs" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-[13px]" />
        </div>
        <Button
          className="mt-3"
          disabled={!file || !up.name || !up.version}
          onClick={async () => {
            try {
              await upload(`/projects/${slug}/modules/upload`, file!, file!.name, up);
              toast.success("Module uploaded");
              void mods.refetch();
            } catch (e) {
              toast.error(e);
            }
          }}
        >
          Upload
        </Button>
      </Card>
    </div>
  );
}

/* ───────── settings ───────── */

function SettingsTab({ slug, project }: { slug: string; project: ProjectDetail }) {
  const settings = project.settings;
  const qc = useQueryClient();
  const cfg = useConfig();
  const ai = (settings.ai ?? {}) as Record<string, unknown>;
  const limits = (settings.limits ?? {}) as Record<string, unknown>;
  const [f, setF] = useState({
    aiEnabled: ai.enabled !== false,
    model: String(ai.model ?? ""),
    fastModel: String(ai.fastModel ?? ""),
    toolMode: String(ai.toolMode ?? "native"),
    monthlyTokenBudget: ai.monthlyTokenBudget ? String(ai.monthlyTokenBudget) : "",
    monthlyCostBudget: ai.monthlyCostBudget ? String(ai.monthlyCostBudget) : "",
    viewerQueries: ai.viewerQueries === true,
    maxRows: limits.maxRows ? String(limits.maxRows) : "",
    timeoutMs: limits.timeoutMs ? String(limits.timeoutMs) : "",
    moduleHosts: ((settings.moduleHosts as string[]) ?? []).join(", "),
    moduleApproval: settings.moduleApproval === true,
    embedHosts: ((settings.embedHosts as string[]) ?? []).join(", "),
  });
  const num = (s: string) => (s.trim() ? Number(s) : undefined);
  const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  const save = async () => {
    try {
      await api(`/projects/${slug}`, {
        method: "PATCH",
        body: {
          settings: {
            ai: { enabled: f.aiEnabled, model: f.model || undefined, fastModel: f.fastModel || undefined, toolMode: f.toolMode as "native", monthlyTokenBudget: num(f.monthlyTokenBudget), monthlyCostBudget: num(f.monthlyCostBudget), viewerQueries: f.viewerQueries },
            limits: { maxRows: num(f.maxRows), timeoutMs: num(f.timeoutMs) },
            moduleHosts: list(f.moduleHosts),
            moduleApproval: f.moduleApproval,
            embedHosts: list(f.embedHosts),
          },
        },
      });
      await qc.invalidateQueries({ queryKey: ["project", slug] });
      await qc.invalidateQueries({ queryKey: ["runtime-config", slug] });
      toast.success("Settings saved");
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <GeneralCard project={project} />
      <Card className="p-5">
        <div className="mb-3 font-semibold">AI</div>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field label="AI enabled" hint={project.ai?.available ? "Members can build and edit pages with AI and ask about page data" : project.ai?.reason === "disabled" ? "Turned off for this project: no AI page building, editing or questions" : `Unavailable on this server: ${project.ai?.message}`}>
            <div className="flex h-9 items-center"><Toggle checked={f.aiEnabled} onChange={(v) => setF({ ...f, aiEnabled: v })} /></div>
          </Field>
          <Field label="Tool mode" hint="Use JSON mode for local models without function calling">
            <Select value={f.toolMode} onChange={(e) => setF({ ...f, toolMode: e.target.value })}>
              <option value="native">Function calling (recommended)</option>
              <option value="json">JSON page output</option>
            </Select>
          </Field>
          <Field label="Builder model" hint={`Default: ${cfg.data?.ai.model}`}>
            <Input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} placeholder={cfg.data?.ai.model} />
          </Field>
          <Field label="Fast model (answers, narratives)">
            <Input value={f.fastModel} onChange={(e) => setF({ ...f, fastModel: e.target.value })} placeholder="same as default" />
          </Field>
          <Field label="Monthly token budget"><Input value={f.monthlyTokenBudget} onChange={(e) => setF({ ...f, monthlyTokenBudget: e.target.value })} placeholder="unlimited" /></Field>
          <Field label="Monthly cost budget (USD)"><Input value={f.monthlyCostBudget} onChange={(e) => setF({ ...f, monthlyCostBudget: e.target.value })} placeholder="unlimited" /></Field>
          <Field label="Viewers' AI may run new queries" hint="Off: answers use only the data on the page">
            <div className="flex h-9 items-center"><Toggle checked={f.viewerQueries} onChange={(v) => setF({ ...f, viewerQueries: v })} /></div>
          </Field>
        </div>
      </Card>
      <Card className="p-5">
        <div className="mb-3 font-semibold">Query limits</div>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field label="Max rows per query"><Input value={f.maxRows} onChange={(e) => setF({ ...f, maxRows: e.target.value })} placeholder="10000" /></Field>
          <Field label="Timeout (ms)"><Input value={f.timeoutMs} onChange={(e) => setF({ ...f, timeoutMs: e.target.value })} placeholder="30000" /></Field>
        </div>
      </Card>
      <Card className="p-5">
        <div className="mb-3 font-semibold">Modules and embeds</div>
        <div className="grid gap-3.5">
          <Field label="Allowed module hosts" hint="Comma separated; empty uses the server default (esm.sh, cdn.jsdelivr.net, unpkg.com)"><Input value={f.moduleHosts} onChange={(e) => setF({ ...f, moduleHosts: e.target.value })} /></Field>
          <Field label="Require admin approval for new modules"><div className="flex h-9 items-center"><Toggle checked={f.moduleApproval} onChange={(v) => setF({ ...f, moduleApproval: v })} /></div></Field>
          <Field label="Hosts allowed in embed widgets"><Input value={f.embedHosts} onChange={(e) => setF({ ...f, embedHosts: e.target.value })} placeholder="e.g. reports.example.com" /></Field>
        </div>
      </Card>
      <div><Button variant="primary" onClick={save}>Save settings</Button></div>
      <DangerZone project={project} />
    </div>
  );
}

function GeneralCard({ project }: { project: ProjectDetail }) {
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="font-semibold">General</div>
        <div className="flex gap-2">
          <Button size="sm" icon={<Download className="size-3.5" />} onClick={() => void download(`/projects/${project.slug}/export`, { fallbackName: `${project.slug}-project.aibi` }).catch(toast.error)} title="Settings, skills, data sources (without credentials) and pages">
            Export project
          </Button>
          <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={() => setOpen(true)}>
            Edit
          </Button>
        </div>
      </div>
      <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-[13px]">
        <dt className="text-muted">Name</dt>
        <dd>{project.name}</dd>
        <dt className="text-muted">Slug</dt>
        <dd className="font-mono">{project.slug}</dd>
        <dt className="text-muted">Description</dt>
        <dd className="whitespace-pre-wrap">{project.description || <span className="text-muted">none</span>}</dd>
      </dl>
      <EditProjectDialog project={project} open={open} onClose={() => setOpen(false)} onSaved={(s) => s !== project.slug && nav(`/p/${s}/admin?tab=settings`, { replace: true })} />
    </Card>
  );
}

function DangerZone({ project }: { project: ProjectDetail }) {
  const me = useMe();
  const actions = useProjectActions();
  const nav = useNavigate();
  const [del, setDel] = useState(false);
  if (!me.data?.user.isPlatformAdmin) {
    return <p className="text-[13px] text-muted">Only a platform administrator can archive or delete this project.</p>;
  }
  return (
    <Card className="border-danger/40 p-5">
      <div className="mb-3 font-semibold text-danger">Danger zone</div>
      <div className="flex flex-col divide-y divide-line">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
          <div>
            <div className="font-medium">Archive project</div>
            <div className="text-[13px] text-muted">Hide it from all members. Everything is kept and it can be restored from the Projects page.</div>
          </div>
          <Button icon={<Archive className="size-4" />} onClick={() => actions.archive(project)}>
            Archive
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 pt-3">
          <div>
            <div className="font-medium">Delete project</div>
            <div className="text-[13px] text-muted">Remove the project and all its pages, data sources and history for good.</div>
          </div>
          <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setDel(true)}>
            Delete permanently
          </Button>
        </div>
      </div>
      <DeleteProjectDialog project={project} open={del} onClose={() => setDel(false)} onDeleted={() => nav("/", { replace: true })} />
    </Card>
  );
}

/* ───────── usage, logs ───────── */

function Usage({ slug }: { slug: string }) {
  const u = useQuery({ queryKey: ["usage", slug], queryFn: () => api<{ month: Record<string, number>; budgets: Record<string, number>; byDay: { day: string; tokens: number; cost: number; calls: number }[]; byUser: { email: string | null; tokens: number; cost: number }[]; pages: number }>(`/projects/${slug}/usage`) });
  if (u.isLoading || !u.data) return <PageLoader />;
  const m = u.data.month;
  const max = Math.max(1, ...u.data.byDay.map((d) => d.tokens));
  const tiles = [
    ["AI tokens this month", m.aiTokens.toLocaleString(), u.data.budgets.monthlyTokenBudget ? `of ${u.data.budgets.monthlyTokenBudget.toLocaleString()}` : ""],
    ["AI cost this month", `$${m.aiCost.toFixed(3)}`, u.data.budgets.monthlyCostBudget ? `of $${u.data.budgets.monthlyCostBudget}` : ""],
    ["Queries this month", m.queries.toLocaleString(), `${m.queryErrors} errors · avg ${m.avgQueryMs} ms`],
    ["Pages", String(u.data.pages), ""],
  ];
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map(([l, v, s]) => (
          <Card key={l} className="p-4">
            <div className="text-xs text-muted">{l}</div>
            <div className="mt-1 text-2xl font-semibold">{v}</div>
            {s && <div className="text-xs text-muted">{s}</div>}
          </Card>
        ))}
      </div>
      <Card className="p-4">
        <div className="mb-3 text-[13px] font-semibold">AI tokens per day (30 days)</div>
        <div className="flex h-32 items-end gap-1">
          {u.data.byDay.map((d) => (
            <div key={d.day} className="flex-1 rounded-t bg-accent/70" style={{ height: `${(d.tokens / max) * 100}%` }} title={`${d.day}: ${d.tokens.toLocaleString()} tokens, $${d.cost.toFixed(3)}`} />
          ))}
          {!u.data.byDay.length && <div className="w-full text-center text-[13px] text-muted">No AI usage yet</div>}
        </div>
      </Card>
      <Table head={["User", "Tokens", "Cost"]}>
        {u.data.byUser.map((x) => (
          <tr key={x.email ?? "?"}>
            <td className="px-3 py-1.5">{x.email}</td>
            <td className="px-3 py-1.5">{x.tokens.toLocaleString()}</td>
            <td className="px-3 py-1.5">${x.cost.toFixed(3)}</td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

function QueryLog({ slug }: { slug: string }) {
  const [status, setStatus] = useState("");
  const q = useQuery({ queryKey: ["query-log", slug, status], queryFn: () => api<{ id: number; kind: string; source: string; request: unknown; ms: number; rows: number; status: string; error: string | null; at: string; user: string }[]>(`/projects/${slug}/query-log?limit=300${status ? `&status=${status}` : ""}`) });
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <Select className="w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All queries</option>
          <option value="error">Errors</option>
          <option value="truncated">Truncated</option>
          <option value="cached">Cached</option>
        </Select>
        <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={() => void q.refetch()}>Refresh</Button>
      </div>
      <Table head={["When", "User", "Source", "Kind", "Status", "Rows", "ms", "Request"]}>
        {(q.data ?? []).map((r) => (
          <tr key={r.id}>
            <td className="px-3 py-1.5 whitespace-nowrap text-muted">{timeAgo(r.at)}</td>
            <td className="px-3 py-1.5">{r.user}</td>
            <td className="px-3 py-1.5"><code className="text-xs">{r.source}</code></td>
            <td className="px-3 py-1.5 text-muted">{r.kind}</td>
            <td className="px-3 py-1.5"><Badge tone={r.status === "error" ? "danger" : r.status === "truncated" ? "warning" : "neutral"}>{r.status}</Badge></td>
            <td className="px-3 py-1.5">{r.rows}</td>
            <td className="px-3 py-1.5">{r.ms}</td>
            <td className="max-w-md px-3 py-1.5">
              <div className="truncate font-mono text-[11px] text-muted" title={JSON.stringify(r.request)}>{r.error ?? JSON.stringify(r.request)}</div>
            </td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

function Audit({ slug }: { slug: string }) {
  const q = useQuery({ queryKey: ["audit", slug], queryFn: () => api<{ id: number; action: string; target: string | null; targetName: string | null; detail: unknown; at: string; actor: string | null }[]>(`/projects/${slug}/audit?limit=300`) });
  return (
    <Table head={["When", "Who", "Action", "Target", "Detail"]}>
      {(q.data ?? []).map((a) => (
        <tr key={a.id}>
          <td className="px-3 py-1.5 whitespace-nowrap text-muted">{new Date(a.at).toLocaleString()}</td>
          <td className="px-3 py-1.5">{a.actor}</td>
          <td className="px-3 py-1.5"><Badge>{a.action}</Badge></td>
          <td className="px-3 py-1.5">
            {a.targetName && a.targetName !== a.target ? (
              <span title={a.target ?? undefined}>{a.targetName}</span>
            ) : (
              <span className="font-mono text-xs">{a.target}</span>
            )}
          </td>
          <td className="max-w-md px-3 py-1.5"><div className="truncate font-mono text-[11px] text-muted">{a.detail ? JSON.stringify(a.detail) : ""}</div></td>
        </tr>
      ))}
    </Table>
  );
}

/* ───────── local AI ───────── */

function LocalAi({ slug }: { slug: string }) {
  const cfg = useConfig();
  const [samples, setSamples] = useState(false);
  const mcp = `${cfg.data?.apiUrl ?? location.origin}/mcp`;
  const claudeCmd = `claude mcp add --transport http aibi ${mcp} --header "Authorization: Bearer <your token>"`;
  const copy = (t: string) => void navigator.clipboard.writeText(t).then(() => toast.success("Copied"));
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card className="p-5">
        <div className="mb-1 flex items-center gap-2 font-semibold"><Download className="size-4 text-accent" /> Authoring kit</div>
        <p className="text-[13px] text-muted">A folder for your own AI tool (Claude Code, Cursor, a local model): rules, page schema, widget catalogue, annotated schemas of this project's data sources and the <code>aibi.mjs</code> CLI to validate, preview, pack and push pages. No credentials are included.</p>
        <label className="mt-3 flex items-center gap-2 text-[13px]">
          <Toggle checked={samples} onChange={setSamples} /> Include 3 sample rows per table (real data)
        </label>
        <Button className="mt-4" variant="primary" icon={<Download className="size-4" />} onClick={() => void download(`/projects/${slug}/authoring-kit${samples ? "?samples=1" : ""}`).catch(toast.error)}>
          Download kit
        </Button>
      </Card>
      <Card className="p-5">
        <div className="mb-1 flex items-center gap-2 font-semibold"><Plug className="size-4 text-accent" /> MCP endpoint</div>
        <p className="text-[13px] text-muted">Local agents can call the same tools the built-in AI uses (schema, read-only previews, validation, import). Create an external access key with the <code>mcp</code> scope (and <code>page:import</code> to save pages) under Platform admin → External access keys, then connect:</p>
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-surface2 p-2.5 font-mono text-[11.5px] break-all">
          <span className="flex-1">{claudeCmd}</span>
          <button onClick={() => copy(claudeCmd)} aria-label="Copy command" className="text-muted hover:text-ink"><Copy className="size-4" /></button>
        </div>
        <div className="mt-2 text-xs text-muted">Endpoint: <code>{mcp}</code></div>
      </Card>
      <Card className="p-5 lg:col-span-2">
        <div className="mb-2 font-semibold">How a locally built page reaches the project</div>
        <ol className="list-decimal space-y-1 pl-5 text-[13px] text-muted">
          <li>Download the kit and open it in your AI tool; ask for the page you need.</li>
          <li>Run <code>node aibi.mjs validate .</code> (offline) and <code>node aibi.mjs preview .</code> (live, read-only) until clean.</li>
          <li><code>node aibi.mjs pack .</code> creates an .aibi package — import it on the Import page — or <code>node aibi.mjs push .</code> saves it directly.</li>
          <li>The imported page is a normal page: live data, versions, sharing, the built-in AI can keep editing it.</li>
        </ol>
      </Card>
    </div>
  );
}
