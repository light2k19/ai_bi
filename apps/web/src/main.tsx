import { StrictMode, Suspense, lazy, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import { AppLayout, useColorMode } from "./components/Layout";
import { ConfirmHost, PageLoader, Toasts } from "./components/ui";
import { useConfig, useMe } from "./lib/hooks";
import { ApiError } from "./lib/api";
import { Login, Setup } from "./pages/Login";
import { Projects } from "./pages/Projects";
import { ProjectHome } from "./pages/ProjectHome";
import { PageView } from "./pages/PageView";
import { Render } from "./pages/Render";

const Editor = lazy(() => import("./editor/Editor").then((m) => ({ default: m.Editor })));
const ImportWizard = lazy(() => import("./pages/Import").then((m) => ({ default: m.ImportWizard })));
import { ProjectGate } from "./components/ProjectGate";
const ProjectImport = lazy(() => import("./pages/ProjectImport").then((m) => ({ default: m.ProjectImport })));
const ProjectAdmin = lazy(() => import("./admin/ProjectAdmin").then((m) => ({ default: m.ProjectAdmin })));
const PlatformAdmin = lazy(() => import("./admin/PlatformAdmin").then((m) => ({ default: m.PlatformAdmin })));
const MyAccount = lazy(() => import("./pages/Account").then((m) => ({ default: m.MyAccount })));

const qc = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2 },
  },
});

function RequireAuth({ children }: { children: ReactNode }) {
  const cfg = useConfig();
  const me = useMe();
  const loc = useLocation();
  if (cfg.isLoading || me.isLoading) return <PageLoader />;
  if (cfg.data?.needsSetup) return <Navigate to="/setup" replace />;
  if (me.error instanceof ApiError && me.error.status === 401) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (me.error) return <div className="p-8 text-danger">{(me.error as Error).message}</div>;
  return <>{children}</>;
}

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PageLoader />}>{children}</Suspense>;
}

function ThemeRoot({ children }: { children: ReactNode }) {
  useColorMode();
  return <>{children}</>;
}

const router = createBrowserRouter([
  { path: "/login", element: <Login /> },
  { path: "/setup", element: <Setup /> },
  { path: "/render", element: <Render /> },
  {
    path: "/",
    element: (
      <RequireAuth>
        <AppLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <Projects /> },
      { path: "account", element: <Lazy><MyAccount /></Lazy> },
      { path: "admin", element: <Lazy><PlatformAdmin /></Lazy> },
      { path: "projects/import", element: <Lazy><ProjectImport /></Lazy> },
      {
        path: "p/:slug",
        element: <ProjectGate />,
        children: [
          { index: true, element: <ProjectHome /> },
          { path: "pages/:pageId", element: <PageView /> },
          { path: "pages/:pageId/edit", element: <Lazy><Editor kind="server" /></Lazy> },
          { path: "new", element: <Lazy><Editor kind="new" /></Lazy> },
          { path: "local/:localId", element: <Lazy><Editor kind="local" /></Lazy> },
          { path: "import", element: <Lazy><ImportWizard /></Lazy> },
          { path: "admin", element: <Lazy><ProjectAdmin /></Lazy> },
        ],
      },
      { path: "*", element: <div className="p-10 text-center text-muted">Page not found</div> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <ThemeRoot>
        <RouterProvider router={router} />
        <Toasts />
        <ConfirmHost />
      </ThemeRoot>
    </QueryClientProvider>
  </StrictMode>,
);
