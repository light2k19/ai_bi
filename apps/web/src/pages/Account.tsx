import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useMe } from "../lib/hooks";
import { Badge, Button, Card, ErrorBox, Field, Input, toast } from "../components/ui";
import { Container } from "../components/Layout";

/** The signed-in user's own account: display name for everyone, password for form users. */
export function MyAccount() {
  const me = useMe();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [nameErr, setNameErr] = useState<unknown>(null);
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    if (me.data) setName(me.data.user.displayName ?? "");
  }, [me.data]);
  const u = me.data?.user;
  const ad = u?.authProvider === "ldap";
  return (
    <Container className="max-w-xl">
      <h1 className="mb-6 text-xl font-semibold">My account</h1>
      <Card className="mb-5 p-5">
        <div className="mb-3 flex items-center gap-2 text-[13px] text-muted">
          <span className="font-mono">{u?.login}</span>
          {u?.email && u.email !== u.login && <span>· {u.email}</span>}
          <Badge>{ad ? "AD user" : u?.authProvider === "local" ? "form user" : "single sign-on"}</Badge>
        </div>
        <form
          className="flex flex-col gap-3.5"
          onSubmit={async (e) => {
            e.preventDefault();
            setNameErr(null);
            try {
              await api("/me/profile", { body: { name: name.trim() } });
              await qc.invalidateQueries({ queryKey: ["me"] });
              toast.success("Name saved");
            } catch (error) {
              setNameErr(error);
            }
          }}
        >
          <Field label="Display name" hint="Shown on pages, in member lists and in the audit log">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          </Field>
          <ErrorBox error={nameErr} />
          <div>
            <Button type="submit" disabled={!name.trim() || name.trim() === (u?.displayName ?? "")}>Save name</Button>
          </div>
        </form>
      </Card>
      <Card className="p-5">
        <div className="mb-3 font-semibold">Password</div>
        {ad ? (
          <p className="text-[13px] text-muted">You sign in with your Active Directory account; change its password in Windows or ask your IT administrator.</p>
        ) : u?.authProvider !== "local" ? (
          <p className="text-[13px] text-muted">You sign in with single sign-on; there is no password to change here.</p>
        ) : (
          <form
            className="flex flex-col gap-3.5"
            onSubmit={async (e) => {
              e.preventDefault();
              setErr(null);
              if (pw.next !== pw.confirm) return setErr(new Error("The new passwords do not match"));
              try {
                await api("/me/password", { body: { current: pw.current, next: pw.next } });
                setPw({ current: "", next: "", confirm: "" });
                toast.success("Password changed");
              } catch (error) {
                setErr(error);
              }
            }}
          >
            <Field label="Current password">
              <Input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" required />
            </Field>
            <Field label="New password" hint="At least 8 characters">
              <Input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} minLength={8} autoComplete="new-password" required />
            </Field>
            <Field label="Repeat new password">
              <Input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} minLength={8} autoComplete="new-password" required />
            </Field>
            <ErrorBox error={err} />
            <div>
              <Button type="submit" variant="primary" disabled={!pw.current || pw.next.length < 8 || !pw.confirm}>Change password</Button>
            </div>
          </form>
        )}
      </Card>
    </Container>
  );
}
