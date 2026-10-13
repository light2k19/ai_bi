import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { api, type Me } from "../lib/api";
import { useMe, timeAgo } from "../lib/hooks";
import { Badge, Button, ErrorBox, Field, Input, Modal, Select, Table, confirmDialog, toast } from "../components/ui";

interface Token {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  projectId: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revoked: boolean;
  createdAt: string;
}

const SCOPES = [
  { id: "query:read", label: "Run read-only queries (aibi preview, local AI)" },
  { id: "page:read", label: "Read pages (aibi pull)" },
  { id: "page:import", label: "Import pages as drafts (aibi push)" },
  { id: "mcp", label: "Use the MCP endpoint (Claude Code, Claude Desktop)" },
];

/* ───────── external access keys ───────── */

/** Admin projects: where the caller may issue a key (platform admins: every project). */
const adminProjects = (me: Me | undefined) => (me?.projects ?? []).filter((p) => me?.user.isPlatformAdmin || p.role === "admin");

/** Platform admin → External access keys: the admin's own keys for the CLI, local AI tools and MCP. */
export function AccessKeysTab() {
  const me = useMe();
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: () => api<Token[]>("/me/tokens") });
  const [create, setCreate] = useState(false);
  const canCreate = adminProjects(me.data).length > 0;
  return (
    <>
      <div className="mb-3 flex items-end justify-between">
        <div>
          <div className="font-semibold">External access keys</div>
          <div className="text-[13px] text-muted">Keys for the aibi CLI, local AI tools and the MCP endpoint, acting as you. Each key is limited to one project; only an admin of that project can issue one.</div>
        </div>
        {canCreate && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreate(true)}>New key</Button>}
      </div>
      {!canCreate && <p className="mb-3 text-[13px] text-muted">You are not an admin of any project, so you cannot issue keys.</p>}
      <Table head={["Name", "Project", "Scopes", "Expires", "Last used", ""]}>
        {(tokens.data ?? []).map((t) => (
          <tr key={t.id} className={t.revoked ? "opacity-50" : ""}>
            <td className="px-3 py-2">
              <div className="font-medium">{t.name}</div>
              <div className="font-mono text-xs text-muted">{t.prefix}…</div>
            </td>
            <td className="px-3 py-2 text-muted">{me.data?.projects.find((p) => p.id === t.projectId)?.name ?? "—"}</td>
            <td className="px-3 py-2">
              <div className="flex flex-wrap gap-1">{t.scopes.map((s) => <Badge key={s}>{s}</Badge>)}</div>
            </td>
            <td className="px-3 py-2 text-muted">{t.revoked ? "revoked" : t.expiresAt ? new Date(t.expiresAt).toLocaleDateString() : "never"}</td>
            <td className="px-3 py-2 text-muted">{t.lastUsedAt ? timeAgo(t.lastUsedAt) : "never"}</td>
            <td className="px-3 py-2 text-right">
              {!t.revoked && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 className="size-4" />}
                  onClick={async () => {
                    if (!(await confirmDialog("Revoke key", `Revoke “${t.name}”? Tools using it stop working immediately.`, true))) return;
                    await api(`/me/tokens/${t.id}`, { method: "DELETE" });
                    void tokens.refetch();
                  }}
                >
                  Revoke
                </Button>
              )}
            </td>
          </tr>
        ))}
        {!tokens.data?.length && (
          <tr>
            <td colSpan={6} className="px-3 py-6 text-center text-muted">No keys yet</td>
          </tr>
        )}
      </Table>
      <CreateToken open={create} onClose={() => (setCreate(false), void tokens.refetch())} />
    </>
  );
}

function CreateToken({ open, onClose }: { open: boolean; onClose: () => void }) {
  const me = useMe();
  const [f, setF] = useState({ name: "", project: "", scopes: ["query:read", "page:read"], days: 30 });
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const close = () => {
    setToken(null);
    setF({ name: "", project: "", scopes: ["query:read", "page:read"], days: 30 });
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={close}
      title={token ? "Your new key" : "New external access key"}
      footer={
        token ? (
          <Button variant="primary" onClick={close}>Done</Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!f.name || !f.project || !f.scopes.length}
              onClick={async () => {
                setError(null);
                try {
                  const r = await api<{ token: string }>("/me/tokens", { body: f });
                  setToken(r.token);
                } catch (e) {
                  setError(e);
                }
              }}
            >
              Create key
            </Button>
          </>
        )
      }
    >
      {token ? (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-muted">Copy it now. It is not shown again.</p>
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface2 p-2 font-mono text-xs break-all">
            <KeyRound className="size-4 shrink-0 text-accent" />
            <span className="flex-1">{token}</span>
            <button onClick={() => void navigator.clipboard.writeText(token).then(() => toast.success("Copied"))} aria-label="Copy key" className="text-muted hover:text-ink">
              <Copy className="size-4" />
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3.5">
          <Field label="Name">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Claude Code on my laptop" />
          </Field>
          <Field label="Project">
            <Select value={f.project} onChange={(e) => setF({ ...f, project: e.target.value })}>
              <option value="">Choose a project</option>
              {adminProjects(me.data).map((p) => <option key={p.id} value={p.slug}>{p.name}</option>)}
            </Select>
          </Field>
          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-medium">Scopes</span>
            {SCOPES.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" checked={f.scopes.includes(s.id)} onChange={(e) => setF({ ...f, scopes: e.target.checked ? [...f.scopes, s.id] : f.scopes.filter((x) => x !== s.id) })} />
                <code className="text-xs">{s.id}</code> <span className="text-muted">{s.label}</span>
              </label>
            ))}
          </div>
          <Field label="Expires in (days)">
            <Input type="number" min={1} max={365} value={f.days} onChange={(e) => setF({ ...f, days: Number(e.target.value) })} />
          </Field>
          <ErrorBox error={error} />
        </div>
      )}
    </Modal>
  );
}
