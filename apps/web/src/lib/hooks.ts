import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import type { RuntimeConfig } from "@aibi/runtime-api/protocol";
import { api, type AppConfig, type Me, type ProjectSummary } from "./api";

export function useConfig() {
  return useQuery({ queryKey: ["config"], queryFn: () => api<AppConfig>("/config"), staleTime: 60_000 });
}

export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/auth/me"), retry: false, staleTime: 30_000 });
}

export interface ProjectDetail {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  role: "admin" | "builder" | "viewer";
  settings: Record<string, unknown>;
  /** whether AI can be used here: the server's provider works and the project admin has not turned it off */
  ai: { available: boolean; enabled: boolean; reason?: "not-configured" | "invalid-key" | "unreachable" | "disabled"; message: string };
}

export function useProject() {
  const { slug } = useParams();
  const q = useQuery({ queryKey: ["project", slug], queryFn: () => api<ProjectDetail>(`/projects/${slug}`), enabled: !!slug });
  return { slug: slug!, ...q };
}

export function useRuntimeConfig(slug: string) {
  return useQuery({ queryKey: ["runtime-config", slug], queryFn: () => api<RuntimeConfig>(`/projects/${slug}/runtime-config`), staleTime: 60_000 });
}

export const canBuild = (role?: ProjectSummary["role"]) => role === "builder" || role === "admin";
export const isAdmin = (role?: ProjectSummary["role"]) => role === "admin";

export function timeAgo(iso?: string | null) {
  if (!iso) return "";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}
