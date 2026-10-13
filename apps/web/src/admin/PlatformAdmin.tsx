import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, Pencil, Plus, Trash2, Upload, ShieldCheck } from "lucide-react";
import { EditNameDialog } from "../components/EditName";
import { SetPasswordDialog } from "../components/SetPassword";
import { api, upload } from "../lib/api";
import { useConfig, useMe, timeAgo } from "../lib/hooks";
import { loginHint, useLoginCheck } from "../lib/useLoginCheck";
import { Badge, Button, Card, ErrorBox, Field, Input, Modal, PageLoader, Table, Tabs, Toggle, confirmDialog, cx, toast } from "../components/ui";
import { Container } from "../components/Layout";
import { SchemaForm } from "./SchemaForm";
import { AccessKeysTab } from "./AccessKeys";
import type { JsonSchema } from "@aibi/page-spec";

type Tab = "users" | "skills" | "auth" | "keys";

export function PlatformAdmin() {
  const me = useMe();
  const [tab, setTab] = useState<Tab>("users");
  if (!me.data?.user.isPlatformAdmin) return <Container><ErrorBox error="Platform administrators only" /></Container>;
  return (
    <Container>
      <h1 className="text-xl font-semibold">Platform administration</h1>
      <Tabs<Tab> className="mt-4 mb-5" value={tab} onChange={setTab} tabs={[{ id: "users", label: "Users" }, { id: "skills", label: "Skill registry" }, { id: "auth", label: "Sign-in" }, { id: "keys", label: "External access keys" }]} />
      {tab === "users" && <UsersTab />}
      {tab === "skills" && <SkillsTab />}
      {tab === "auth" && <AuthTab />}
      {tab === "keys" && <AccessKeysTab />}
    </Container>
  );
}

