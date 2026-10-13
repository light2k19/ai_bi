/**
 * Development launcher: seeds the demo on first run, then starts the API (8787),
 * the web app (5173) and the sandboxed page runtime (5174) with prefixed logs.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const color = { api: "\x1b[36m", web: "\x1b[35m", runtime: "\x1b[33m" };

if (!fs.existsSync(path.join(root, "data", "aibi.db"))) {
  console.log("First run: seeding the demo project …");
  const r = spawnSync(npm, ["run", "seed"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
if (!fs.existsSync(path.join(root, "packages", "cli", "dist", "aibi.mjs"))) {
  spawnSync(npm, ["run", "build", "-w", "@aibi/cli"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
}

const procs = [];
function run(name, args) {
  const p = spawn(npm, args, { cwd: root, shell: process.platform === "win32", env: { ...process.env, FORCE_COLOR: "1" } });
  const prefix = `${color[name]}[${name}]\x1b[0m `;
  const pipe = (stream) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) if (l.trim()) process.stdout.write(prefix + l + "\n");
    });
  };
  pipe(p.stdout);
  pipe(p.stderr);
  p.on("exit", (code) => {
    console.log(`${prefix}exited with code ${code}`);
    shutdown();
  });
  procs.push(p);
}

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" });
    else p.kill("SIGTERM");
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

run("api", ["run", "dev", "-w", "@aibi/server"]);
run("runtime", ["run", "dev", "-w", "@aibi/runtime"]);
run("web", ["run", "dev", "-w", "@aibi/web"]);
console.log("\nOpen http://localhost:5173  (admin@example.com / admin1234)\n");
