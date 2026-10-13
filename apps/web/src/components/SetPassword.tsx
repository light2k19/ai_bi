import { useState } from "react";
import { api } from "../lib/api";
import { Button, ErrorBox, Field, Input, Modal, toast } from "./ui";

/** An admin sets a new password for a form user who forgot theirs; the user's sessions are signed out. */
export function SetPasswordDialog({ open, onClose, path, who }: { open: boolean; onClose: () => void; path: string; who: string }) {
  const [pw, setPw] = useState({ next: "", confirm: "" });
  const [err, setErr] = useState<unknown>(null);
  const close = () => {
    setPw({ next: "", confirm: "" });
    setErr(null);
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={close}
      title={`Set a new password for ${who}`}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            disabled={pw.next.length < 8 || pw.next !== pw.confirm}
            onClick={async () => {
              setErr(null);
              try {
                await api(path, { method: "POST", body: { password: pw.next } });
                toast.success(`Password set for ${who}; they are signed out everywhere`);
                close();
              } catch (e) {
                setErr(e);
              }
            }}
          >
            Set password
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <p className="text-[13px] text-muted">Tell the user the new password through a safe channel; they can change it themselves afterwards from the account menu.</p>
        <Field label="New password" hint="At least 8 characters">
          <Input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" autoFocus />
        </Field>
        <Field label="Repeat new password">
          <Input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} autoComplete="new-password" />
        </Field>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}
