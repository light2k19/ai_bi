/** Edit, archive, restore and permanently delete projects (shared by the project list and project settings). */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Button, ErrorBox, Field, Input, Modal, Textarea, confirmDialog, toast } from "../components/ui";

export interface ProjectRef {
  slug: string;
  name: string;
  description: string | null;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** Refresh every cached view that shows project names or lists. */
async function refreshProjects(qc: ReturnType<typeof useQueryClient>, slug?: string) {
  await qc.invalidateQueries({ queryKey: ["me"] });
  await qc.invalidateQueries({ queryKey: ["archived-projects"] });
  if (slug) await qc.invalidateQueries({ queryKey: ["project", slug] });
}

export function EditProjectDialog({ project, open, onClose, onSaved }: { project: ProjectRef; open: boolean; onClose: () => void; onSaved?: (slug: string) => void }) {
  const [f, setF] = useState({ name: project.name, slug: project.slug, description: project.description ?? "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const qc = useQueryClient();
  useEffect(() => {
    if (open) {
      setF({ name: project.name, slug: project.slug, description: project.description ?? "" });
      setError(null);
    }
  }, [open, project.name, project.slug, project.description]);
  const slugChanged = f.slug !== project.slug;
  const slugOk = SLUG_RE.test(f.slug);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ slug: string }>(`/projects/${project.slug}`, { method: "PATCH", body: { name: f.name.trim(), slug: f.slug, description: f.description.trim() || null } });
      await refreshProjects(qc, project.slug);
      toast.success("Project saved");
      onClose();
      onSaved?.(r.slug);
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
      title="Edit project"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save} disabled={!f.name.trim() || !slugOk}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <Field label="Name">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus maxLength={100} />
        </Field>
        <Field
          label="Slug"
          hint={
            !slugOk ? (
              <span className="text-danger">2–41 lower-case letters, digits and dashes, starting with a letter or digit</span>
            ) : slugChanged ? (
              <span className="text-warning">Links and bookmarks that use /p/{project.slug} will stop working. Access tokens and packages are not affected.</span>
            ) : (
              "Used in URLs"
            )
          }
        >
          <Input value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase() })} />
        </Field>
        <Field label="Description">
          <Textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

export function DeleteProjectDialog({ project, open, onClose, onDeleted }: { project: ProjectRef & { pages?: number; sources?: number; members?: number }; open: boolean; onClose: () => void; onDeleted?: () => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const qc = useQueryClient();
  useEffect(() => {
    if (open) {
      setTyped("");
      setError(null);
    }
  }, [open]);
  const del = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ pages: number; sources: number; files: number }>(`/projects/${project.slug}/delete`, { body: { confirm: typed } });
      await refreshProjects(qc);
      qc.removeQueries({ queryKey: ["project", project.slug] });
      toast.success(`Deleted ${project.name}: ${r.pages} page${r.pages === 1 ? "" : "s"}, ${r.sources} data source${r.sources === 1 ? "" : "s"}`);
      onClose();
      onDeleted?.();
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
      title={`Delete ${project.name} permanently?`}
      width="max-w-md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={busy} onClick={del} disabled={typed !== project.slug}>
            Delete permanently
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <p className="text-muted">
          This removes the project with all its pages and versions, data sources and their saved schemas, members, skill settings, packages, imports, AI sessions and query log. It cannot be undone. The audit log keeps a record of the deletion.
        </p>
        {project.pages !== undefined && (
          <p className="text-[13px]">
            {project.pages} page{project.pages === 1 ? "" : "s"} · {project.sources} data source{project.sources === 1 ? "" : "s"} · {project.members} member{project.members === 1 ? "" : "s"}
          </p>
        )}
        <Field label={`Type ${project.slug} to confirm`}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus placeholder={project.slug} />
        </Field>
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

/** Archive hides the project from everyone; a platform administrator can restore it. */
export function useProjectActions() {
  const qc = useQueryClient();
  const nav = useNavigate();
  return {
    archive: async (p: ProjectRef, after?: () => void) => {
      if (!(await confirmDialog(`Archive ${p.name}?`, "The project disappears for all members. Pages, data sources and settings are kept, and a platform administrator can restore it from the Projects page.", true))) return;
      try {
        await api(`/projects/${p.slug}`, { method: "DELETE" });
        await refreshProjects(qc);
        qc.removeQueries({ queryKey: ["project", p.slug] });
        toast.success(`${p.name} archived`);
        if (after) after();
        else nav("/");
      } catch (e) {
        toast.error(e);
      }
    },
    restore: async (p: ProjectRef) => {
      try {
        await api(`/projects/${p.slug}/restore`, { body: {} });
        await refreshProjects(qc);
        toast.success(`${p.name} restored`);
      } catch (e) {
        toast.error(e);
      }
    },
  };
}
