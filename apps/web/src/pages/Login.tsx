import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams, Navigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { api } from "../lib/api";
import { useConfig } from "../lib/hooks";
import { Button, Card, ErrorBox, Field, Input, PageLoader } from "../components/ui";
import { Logo } from "../components/Layout";

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-full place-items-center bg-bg px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Logo />
        </div>
        <Card className="p-6">
          <h1 className="text-lg font-semibold">{title}</h1>
          <p className="mt-1 text-[13px] text-muted">{subtitle}</p>
          <div className="mt-5">{children}</div>
        </Card>
        <p className="mt-6 text-center text-xs text-muted">Read-only analytics. Your data never leaves its source.</p>
      </div>
    </div>
  );
}

export function Login() {
  const cfg = useConfig();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const next = params.get("next") ?? "/";

  if (cfg.isLoading) return <PageLoader />;
  if (cfg.data?.needsSetup) return <Navigate to="/setup" replace />;
  const providers = cfg.data?.providers ?? [];
  const password_ = providers.some((p) => p.kind === "password");
  const ad = providers.some((p) => p.id === "ldap");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/auth/login", { body: { email, password } });
      await qc.invalidateQueries();
      nav(next.startsWith("/") ? next : "/");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="Sign in" subtitle="Analysis pages for your projects">
      {password_ && (
        <form onSubmit={submit} className="flex flex-col gap-3.5">
          <Field label={ad ? "Login id, email or Windows user id" : "Login id or email"}>
            <Input type="text" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </Field>
          <Field label="Password">
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <ErrorBox error={error} />
          <Button variant="primary" type="submit" loading={busy} className="mt-1">
            Sign in
          </Button>
        </form>
      )}
      {providers
        .filter((p) => p.kind === "redirect")
        .map((p) => (
          <a key={p.id} href={`/api/auth/oidc/${p.id}/start?returnTo=${encodeURIComponent(next)}`} className="mt-3 flex h-9 items-center justify-center gap-2 rounded-lg border border-line text-sm font-medium hover:bg-surface2">
            <KeyRound className="size-4" /> {p.label}
          </a>
        ))}
    </Shell>
  );
}

export function Setup() {
  const cfg = useConfig();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (cfg.isLoading) return <PageLoader />;
  if (!cfg.data?.needsSetup) return <Navigate to="/" replace />;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/auth/setup", { body: form });
      await qc.invalidateQueries();
      nav("/");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title="Welcome" subtitle="Create the first platform administrator account.">
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <Field label="Name">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Email">
          <Input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Password" hint="At least 8 characters">
          <Input type="password" required minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        <ErrorBox error={error} />
        <Button variant="primary" type="submit" loading={busy}>
          Create administrator
        </Button>
      </form>
    </Shell>
  );
}
