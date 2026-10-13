/**
 * Turns a recording from record.mjs into a 1080p MP4: frames keep their real timing, the stretches where the
 * AI works are fast-forwarded to a few seconds, typing is slightly sped up, and the video fades in and out.
 *
 *   node tools/demo-video/build.mjs <framesDir> <out.mp4> [ffmpeg]
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const [dir, out, ffmpeg = process.env.FFMPEG ?? "ffmpeg"] = process.argv.slice(2);
if (!dir || !out) throw new Error("usage: build.mjs <framesDir> <out.mp4> [ffmpeg]");
const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
const m = meta.markers;
const frames = meta.frames.filter((f) => fs.existsSync(path.join(dir, f.file)));

/** [start, end, speed]: AI waits are squeezed to a target length, typing is a little quicker */
const target = { build1: 9, build2: 6, ask: 7 };
const segments = [];
for (const [name, secs] of Object.entries(target)) {
  const a = m[`${name}-start`], b = m[`${name}-end`];
  if (a && b && b - a > secs * 1000) segments.push([a, b, (b - a) / 1000 / secs]);
}
for (const name of ["type1", "type2"]) if (m[`${name}-start`] && m[`${name}-end`]) segments.push([m[`${name}-start`], m[`${name}-end`], 1.35]);
const speedAt = (t) => segments.find(([a, b]) => t >= a && t < b)?.[2] ?? 1;

const lines = ["ffconcat version 1.0"];
let total = 0;
for (let i = 0; i < frames.length; i++) {
  const f = frames[i];
  const next = frames[i + 1]?.t ?? m.end ?? f.t + 2000;
  const d = Math.max(0, next - f.t) / 1000 / speedAt(f.t);
  if (d <= 0) continue;
  lines.push(`file '${path.join(dir, f.file).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`, `duration ${d.toFixed(4)}`);
  total += d;
}
// the concat demuxer needs the last file repeated for its duration to count
lines.push(`file '${path.join(dir, frames.at(-1).file).replace(/\\/g, "/")}'`);
const list = path.join(dir, "concat.txt");
fs.writeFileSync(list, lines.join("\n"));

const vf = ["fps=30", "scale=1920:1080:flags=lanczos", "format=yuv420p", "fade=t=in:st=0:d=0.8", `fade=t=out:st=${(total - 1.2).toFixed(2)}:d=1.2`].join(",");
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
const r = spawnSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", vf, "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-movflags", "+faststart", out], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`${out}: ${total.toFixed(1)}s from ${frames.length} frames; fast-forward: ${segments.map(([a, b, s]) => `${((b - a) / 1000).toFixed(0)}s at ×${s.toFixed(1)}`).join(", ") || "none"}`);
