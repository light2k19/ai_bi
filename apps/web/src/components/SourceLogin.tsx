/** Per-user sign-in for data sources: each member enters their own login; it is saved only after a successful test. */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, KeyRound, LogIn, XCircle } from "lucide-react";
import { api } from "../lib/api";
import { Button, Card, ErrorBox, Field, Input, Modal, Table, confirmDialog, toast } from "./ui";

export interface LoginField {
  key: string;
  title: string;
  description?: string;
  secret: boolean;
}
export interface MyLogin {
  sourceId: string;
  alias: string;
  name: string;
  skill: string;
  fields: LoginField[];
  values: Record<string, unknown>;
  set: boolean;
  status: string | null;
  statusMessage: string | null;
  updatedAt: string | null;
  /** admins turned on automatic sign-in with the AI BI account */
  systemLogin?: boolean;
  /** the source has login name and password fields, so an AI BI account can be tried */
  systemLoginSupported?: boolean;
}

export const useMyLogins = (slug: string) => useQuery({ queryKey: ["my-credentials", slug], queryFn: () => api<MyLogin[]>(`/projects/${slug}/my-credentials`), staleTime: 30_000 });

/** Inputs for login fields; secrets start empty ("leave empty to keep" when one is stored). */
export function LoginFields({ fields, values, onChange, keepHint }: { fields: LoginField[]; values: Record<string, string>; onChange: (v: Record<string, string>) => void; keepHint?: boolean }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.map((f) => (
        <Field key={f.key} label={f.title} hint={f.description}>
          <Input
            type={f.secret ? "password" : "text"}
            autoComplete={f.secret ? "new-password" : "off"}
            value={values[f.key] ?? ""}
            placeholder={keepHint ? "leave empty to keep" : ""}
            onChange={(e) => onChange({ ...values, [f.key]: e.target.value })}
          />
        </Field>
      ))}
    </div>
  );
}

export function MyLoginDialog({ slug, item, open, onClose, onSaved, reason, saveLabel }: { slug: string; item: MyLogin | null; open: boolean; onClose: () => void; onSaved?: () => void; reason?: string; saveLabel?: string }) {
  const qc = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const [password, setPassword] = useState("");
  const [useSystem, setUseSystem] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (open && item) {
      setPassword("");
      setUseSystem(false);
      // nothing is prefilled: an empty field keeps the stored value
      setValues({});
      setError(null);
    }
  }, [open, item]);
  if (!item) return null;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ""));
      const r = useSystem
        ? await api<{ ok: boolean; saved: boolean; message: string }>(`/projects/${slug}/sources/${item.sourceId}/my-credentials/system`, { method: "PUT", body: { password } })
        : await api<{ ok: boolean; saved: boolean; message: string }>(`/projects/${slug}/sources/${item.sourceId}/my-credentials`, { method: "PUT", body: { values: body } });
      if (!r.saved) {
        setError(`Not saved: the connection test failed. ${r.message}`);
        return;
      }
      toast.success(`Signed in to ${item.name}: ${r.message}`);
      await qc.invalidateQueries({ queryKey: ["my-credentials", slug] });
      // saved first, then closed: a caller that treats close as "cancel" must not see a success as one
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Your login for ${item.name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<LogIn className="size-4" />} loading={busy} onClick={save}>
            {saveLabel ?? "Test and save"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        {reason && (
          <p className="flex items-start gap-1.5 rounded-lg bg-warning/10 px-3 py-2 text-[13px]">
            <XCircle className="mt-0.5 size-4 shrink-0 text-warning" /> {reason}
          </p>
        )}
        <p className="text-[13px] text-muted">
          <code>{item.alias}</code> uses each member's own account, so you see the data your account may see.
        </p>
        {item.systemLoginSupported && (
          <label className="flex items-start gap-2.5 rounded-xl border border-line p-4 text-[13px]">
            <input type="checkbox" className="mt-0.5" checked={useSystem} onChange={(e) => setUseSystem(e.target.checked)} />
            <span>
              <span className="font-medium">Sign in with my AI BI account</span>
              <span className="block text-muted">Same login id and password as AI BI: the login id is tried as your full e-mail, then as the part before the @. Your AI BI password is checked first, then the connection is tested.</span>
            </span>
          </label>
        )}
        <div className="rounded-xl border border-accent/40 bg-accent-soft/30 p-4">
          <div className="mb-1 text-[13px] font-semibold">Your login (personal)</div>
          <p className="mb-3 text-[12.5px] text-muted">Used only for your own queries, tested before it is saved, and never shown to anyone.{item.set ? " Leave empty to keep your current login." : ""}</p>
          {useSystem ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Your AI BI password">
                <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
            </div>
          ) : (
            <LoginFields fields={item.fields} values={values} onChange={setValues} keepHint={item.set} />
          )}
        </div>
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

