import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Download, FileUp, FolderKanban, LogOut, MoreHorizontal, Pencil, Plus, Settings2, Trash2 } from "lucide-react";
import { api, download, type ProjectSummary } from "../lib/api";
import { DeleteProjectDialog, EditProjectDialog, useProjectActions } from "../admin/ProjectLifecycle";
import { useMe } from "../lib/hooks";
import { Badge, Button, Card, EmptyState, ErrorBox, Field, IconButton, Input, Menu, MenuItem, Modal, PageLoader, Table, Textarea, confirmDialog, toast } from "../components/ui";
import { gateKey } from "../components/ProjectGate";
import { Container } from "../components/Layout";

export function Projects() {
  const me = useMe();
  const [open, setOpen] = useState(false);
  if (me.isLoading) return <PageLoader />;
  const projects = me.data?.projects ?? [];
  const platformAdmin = !!me.data?.user.isPlatformAdmin;
  return (
    <Container>
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Projects</h1>
          <p className="mt-1 text-muted">Each project has its own data sources, skills, members and pages.</p>
        </div>
        {me.data?.user.isPlatformAdmin && (
          <div className="flex gap-2">
            <Link to="/projects/import">
              <Button icon={<FileUp className="size-4" />}>Import project</Button>
            </Link>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
              New project
            </Button>
          </div>
        )}
      </div>
      {projects.length === 0 ? (
        <EmptyState icon={<FolderKanban className="size-8" />} title="No projects yet" text="Ask a platform administrator to add you to a project." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} platformAdmin={platformAdmin} />
          ))}
        </div>
      )}
      {platformAdmin && <ArchivedProjects />}
      <NewProject open={open} onClose={() => setOpen(false)} />
    </Container>
  );
}

function ProjectCard({ project: p, platformAdmin }: { project: ProjectSummary; platformAdmin: boolean }) {
  const nav = useNavigate();
  const actions = useProjectActions();
  const [edit, setEdit] = useState(false);
  const [del, setDel] = useState(false);
  const qc = useQueryClient();
  const canEdit = platformAdmin || p.role === "admin";
  const showMenu = canEdit || p.dataSourceLogins > 0;
  const signOut = async () => {
    if (!(await confirmDialog(`Sign out of ${p.name}?`, "Your saved logins for this project's data sources are removed. You will be asked to sign in again when you open the project.", true))) return;
    try {
      const r = await api<{ removed: number }>(`/projects/${p.slug}/my-credentials`, { method: "DELETE" });
      await qc.invalidateQueries({ queryKey: gateKey(p.slug) });
      await qc.invalidateQueries({ queryKey: ["my-credentials", p.slug] });
      await qc.invalidateQueries({ queryKey: ["me"] });
      toast.success(r.removed ? `Signed out of ${r.removed} data source${r.removed === 1 ? "" : "s"}` : "No saved logins to remove");
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="relative h-full">
      <Link to={`/p/${p.slug}`} className="block h-full">
        <Card className="h-full p-5 transition hover:border-accent/50 hover:shadow-md">
          <div className="flex items-start justify-between gap-3">
            <div className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent">
              <FolderKanban className="size-5" />
            </div>
            <div className={showMenu ? "mr-9" : ""}>{p.role && <Badge tone={p.role === "admin" ? "accent" : "neutral"}>{p.role}</Badge>}</div>
          </div>
          <div className="mt-4 font-semibold">{p.name}</div>
          <div className="mt-1 line-clamp-2 text-[13px] text-muted">{p.description || p.slug}</div>
        </Card>
      </Link>
      {showMenu && (
      <div className="absolute top-4 right-4">
        <Menu trigger={(t) => <IconButton label={`Actions for ${p.name}`} onClick={t}><MoreHorizontal className="size-4" /></IconButton>}>
          {(close) => (
            <>
              {p.dataSourceLogins > 0 && <MenuItem icon={<LogOut />} onClick={() => (close(), void signOut())}>Sign out of data sources</MenuItem>}
              {canEdit && (
                <>
                  {p.dataSourceLogins > 0 && <div className="my-1 border-t border-line" />}
                  <MenuItem icon={<Pencil />} onClick={() => (close(), setEdit(true))}>Edit name, slug, description</MenuItem>
                  <MenuItem icon={<Settings2 />} onClick={() => (close(), nav(`/p/${p.slug}/admin?tab=settings`))}>Project settings</MenuItem>
                  <MenuItem icon={<Download />} onClick={() => (close(), void download(`/projects/${p.slug}/export`, { fallbackName: `${p.slug}-project.aibi` }).catch(toast.error))}>Export project (.aibi)</MenuItem>
                </>
              )}
              {platformAdmin && (
                <>
                  <div className="my-1 border-t border-line" />
                  <MenuItem icon={<Archive />} onClick={() => (close(), void actions.archive(p, () => undefined))}>Archive</MenuItem>
                  <MenuItem icon={<Trash2 />} danger onClick={() => (close(), setDel(true))}>Delete permanently</MenuItem>
                </>
              )}
            </>
          )}
        </Menu>
      </div>
      )}
      <EditProjectDialog project={p} open={edit} onClose={() => setEdit(false)} />
      <DeleteProjectDialog project={p} open={del} onClose={() => setDel(false)} />
    </div>
  );
}

interface ArchivedProject {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  createdAt: string;
  pages: number;
  sources: number;
  members: number;
}

function ArchivedProjects() {
  const q = useQuery({ queryKey: ["archived-projects"], queryFn: () => api<ArchivedProject[]>("/projects/archived") });
  const actions = useProjectActions();
  const [del, setDel] = useState<ArchivedProject | null>(null);
  if (!q.data?.length) return null;
  return (
    <section className="mt-10">
      <h2 className="mb-1 font-semibold">Archived projects</h2>
      <p className="mb-3 text-[13px] text-muted">Hidden from members. Restore a project to make it available again, or delete it for good.</p>
      <Table head={["Project", "Slug", "Pages", "Data sources", "Members", ""]}>
        {q.data.map((p) => (
          <tr key={p.id}>
            <td className="px-3 py-2 font-medium">{p.name}</td>
            <td className="px-3 py-2 font-mono">{p.slug}</td>
            <td className="px-3 py-2">{p.pages}</td>
            <td className="px-3 py-2">{p.sources}</td>
            <td className="px-3 py-2">{p.members}</td>
            <td className="px-3 py-2 text-right whitespace-nowrap">
              <Button size="sm" icon={<ArchiveRestore className="size-3.5" />} onClick={() => actions.restore(p)}>Restore</Button>{" "}
              <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={() => setDel(p)}>Delete</Button>
            </td>
          </tr>
        ))}
      </Table>
      {del && <DeleteProjectDialog project={del} open={!!del} onClose={() => setDel(null)} />}
    </section>
  );
}

function NewProject({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [f, setF] = useState({ name: "", slug: "", description: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const qc = useQueryClient();
  const nav = useNavigate();
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/projects", { body: f });
      await qc.invalidateQueries({ queryKey: ["me"] });
      onClose();
      nav(`/p/${f.slug}/admin`);
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
      title="New project"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={submit} disabled={!f.name || !f.slug}>
            Create
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <Field label="Name">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, slug: f.slug || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") })} autoFocus />
        </Field>
        <Field label="Slug" hint="Used in URLs: lower-case letters, digits and dashes">
          <Input value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value })} />
        </Field>
        <Field label="Description">
          <Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}