function UsersTab() {
  const users = useQuery({ queryKey: ["users"], queryFn: () => api<{ id: string; login: string; email: string | null; name: string | null; provider: string; isPlatformAdmin: boolean; disabled: boolean; lastLoginAt: string | null }[]>("/users") });
  const [add, setAdd] = useState(false);
  const [f, setF] = useState({ kind: "form" as "form" | "ad", login: "", email: "", name: "", password: "", isPlatformAdmin: false });
  const cfg = useConfig();
  const adEnabled = cfg.data?.providers.some((p) => p.id === "ldap") ?? false;
  const [error, setError] = useState<unknown>(null);
  const [pwFor, setPwFor] = useState<{ id: string; login: string; name: string | null } | null>(null);
  const [nameFor, setNameFor] = useState<{ id: string; login: string; name: string | null } | null>(null);
  const check = useLoginCheck(add ? f.login : "");
  const hint = loginHint(check.data, f.kind, "platform");
  const patch = async (id: string, body: Record<string, unknown>) => {
    await api(`/users/${id}`, { method: "PATCH", body }).catch(toast.error);
    void users.refetch();
  };
  const me = useMe();
  type Impact = { projects: { id: string; slug: string; name: string; role: string; enabled: boolean; pages: number }[]; tokens: number };
  const impact = (id: string) => api<Impact>(`/users/${id}/projects`);
  const describe = (i: Impact) => (i.projects.length ? i.projects.map((p) => `• ${p.name} (${p.role}${p.pages ? `, ${p.pages} page${p.pages === 1 ? "" : "s"} owned` : ""})`).join("\n") : "• no project memberships");
  /** disabling applies everywhere: say how many projects are affected first */
  const setActive = async (u: { id: string; login: string; name: string | null }, active: boolean) => {
    if (!active) {
      const i = await impact(u.id).catch((e) => (toast.error(e), null));
      if (!i) return;
      const n = i.projects.length;
      if (!(await confirmDialog(`Disable ${u.name ?? u.login}?`, `They are signed out and lose access to ${n === 0 ? "the platform" : `${n} project${n === 1 ? "" : "s"}`}${n ? ":\n" + describe(i) : "."}${i.tokens ? `\n\nTheir ${i.tokens} external access key${i.tokens === 1 ? "" : "s"} stop working too.` : ""}\n\nMemberships, roles and pages are kept; enabling the account restores everything.`, true))) return;
    }
    await patch(u.id, { disabled: !active });
  };
  /** removal is final: list every project first */
  const remove = async (u: { id: string; login: string; name: string | null }) => {
    const i = await impact(u.id).catch((e) => (toast.error(e), null));
    if (!i) return;
    const n = i.projects.length;
    if (!(await confirmDialog(`Remove ${u.name ?? u.login}?`, `The account is deleted and removed from ${n === 0 ? "every project (it belongs to none)" : `${n} project${n === 1 ? "" : "s"}`}${n ? ":\n" + describe(i) : "."}\n\nPages they own pass to you; their data source logins, external access keys and sessions are deleted. This cannot be undone.`, true))) return;
    try {
      await api(`/users/${u.id}`, { method: "DELETE" });
      toast.success(`Removed ${u.name ?? u.login}`);
      void users.refetch();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div>
      <div className="mb-3 flex justify-end">
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdd(true)}>New user</Button>
      </div>
      <Table head={["User", "Sign-in", "Platform admin", "Active", "Last sign-in", ""]}>
        {(users.data ?? []).map((u) => (
          <tr key={u.id}>
            <td className="px-3 py-2"><div className="font-medium">{u.name ?? u.login}</div><div className="text-xs text-muted">{u.login}{u.email && u.email !== u.login ? ` · ${u.email}` : ""}</div></td>
            <td className="px-3 py-2 text-muted">{u.provider}</td>
            <td className="px-3 py-2"><Toggle checked={u.isPlatformAdmin} onChange={(v) => void patch(u.id, { isPlatformAdmin: v })} /></td>
            <td className="px-3 py-2"><Toggle checked={!u.disabled} label={`${u.disabled ? "Enable" : "Disable"} ${u.login}`} onChange={(v) => void setActive(u, v)} /></td>
            <td className="px-3 py-2 text-muted">{u.lastLoginAt ? timeAgo(u.lastLoginAt) : "never"}</td>
            <td className="px-3 py-2 text-right whitespace-nowrap">
              <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setNameFor(u)}>
                Rename
              </Button>
              {u.provider === "local" && (
                <Button size="sm" variant="ghost" icon={<KeyRound className="size-3.5" />} onClick={() => setPwFor(u)}>
                  Set password
                </Button>
              )}
              {u.id !== me.data?.user.id && (
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} className="hover:text-danger" onClick={() => void remove(u)}>
                  Remove
                </Button>
              )}
            </td>
          </tr>
        ))}
      </Table>
      <SetPasswordDialog open={!!pwFor} onClose={() => setPwFor(null)} path={`/users/${pwFor?.id}/password`} who={pwFor?.name ?? pwFor?.login ?? ""} />
      {nameFor && <EditNameDialog key={nameFor.id} open onClose={() => setNameFor(null)} initial={nameFor.name} login={nameFor.login} onSave={async (name) => (await api(`/users/${nameFor.id}`, { method: "PATCH", body: { name } }), void users.refetch())} />}
      <Modal
        open={add}
        onClose={() => setAdd(false)}
        title="New user"
        footer={
          <>
            <Button onClick={() => setAdd(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!f.login.trim() || hint?.blocked || (f.kind === "form" && f.password.length < 8)}
              onClick={async () => {
                setError(null);
                try {
                  await api("/users", { body: f.kind === "ad" ? { kind: "ad", login: f.login, name: f.name || undefined, isPlatformAdmin: f.isPlatformAdmin } : { kind: "form", login: f.login, email: f.email || undefined, password: f.password || undefined, name: f.name || undefined, isPlatformAdmin: f.isPlatformAdmin } });
                  setAdd(false);
                  void users.refetch();
                } catch (e) {
                  setError(e);
                }
              }}
            >
              Create
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3.5">
          <Field label="User type">
            <div className="flex gap-4 text-[13px]">
              <label className="flex items-center gap-1.5"><input type="radio" checked={f.kind === "form"} onChange={() => setF({ ...f, kind: "form" })} /> Form user (login id and password)</label>
              <label className={cx("flex items-center gap-1.5", !adEnabled && "text-muted")} title={adEnabled ? undefined : "Enable Active Directory sign-in under Sign-in first"}>
                <input type="radio" disabled={!adEnabled} checked={f.kind === "ad"} onChange={() => setF({ ...f, kind: "ad" })} /> AD user (Windows user id)
              </label>
            </div>
          </Field>
          {f.kind === "ad" ? (
            <Field label="Windows user id" hint="e.g. jsmith — the email and name are read from Active Directory; the password stays there">
              <Input value={f.login} onChange={(e) => setF({ ...f, login: e.target.value })} />
              {hint && <div className={cx("mt-1 text-xs", hint.tone === "bad" ? "text-danger" : hint.tone === "warn" ? "text-warning" : "text-success")}>{hint.text}</div>}
            </Field>
          ) : (
            <>
              <Field label="Login id" hint="Any id without spaces; what the user types to sign in">
                <Input value={f.login} onChange={(e) => setF({ ...f, login: e.target.value })} />
                {hint && <div className={cx("mt-1 text-xs", hint.tone === "bad" ? "text-danger" : hint.tone === "warn" ? "text-warning" : "text-success")}>{hint.text}</div>}
              </Field>
              <Field label="Email (optional)"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            </>
          )}
          <Field label={f.kind === "ad" ? "Name (optional, overrides the directory)" : "Name"}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          {f.kind === "form" && <Field label="Password" hint="At least 8 characters; the user can change it later from the account menu"><Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" required /></Field>}
          <label className="flex items-center gap-2 text-[13px]"><Toggle checked={f.isPlatformAdmin} onChange={(v) => setF({ ...f, isPlatformAdmin: v })} /> Platform administrator</label>
          <ErrorBox error={error} />
        </div>
      </Modal>
    </div>
  );
}

function SkillsTab() {
  const skills = useQuery({ queryKey: ["skills"], queryFn: () => api<{ id: string; version: string; type: string; name: string; description: string; source: string; approved: boolean; scope: string; permissions: string[]; loadError?: string; projects?: { id: string; slug: string; name: string }[] }[]>("/skills") });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api<{ id: string; slug: string; name: string }[]>("/projects") });
  const [file, setFile] = useState<File | null>(null);
  const [assigning, setAssigning] = useState<{ id: string; name: string; projectIds: string[] } | null>(null);
  return (
    <div className="flex flex-col gap-5">
      <Card className="p-4">
        <div className="mb-1 font-semibold">Install a third-party skill</div>
        <p className="mb-3 text-[13px] text-muted">A .zip with skill.json at its root. Server code in a skill runs inside this server, so review it and its declared permissions before approving.</p>
        <div className="flex items-center gap-3">
          <input type="file" accept=".zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-[13px]" />
          <Button
            icon={<Upload className="size-4" />}
            disabled={!file}
            onClick={async () => {
              try {
                const r = await upload<{ id: string; version: string; permissions: string[] }>("/skills/upload", file!, file!.name);
                toast.success(`Installed ${r.id}@${r.version}; approve it to activate`);
                void skills.refetch();
              } catch (e) {
                toast.error(e);
              }
            }}
          >
            Upload
          </Button>
        </div>
      </Card>
      <Table head={["Skill", "Type", "Source", "Permissions", "Projects", "Status", ""]}>
        {(skills.data ?? []).map((s) => (
          <tr key={s.id}>
            <td className="px-3 py-2"><div className="font-medium">{s.name}</div><div className="text-xs text-muted">{s.id}@{s.version}</div></td>
            <td className="px-3 py-2 text-muted">{s.type}{s.scope === "system" ? " (system)" : ""}</td>
            <td className="px-3 py-2">{s.source === "builtin" ? <Badge>built-in</Badge> : <Badge tone="warning">uploaded</Badge>}</td>
            <td className="px-3 py-2 text-xs text-muted">{s.permissions.join(", ") || "—"}</td>
            <td className="px-3 py-2 text-xs text-muted">
              {s.source === "builtin" ? (
                s.scope === "system" ? "—" : "all"
              ) : (
                <button type="button" className="text-left text-accent hover:underline" onClick={() => setAssigning({ id: s.id, name: s.name, projectIds: (s.projects ?? []).map((p) => p.id) })}>
                  {s.projects?.length ? s.projects.map((p) => p.name).join(", ") : "none — assign"}
                </button>
              )}
            </td>
            <td className="px-3 py-2">{s.loadError ? <Badge tone="danger">error</Badge> : s.approved ? <Badge tone="success">active</Badge> : <Badge tone="warning">pending</Badge>}</td>
            <td className="px-3 py-2 text-right">
              {s.source === "uploaded" && (
                <Button
                  size="sm"
                  icon={<ShieldCheck className="size-3.5" />}
                  onClick={async () => {
                    await api(`/skills/${s.id}/approve`, { body: { version: s.version, approved: !s.approved } }).catch(toast.error);
                    void skills.refetch();
                  }}
                >
                  {s.approved ? "Revoke" : "Approve"}
                </Button>
              )}
            </td>
          </tr>
        ))}
      </Table>
      <Modal open={!!assigning} onClose={() => setAssigning(null)} title={assigning ? `Projects that may use ${assigning.name}` : ""}>
        {assigning && (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] text-muted">A third-party skill is only available in the projects you pick here; it is never shared with the others. Removing a project disables the pages that use its data sources of this skill.</p>
            <div className="flex flex-col gap-2">
              {(projects.data ?? []).map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={assigning.projectIds.includes(p.id)}
                    onChange={(e) => setAssigning({ ...assigning, projectIds: e.target.checked ? [...assigning.projectIds, p.id] : assigning.projectIds.filter((x) => x !== p.id) })}
                  />
                  {p.name} <span className="text-muted">({p.slug})</span>
                </label>
              ))}
              {!projects.data?.length && <div className="text-[13px] text-muted">No projects yet.</div>}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAssigning(null)}>Cancel</Button>
              <Button
                onClick={async () => {
                  try {
                    await api(`/skills/${assigning.id}/projects`, { method: "PUT", body: { projectIds: assigning.projectIds } });
                    toast.success("Project assignment saved");
                    setAssigning(null);
                    void skills.refetch();
                  } catch (e) {
                    toast.error(e);
                  }
                }}
              >
                Save
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function AuthTab() {
  const local = useQuery({ queryKey: ["system-skill", "auth-local"], queryFn: () => api<{ enabled: boolean }>("/system-skills/auth-local") });
  const oidc = useQuery({ queryKey: ["system-skill", "auth-oidc"], queryFn: () => api<{ enabled: boolean; settings: Record<string, unknown>; configSchema?: JsonSchema; secrets: string[] }>("/system-skills/auth-oidc") });
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  if (local.isLoading || oidc.isLoading) return <PageLoader />;
  const s = settings ?? oidc.data?.settings ?? {};
  const en = enabled ?? oidc.data?.enabled ?? false;
  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <Card className="flex items-center justify-between p-5">
        <div>
          <div className="font-semibold">Login id and password (form users)</div>
          <div className="text-[13px] text-muted">Accounts with a password stored here; users change it themselves from the account menu.</div>
        </div>
        <Toggle
          checked={local.data?.enabled ?? true}
          onChange={async (v) => {
            await api("/system-skills/auth-local", { method: "PUT", body: { enabled: v, settings: {} } }).catch(toast.error);
            void local.refetch();
          }}
        />
      </Card>
      <AdServer />
      <Card className="p-5">
        <div className="mb-1 flex items-center justify-between">
          <div className="font-semibold">Single sign-on (OpenID Connect)</div>
          <Toggle checked={en} onChange={setEnabled} />
        </div>
        <p className="mb-3 text-[13px] text-muted">Add providers such as Microsoft Entra ID (issuer https://login.microsoftonline.com/&lt;tenant&gt;/v2.0) or Google (https://accounts.google.com). Redirect URI: <code>{location.origin}/api/auth/oidc/&lt;id&gt;/callback</code></p>
        {oidc.data?.configSchema && <SchemaForm schema={oidc.data.configSchema} value={s} onChange={setSettings} secrets={oidc.data.secrets} />}
        <Button
          className="mt-4"
          variant="primary"
          onClick={async () => {
            try {
              await api("/system-skills/auth-oidc", { method: "PUT", body: { enabled: en, settings: s } });
              toast.success("Sign-in settings saved");
            } catch (e) {
              toast.error(e);
            }
          }}
        >
          Save
        </Button>
      </Card>
    </div>
  );
}

