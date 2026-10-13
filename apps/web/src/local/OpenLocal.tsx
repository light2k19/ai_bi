import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ClipboardPaste, FileUp, FolderOpen, HardDrive } from "lucide-react";
import { PageBundle } from "@aibi/page-spec";
import { Button, ErrorBox, Modal, Textarea, cx } from "../components/ui";
import { draftFromFiles, draftFromText, filesFromDataTransfer, fsAccessSupported, pickDirectory, pickFile, filesFromHandle, type LoadedDraft } from "../lib/local-files";
import { localDb, newLocalId, requestPersistence } from "../lib/local-db";

/** Store a loaded draft as a browser-local page and open it in the editor. */
export async function saveLoadedDraft(slug: string, d: LoadedDraft, handle?: FileSystemHandle): Promise<string> {
  const parsed = PageBundle.safeParse(d.bundle);
  if (!parsed.success) throw new Error(`Not a valid page: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  await requestPersistence();
  const id = newLocalId();
  const now = new Date().toISOString();
  await localDb.pages.put({ id, projectSlug: slug, title: parsed.data.page.title, bundle: parsed.data, origin: d.manifest ? "imported" : "local", fileName: d.fileName, createdAt: now, updatedAt: now });
  for (const [name, m] of Object.entries(d.localModules)) {
    const size = Object.values(m.files).reduce((s, x) => s + x.length, 0);
    await localDb.modules.put({ key: `${name}@${m.version}`, name, version: m.version, entry: m.entry, files: m.files, size, addedAt: now });
  }
  if (handle) await localDb.handles.put({ id, kind: handle.kind === "directory" ? "dir" : "file", name: handle.name, handle });
  return id;
}

export function OpenLocalDialog({ slug, open, onClose }: { slug: string; open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [paste, setPaste] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const finish = async (load: () => Promise<{ d: LoadedDraft; handle?: FileSystemHandle }>) => {
    setBusy(true);
    setError(null);
    try {
      const { d, handle } = await load();
      const id = await saveLoadedDraft(slug, d, handle);
      onClose();
      nav(`/p/${slug}/local/${id}`);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Open a page from your computer" width="max-w-xl">
      <div className="flex flex-col gap-4">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const dt = e.dataTransfer;
            void finish(async () => ({ d: await draftFromFiles(await filesFromDataTransfer(dt)) }));
          }}
          className={cx("flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition", over ? "border-accent bg-accent-soft" : "border-line")}
        >
          <FileUp className="size-7 text-accent" />
          <div className="font-medium">Drop an .aibi package, page.json, or a page folder</div>
          <div className="text-[13px] text-muted">Component (.tsx) and script (.js) files can be dropped together with page.json.</div>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            <Button size="sm" onClick={() => input.current?.click()} loading={busy}>
              Choose files
            </Button>
            <Button size="sm" onClick={() => dirInput.current?.click()}>
              Choose folder
            </Button>
          </div>
          <input
            ref={input}
            type="file"
            multiple
            accept=".aibi,.zip,.json,.tsx,.jsx,.js,.mjs"
            className="hidden"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])].map((f) => ({ path: f.name, file: f }));
              e.target.value = "";
              void finish(async () => ({ d: await draftFromFiles(files) }));
            }}
          />
          <input
            ref={dirInput}
            type="file"
            className="hidden"
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            onChange={(e) => {
              const files = [...(e.target.files ?? [])].map((f) => ({ path: (f as File & { webkitRelativePath: string }).webkitRelativePath.split("/").slice(1).join("/") || f.name, file: f }));
              e.target.value = "";
              void finish(async () => ({ d: await draftFromFiles(files) }));
            }}
          />
        </div>

        {fsAccessSupported() && (
          <div className="rounded-xl border border-line p-4">
            <div className="flex items-center gap-2 font-medium">
              <HardDrive className="size-4 text-accent" /> Edit locally, see it live
            </div>
            <p className="mt-1 text-[13px] text-muted">Open a file or folder with your editor or local AI. The page reloads whenever the files change on disk.</p>
            <div className="mt-3 flex gap-2">
              <Button
                size="sm"
                icon={<FileUp className="size-4" />}
                onClick={() =>
                  void finish(async () => {
                    const h = await pickFile();
                    const { files } = await filesFromHandle(h);
                    return { d: await draftFromFiles(files), handle: h };
                  })
                }
              >
                Open file…
              </Button>
              <Button
                size="sm"
                icon={<FolderOpen className="size-4" />}
                onClick={() =>
                  void finish(async () => {
                    const h = await pickDirectory();
                    const { files } = await filesFromHandle(h);
                    return { d: await draftFromFiles(files), handle: h };
                  })
                }
              >
                Open folder…
              </Button>
            </div>
          </div>
        )}

        <div className="rounded-xl border border-line p-4">
          <div className="flex items-center gap-2 font-medium">
            <ClipboardPaste className="size-4 text-accent" /> Paste JSON
          </div>
          <Textarea rows={4} className="mt-2 font-mono text-xs" placeholder='{"page": {...}} or a page definition' value={paste} onChange={(e) => setPaste(e.target.value)} />
          <div className="mt-2 flex justify-end">
            <Button size="sm" disabled={!paste.trim()} onClick={() => void finish(async () => ({ d: draftFromText(paste) }))}>
              Open pasted page
            </Button>
          </div>
        </div>
        <ErrorBox error={error} />
        <p className="text-xs text-muted">Local pages are stored only in this browser. Use “Save to project” in the editor to share them.</p>
      </div>
    </Modal>
  );
}
