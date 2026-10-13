/**
 * Opens a project only when the user's own logins for its data sources work. A missing or failing login is
 * asked for in the same "Your login" dialog as everywhere else, one data source at a time; the check is
 * repeated when it is older than 15 minutes or after sign-in/sign-out. Cancel returns to the project list.
 */
import { useRef } from "react";
import { Link, Outlet, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, KeyRound } from "lucide-react";
import { api } from "../lib/api";
import { useProject } from "../lib/hooks";
import { ErrorBox, PageLoader } from "./ui";
import { Container } from "./Layout";
import { MyLoginDialog, type LoginField } from "./SourceLogin";

interface GateSource {
  sourceId: string;
  alias: string;
  name: string;
  skill: string;
  fields: LoginField[];
  systemLogin: boolean;
  systemLoginSupported: boolean;
  set: boolean;
  ok: boolean;
  message: string;
}

export const gateKey = (slug: string) => ["source-gate", slug] as const;

export function ProjectGate() {
  const { slug } = useParams();
  const nav = useNavigate();
  const project = useProject();
  // set when the dialog just saved a login, so its close is not taken for a cancel
  const justSaved = useRef(false);
  const gate = useQuery({
    queryKey: gateKey(slug!),
    queryFn: () => api<{ ok: boolean; sources: GateSource[] }>(`/projects/${slug}/my-credentials/check`, { body: {} }),
    staleTime: 15 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  if (gate.isLoading) return <PageLoader />;
  if (gate.error) return <Container><ErrorBox error={gate.error} /></Container>;
  if (!gate.data || gate.data.ok) return <Outlet />;

  const pending = gate.data.sources.filter((s) => !s.ok);
  const next = pending[0];
  const item = { sourceId: next.sourceId, alias: next.alias, name: next.name, skill: next.skill, fields: next.fields, systemLogin: next.systemLogin, systemLoginSupported: next.systemLoginSupported, values: {}, set: next.set, status: next.set ? "error" : null, statusMessage: next.message, updatedAt: null };
  const reason = next.set ? `Your saved login no longer works: ${next.message}` : `Sign in to ${next.name} to open ${project.data?.name ?? "the project"}${pending.length > 1 ? ` (${pending.length} data sources need a login)` : ""}.`;
  return (
    <Container>
      <Link to="/" className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="size-3.5" /> Projects
      </Link>
      <div className="flex items-center gap-2 text-muted">
        <KeyRound className="size-4" /> {project.data?.name ?? "Project"}: sign in to its data sources to continue.
      </div>
      <MyLoginDialog
        key={next.sourceId}
        slug={slug!}
        item={item}
        open
        onClose={() => {
          if (!justSaved.current) nav("/");
        }}
        onSaved={() => {
          justSaved.current = true;
          void gate.refetch().finally(() => {
            justSaved.current = false;
          });
        }}
        reason={reason}
        saveLabel="Sign in"
      />
    </Container>
  );
}
