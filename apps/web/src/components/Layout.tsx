import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { BarChart3, ChevronDown, LogOut, Moon, Shield, Sun, Monitor, FolderKanban, UserRound } from "lucide-react";
import { api } from "../lib/api";
import { useMe } from "../lib/hooks";
import { Menu, MenuItem, cx } from "./ui";

export type ColorMode = "auto" | "light" | "dark";

function readMode(): ColorMode {
  try {
    return (localStorage.getItem("aibi.colorMode") as ColorMode) || "auto";
  } catch {
    return "auto";
  }
}

export function useColorMode(): [ColorMode, (m: ColorMode) => void] {
  const [mode, setMode] = useState<ColorMode>(readMode);
  useEffect(() => {
    const apply = () => {
      const dark = mode === "dark" || (mode === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    window.addEventListener("aibi-color-mode", apply);
    return () => {
      mq.removeEventListener("change", apply);
      window.removeEventListener("aibi-color-mode", apply);
    };
  }, [mode]);
  useEffect(() => {
    const h = () => setMode(readMode());
    window.addEventListener("aibi-color-mode", h);
    return () => window.removeEventListener("aibi-color-mode", h);
  }, []);
  return [
    mode,
    (m) => {
      try {
        localStorage.setItem("aibi.colorMode", m);
      } catch {
        /* storage blocked */
      }
      setMode(m);
      window.dispatchEvent(new Event("aibi-color-mode"));
    },
  ];
}

export function Logo() {
  return (
    <Link to="/" className="flex shrink-0 items-center gap-2 font-semibold tracking-tight whitespace-nowrap">
      <span className="grid size-7 place-items-center rounded-lg bg-accent text-white">
        <BarChart3 className="size-4" />
      </span>
      <span>AI BI</span>
    </Link>
  );
}

export function AppLayout() {
  const me = useMe();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { slug } = useParams();
  const [mode, setMode] = useColorMode();
  const project = me.data?.projects.find((p) => p.slug === slug);

  const logout = async () => {
    await api("/auth/logout", { method: "POST", body: {} });
    qc.clear();
    nav("/login");
  };

  return (
    // pinned to the viewport (not 100vh, which can round past it under browser zoom and add a document scrollbar)
    <div className="fixed inset-0 flex flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-4 px-4">
          <Logo />
          {me.data && (
            <Menu
              align="left"
              trigger={(toggle) => (
                <button onClick={toggle} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] text-muted hover:bg-surface2 hover:text-ink">
                  <FolderKanban className="size-4" />
                  <span className="max-w-48 truncate font-medium text-ink">{project?.name ?? "Projects"}</span>
                  <ChevronDown className="size-3.5" />
                </button>
              )}
            >
              {(close) => (
                <>
                  {me.data.projects.map((p) => (
                    <MenuItem key={p.id} onClick={() => (close(), nav(`/p/${p.slug}`))}>
                      <span className="flex-1 truncate">{p.name}</span>
                      <span className="text-xs text-muted">{p.role}</span>
                    </MenuItem>
                  ))}
                  <div className="my-1 border-t border-line" />
                  <MenuItem onClick={() => (close(), nav("/"))}>All projects</MenuItem>
                </>
              )}
            </Menu>
          )}
          {project && (
            <nav className="hidden items-center gap-1 md:flex">
              <TopLink to={`/p/${project.slug}`} end>
                Pages
              </TopLink>
              {(project.role === "builder" || project.role === "admin") && <TopLink to={`/p/${project.slug}/import`}>Import</TopLink>}
              {project.role === "admin" && <TopLink to={`/p/${project.slug}/admin`}>Admin</TopLink>}
            </nav>
          )}
          <div className="ml-auto flex items-center gap-1">
            <button
              className="grid size-8 place-items-center rounded-lg text-muted hover:bg-surface2 hover:text-ink"
              title={`Theme: ${mode}`}
              aria-label="Toggle theme"
              onClick={() => setMode(mode === "auto" ? "light" : mode === "light" ? "dark" : "auto")}
            >
              {mode === "auto" ? <Monitor className="size-4" /> : mode === "light" ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </button>
            {me.data && (
              <Menu
                trigger={(toggle) => (
                  <button onClick={toggle} className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-surface2">
                    <span className="grid size-7 place-items-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent">{(me.data.user.displayName ?? me.data.user.login).slice(0, 1).toUpperCase()}</span>
                    <ChevronDown className="size-3.5 text-muted" />
                  </button>
                )}
              >
                {(close) => (
                  <>
                    <div className="px-2.5 py-2 text-xs text-muted">{me.data.user.login}{me.data.user.email && me.data.user.email !== me.data.user.login ? ` · ${me.data.user.email}` : ""}</div>
                    <MenuItem icon={<UserRound />} onClick={() => (close(), nav("/account"))}>
                      My account{me.data.user.authProvider === "local" ? " and password" : ""}
                    </MenuItem>
                    {me.data.user.isPlatformAdmin && (
                      <MenuItem icon={<Shield />} onClick={() => (close(), nav("/admin"))}>
                        Platform admin
                      </MenuItem>
                    )}
                    <MenuItem icon={<LogOut />} onClick={() => (close(), void logout())}>
                      Sign out
                    </MenuItem>
                  </>
                )}
              </Menu>
            )}
          </div>
        </div>
      </header>
      {/* the shell owns the viewport height: pages scroll inside main, so there is only ever one scrollbar */}
      <main className="min-h-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}

function TopLink({ to, children, end }: { to: string; children: ReactNode; end?: boolean }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => cx("rounded-lg px-3 py-1.5 text-[13px] font-medium", isActive ? "bg-surface2 text-ink" : "text-muted hover:text-ink")}>
      {children}
    </NavLink>
  );
}

export function Container({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("mx-auto w-full max-w-[1600px] px-4 py-6", className)}>{children}</div>;
}