/* ───────── Active Directory ───────── */

function AdServer() {
  const q = useQuery({ queryKey: ["system-skill", "auth-ldap"], queryFn: () => api<{ enabled: boolean; settings: Record<string, unknown>; configSchema?: JsonSchema; secrets: string[]; loadError?: string }>("/system-skills/auth-ldap") });
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  if (q.isLoading) return <PageLoader />;
  if (q.error) return <ErrorBox error={q.error} />;
  const s = settings ?? q.data?.settings ?? {};
  const en = enabled ?? q.data?.enabled ?? false;
  return (
    <div className="flex flex-col gap-2">
      <Card className="p-5">
        <div className="mb-1 flex items-center justify-between gap-4">
          <div>
            <div className="font-semibold">Active Directory sign-in</div>
            <div className="text-[13px] text-muted">AD users sign in with their Windows user id and password; the directory checks the password, nothing is stored here.</div>
          </div>
          <Toggle checked={en} onChange={setEnabled} label="Enable Active Directory sign-in" />
        </div>
        {q.data?.loadError && <ErrorBox error={new Error(`The sign-in skill failed to load: ${q.data.loadError}`)} className="mt-3" />}
        <div className="mt-4">{q.data?.configSchema && <SchemaForm schema={q.data.configSchema} value={s} onChange={(v) => (setSettings(v), setResult(null))} secrets={q.data.secrets} />}</div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            onClick={async () => {
              try {
                await api("/system-skills/auth-ldap", { method: "PUT", body: { enabled: en, settings: s } });
                toast.success(en ? "Active Directory sign-in enabled" : "Active Directory settings saved");
                setSettings(null);
                setEnabled(null);
                void q.refetch();
              } catch (e) {
                toast.error(e);
              }
            }}
          >
            Save
          </Button>
          <Button
            loading={testing}
            onClick={async () => {
              setTesting(true);
              setResult(null);
              try {
                setResult(await api<{ ok: boolean; message: string }>("/system-skills/auth-ldap/test", { body: { settings: s } }));
              } catch (e) {
                setResult({ ok: false, message: (e as Error).message });
              } finally {
                setTesting(false);
              }
            }}
          >
            Test connection
          </Button>
          {result && <span className={result.ok ? "text-[13px] text-success" : "text-[13px] text-danger"}>{result.message}</span>}
        </div>
      </Card>
      <p className="text-[13px] text-muted">Project admins add AD users under Members → Add member → AD user, by Windows user id. Form users (login id and password set here) keep signing in as before and can change their own password from the account menu.</p>
    </div>
  );
}
