import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export interface LoginCheck {
  exists: boolean;
  login?: string;
  name?: string | null;
  kind?: "form" | "ad" | "sso";
}

/** Whether a login id is already taken, while the admin types it (same check the server applies on save). */
export function useLoginCheck(login: string) {
  const id = login.trim();
  return useQuery({ queryKey: ["login-check", id.toLowerCase()], queryFn: () => api<LoginCheck>(`/users/check?login=${encodeURIComponent(id)}`), enabled: id.length >= 2, staleTime: 10_000, retry: false });
}

/** The line shown under the login id field, and whether saving must be blocked. */
export function loginHint(check: LoginCheck | undefined, kind: "form" | "ad", context: "project" | "platform"): { text: string; blocked: boolean; tone: "ok" | "warn" | "bad" } | null {
  if (!check?.exists) return check ? { text: "Login id is free", blocked: false, tone: "ok" } : null;
  const who = check.name ? `${check.name} (${check.login})` : check.login ?? "";
  if (check.kind !== kind) return { text: `Taken by ${check.kind === "ad" ? "an Active Directory" : check.kind === "sso" ? "a single sign-on" : "a form"} user: ${who}. Choose another id or add them as that kind.`, blocked: true, tone: "bad" };
  if (context === "platform") return { text: `${who} already exists`, blocked: true, tone: "bad" };
  return { text: `${who} already exists and will be added to this project`, blocked: false, tone: "warn" };
}
