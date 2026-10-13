import type { ThemeTokens } from "@aibi/runtime-api";
import type { PageDefinition } from "@aibi/page-spec";

const FALLBACK = {
  light: { bg: "#f6f7f9", surface: "#ffffff", surface2: "#f1f3f6", border: "#e3e6ec", text: "#151a23", muted: "#5f6b7a", accent: "#2f6fed", success: "#1f9d61", warning: "#d98b0b", danger: "#d64545" },
  dark: { bg: "#0f1218", surface: "#171b23", surface2: "#1e2430", border: "#2a3140", text: "#e8ecf2", muted: "#9aa5b5", accent: "#5b8cff", success: "#3cc287", warning: "#f0a92e", danger: "#f06a6a" },
  palette: ["#2f6fed", "#1fb5a8", "#f0a92e", "#e2577a", "#7c5cdb", "#4caf50", "#ff7a45", "#8c9db5"],
};

export function resolveMode(colorMode: "auto" | "light" | "dark", page?: PageDefinition): "light" | "dark" {
  const m = page?.theme?.mode && page.theme.mode !== "auto" ? page.theme.mode : colorMode;
  if (m === "light" || m === "dark") return m;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function buildTheme(themeCaps: Record<string, unknown>, mode: "light" | "dark", page?: PageDefinition): ThemeTokens {
  const base = { ...FALLBACK[mode], ...((themeCaps[mode] as Record<string, string>) ?? {}) };
  const overrides = page?.theme?.overrides ?? {};
  for (const [k, v] of Object.entries(overrides)) {
    const key = k.replace(/^--/, "");
    if (key in base) (base as Record<string, string>)[key] = v;
  }
  const palette = page?.theme?.palette ?? (themeCaps.palette as string[] | undefined) ?? FALLBACK.palette;
  return {
    mode,
    ...base,
    palette,
    fontFamily: "Inter, 'Segoe UI', system-ui, -apple-system, sans-serif",
    radius: 12,
  };
}

export function applyTheme(t: ThemeTokens) {
  const r = document.documentElement;
  const set = (k: string, v: string) => r.style.setProperty(k, v);
  set("--bg", t.bg);
  set("--surface", t.surface);
  set("--surface2", t.surface2);
  set("--border", t.border);
  set("--text", t.text);
  set("--muted", t.muted);
  set("--accent", t.accent);
  set("--success", t.success);
  set("--warning", t.warning);
  set("--danger", t.danger);
  set("--font", t.fontFamily);
  set("--radius", `${t.radius}px`);
  t.palette.forEach((c, i) => set(`--palette-${i}`, c));
  r.dataset.theme = t.mode;
  r.style.colorScheme = t.mode;
}