/** Card listing the per-user data sources of a project with the current user's sign-in state. */
export function MyLoginsCard({ slug, onChanged }: { slug: string; onChanged?: () => void }) {
  const q = useMyLogins(slug);
  const qc = useQueryClient();
  const [open, setOpen] = useState<MyLogin | null>(null);
  const [expanded, setExpanded] = useState(false);
  if (!q.data?.length) return null;
  const attention = q.data.filter((s) => !(s.set && s.status === "ok"));
  // all signed in: one quiet line with a Manage link; the full card only when something needs attention
  if (!attention.length && !expanded) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-muted">
        <CheckCircle2 className="size-3.5 text-success" />
        Signed in to {q.data.map((s) => s.alias).join(", ")} with your own account.
        <button className="text-accent hover:underline" onClick={() => setExpanded(true)}>
          Manage
        </button>
      </div>
    );
  }
  return (
    <Card className="p-5">
      <div className="mb-1 flex items-center justify-between gap-2 font-semibold">
        <span className="flex items-center gap-2"><KeyRound className="size-4 text-accent" /> Your data source accounts</span>
        {!attention.length && (
          <button className="text-[13px] font-normal text-muted hover:text-ink" onClick={() => setExpanded(false)}>
            Hide
          </button>
        )}
      </div>
      <p className="mb-3 text-[13px] text-muted">These data sources use each member's own login, so different people can see different data.</p>
      <div className="flex flex-col divide-y divide-line">
        {q.data.map((s) => (
          <div key={s.sourceId} className="flex flex-wrap items-center gap-3 py-2.5">
            {s.set && s.status === "ok" ? <CheckCircle2 className="size-4 text-success" /> : <XCircle className={s.set ? "size-4 text-danger" : "size-4 text-warning"} />}
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {s.name} <code className="rounded bg-surface2 px-1.5 text-xs">{s.alias}</code>
              </div>
              <div className="text-xs text-muted">
                {s.set ? `Signed in${s.values[s.fields.find((f) => !f.secret)?.key ?? ""] ? ` as ${s.values[s.fields.find((f) => !f.secret)!.key]}` : ""} · ${s.statusMessage ?? ""}` : "Not signed in: pages using this source cannot load its data for you"}
              </div>
            </div>
            <Button size="sm" variant={s.set ? "secondary" : "primary"} icon={<LogIn className="size-3.5" />} onClick={() => setOpen(s)}>
              {s.set ? "Change" : "Sign in"}
            </Button>
            {s.set && (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  if (!(await confirmDialog("Remove your login", `Remove your saved login for ${s.name}? Pages using it will ask you to sign in again.`, true))) return;
                  await api(`/projects/${slug}/sources/${s.sourceId}/my-credentials`, { method: "DELETE" }).catch(toast.error);
                  await qc.invalidateQueries({ queryKey: ["my-credentials", slug] });
                  onChanged?.();
                }}
              >
                Remove
              </Button>
            )}
          </div>
        ))}
      </div>
      <MyLoginDialog slug={slug} item={open} open={!!open} onClose={() => setOpen(null)} onSaved={onChanged} />
    </Card>
  );
}

/** Banner for a page whose data sources need the viewer's own login. */
export function SignInBanner({ slug, aliases, onSignedIn }: { slug: string; aliases: string[]; onSignedIn: () => void }) {
  const q = useMyLogins(slug);
  const [open, setOpen] = useState<MyLogin | null>(null);
  const missing = (q.data ?? []).filter((s) => aliases.includes(s.alias) && !(s.set && s.status !== "error"));
  if (!missing.length) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-[13px]">
      <KeyRound className="size-4 text-warning" />
      <div className="flex-1">
        This page reads {missing.map((m) => m.name).join(", ")} with each user's own account. Sign in to see your data.
      </div>
      {missing.map((m) => (
        <Button key={m.sourceId} size="sm" variant="primary" icon={<LogIn className="size-3.5" />} onClick={() => setOpen(m)}>
          Sign in to {m.alias}
        </Button>
      ))}
      <MyLoginDialog slug={slug} item={open} open={!!open} onClose={() => setOpen(null)} onSaved={onSignedIn} />
    </div>
  );
}

/** Admin view: who has signed in to a per-user data source (never the values). */
export function SignInStatusDialog({ slug, source, open, onClose }: { slug: string; source: { id: string; name: string } | null; open: boolean; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["source-credentials", slug, source?.id],
    queryFn: () => api<{ userId: string; login: string; email: string | null; name: string | null; role: string; set: boolean; status: string | null; statusMessage: string | null; updatedAt: string | null }[]>(`/projects/${slug}/sources/${source!.id}/credentials`),
    enabled: open && !!source,
  });
  if (!source) return null;
  return (
    <Modal open={open} onClose={onClose} title={`Who has signed in to ${source.name}`} width="max-w-2xl">
      <p className="mb-3 text-[13px] text-muted">Each member signs in with their own account. Logins are never shown; you can remove one, for example when someone leaves.</p>
      <Table head={["Member", "Role", "Signed in", ""]}>
        {(q.data ?? []).map((m) => (
          <tr key={m.userId}>
            <td className="px-3 py-2">
              <div className="font-medium">{m.name ?? m.login}</div>
              <div className="text-xs text-muted">{m.login}{m.email && m.email !== m.login ? ` · ${m.email}` : ""}</div>
            </td>
            <td className="px-3 py-2 text-muted">{m.role}</td>
            <td className="px-3 py-2">
              {m.set ? (
                <span className="flex items-center gap-1.5">
                  {m.status === "ok" ? <CheckCircle2 className="size-4 text-success" /> : <XCircle className="size-4 text-danger" />}
                  {m.updatedAt ? new Date(m.updatedAt).toLocaleDateString() : "yes"}
                </span>
              ) : (
                <span className="text-muted">no</span>
              )}
            </td>
            <td className="px-3 py-2 text-right">
              {m.set && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  onClick={async () => {
                    if (!(await confirmDialog("Remove login", `Remove the saved login of ${m.name ?? m.login}? They will be asked to sign in again.`, true))) return;
                    await api(`/projects/${slug}/sources/${source.id}/credentials/${m.userId}`, { method: "DELETE" }).catch(toast.error);
                    void q.refetch();
                  }}
                >
                  Remove
                </Button>
              )}
            </td>
          </tr>
        ))}
      </Table>
    </Modal>
  );
}
