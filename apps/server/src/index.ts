import { config } from "./config";
import { migrate, closeDb, UpgradeError } from "./db";
import { loadSkills } from "./skills/registry";
import { personalizeStoredLogins } from "./services/sources";
import { sweepImports } from "./services/packages";
import { sweepCommentary } from "./ai/ask";
import { buildApp, buildRuntimeServer } from "./app";

try {
  migrate({ log: (m) => console.log(`[aibi] ${m}`) });
} catch (e) {
  console.error(`[aibi] cannot start: ${(e as Error).message}`);
  process.exit(e instanceof UpgradeError ? 3 : 1);
}
await loadSkills();
personalizeStoredLogins((m) => console.log(`[aibi] ${m}`));
const swept = sweepImports();
if (swept) console.log(`[aibi] removed ${swept} stale upload(s)`);
setInterval(() => {
  sweepImports();
  sweepCommentary();
}, 3600_000).unref();

const app = await buildApp({ logger: process.env.AIBI_LOG === "1" });
await app.listen({ port: config.port, host: config.host });
console.log(`[aibi] API listening on http://${config.host}:${config.port}`);
console.log(`[aibi] web origin ${config.webOrigin}, runtime origin ${config.runtimeOrigin}`);
console.log(`[aibi] AI: ${config.ai.model} via ${config.ai.baseUrl} (${config.ai.apiKey ? "key set" : "no key"}, tool mode ${config.ai.toolMode})`);

const rt = await buildRuntimeServer();
if (rt) {
  await rt.listen({ port: config.runtimePort, host: config.host });
  console.log(`[aibi] page runtime listening on http://${config.host}:${config.runtimePort}`);
}

const shutdown = async () => {
  await app.close();
  await rt?.close();
  closeDb();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
