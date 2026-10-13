import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const api = process.env.AIBI_API_PROXY ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: [root] },
    proxy: { "/api": { target: api, changeOrigin: false }, "/mcp": { target: api } },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 4000 },
});
