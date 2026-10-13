import { useState } from "react";
import { Button, ErrorBox, Field, Input, Modal, toast } from "./ui";

/** Change a user's display name (an admin for a member, or the user for themselves). */
export function EditNameDialog({ open, onClose, initial, login, onSave }: { open: boolean; onClose: () => void; initial: string | null; login: string; onSave: (name: string) => Promise<unknown> }) {
  const [name, setName] = useState(initial ?? "");
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Name of ${login}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim() || name.trim() === (initial ?? "")}
            onClick={async () => {
              setErr(null);
              setBusy(true);
              try {
                await onSave(name.trim());
                toast.success("Name saved");
                onClose();
              } catch (e) {
                setErr(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <Field label="Display name" hint="Shown on pages, in member lists and in the audit log">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus />
        </Field>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}
