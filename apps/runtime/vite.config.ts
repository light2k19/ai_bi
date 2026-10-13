import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const api = process.env.AIBI_PUBLIC_API_URL ?? "http://localhost:8787";
const webOrigin = process.env.AIBI_WEB_ORIGIN ?? "http://localhost:5173";

// Dev CSP mirrors the production one set by the server for the runtime origin.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' blob: ${api}`,
  `connect-src 'self' blob: ws: ${api}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "frame-src https:",
  `frame-ancestors ${webOrigin} ${api}`,
].join("; ");

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true, fs: { allow: [root] }, headers: { "Content-Security-Policy": csp } },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 4000, sourcemap: false },
  define: { __AIBI_API__: JSON.stringify(api) },
});
