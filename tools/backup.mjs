/**
 * Back up everything AI BI stores: the metadata database (consistent copy, safe while the app runs), the
 * encryption key, uploaded skills, vendored modules, gallery packages, imports and local SQLite data.
 *
 *   npm run backup [targetDir]        default: <data>/backups/<timestamp>
 *
 * Restore: stop the app, replace the data directory with the backup folder's contents (keep `.secret`:
 * without it stored data source logins and secrets cannot be decrypted), start the app.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(root, process.env.AIBI_DATA_DIR ?? "data");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const target = path.resolve(process.argv[2] ?? path.join(dataDir, "backups", stamp));
if (!fs.existsSync(path.join(dataDir, "aibi.db"))) {
  console.error(`no database at ${dataDir}`);
  process.exit(1);
}
fs.mkdirSync(target, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, "aibi.db"), { readOnly: true });
db.exec(`VACUUM INTO '${path.join(target, "aibi.db").replace(/\\/g, "/").replace(/'/g, "''")}'`);
db.close();
let files = 1;
let bytes = fs.statSync(path.join(target, "aibi.db")).size;
const copyDir = (name) => {
  const src = path.join(dataDir, name);
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, path.join(target, name), { recursive: true });
  for (const f of fs.readdirSync(src, { recursive: true, withFileTypes: true })) {
    if (f.isFile()) {
      files++;
      bytes += fs.statSync(path.join(f.parentPath ?? f.path, f.name)).size;
    }
  }
};
if (fs.existsSync(path.join(dataDir, ".secret"))) {
  fs.copyFileSync(path.join(dataDir, ".secret"), path.join(target, ".secret"));
  files++;
}
for (const d of ["packages", "modules", "skills", "sqlite", "imports"]) copyDir(d);
fs.writeFileSync(path.join(target, "BACKUP.json"), JSON.stringify({ createdAt: new Date().toISOString(), dataDir, files, bytes, restore: "Stop the app, copy these files over the data directory (including .secret), start the app." }, null, 2));
console.log(`backup written to ${target}: ${files} files, ${(bytes / 1e6).toFixed(1)} MB`);
