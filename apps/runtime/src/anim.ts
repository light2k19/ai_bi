import type { AnimApi, AnimOptions, Targets } from "@aibi/runtime-api";
import { formatValue } from "@aibi/page-spec";

const DEFAULT_EASE = "cubic-bezier(.2,.7,.2,1)";
const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function createAnim(root: () => HTMLElement): AnimApi {
  const resolve = (t: Targets): Element[] => {
    if (!t) return [];
    if (typeof t === "string") return [...root().querySelectorAll(t)];
    if (t instanceof Element) return [t];
    return Array.from(t as ArrayLike<Element | null | undefined>).filter((x): x is Element => x instanceof Element);
  };

  const animate: AnimApi["animate"] = async (targets, keyframes, opts: AnimOptions = {}) => {
    const els = resolve(targets);
    if (!els.length) return;
    const duration = reduced() ? 1 : (opts.duration ?? 600);
    await Promise.all(
      els.map((el, i) => {
        const delay = typeof opts.delay === "function" ? opts.delay(i) : (opts.delay ?? 0);
        const a = el.animate(keyframes, { duration, delay: reduced() ? 0 : delay, easing: opts.easing ?? DEFAULT_EASE, fill: opts.fill ?? "both", iterations: opts.iterations ?? 1 });
        return a.finished.then(
          () => {
            // keep the final state without leaving fill effects that block later animations
            if ((opts.fill ?? "both") !== "none") {
              try {
                a.commitStyles();
              } catch {
                /* element may be detached */
              }
              a.cancel();
            }
          },
          () => undefined,
        );
      }),
    );
  };

  const stagger: AnimApi["stagger"] = (step, opts = {}) => {
    const start = opts.start ?? 0;
    return (i: number) => start + i * step;
  };

  const reveal: AnimApi["reveal"] = (targets, opts = {}) => {
    const d = opts.distance ?? 16;
    const dir = opts.direction ?? "up";
    const from = dir === "up" ? `translateY(${d}px)` : dir === "down" ? `translateY(-${d}px)` : dir === "left" ? `translateX(${d}px)` : `translateX(-${d}px)`;
    return animate(targets, { opacity: [0, 1], transform: [from, "none"] }, { duration: 650, ...opts });
  };

  const countUp: AnimApi["countUp"] = async (target, to, opts = {}) => {
    const els = resolve(target);
    const from = opts.from ?? 0;
    const duration = reduced() ? 1 : (opts.duration ?? 1200);
    const f = opts.format;
    const fmt = typeof f === "function" ? f : (n: number) => (typeof f === "string" ? formatValue(n, f) : Math.round(n).toLocaleString());
    const t0 = performance.now();
    await new Promise<void>((done) => {
      const tick = (t: number) => {
        const p = Math.min(1, (t - t0) / duration);
        const e = 1 - Math.pow(1 - p, 3);
        for (const el of els) el.textContent = fmt(from + (to - from) * e);
        if (p < 1) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
  };

  const typewriter: AnimApi["typewriter"] = async (target, text, opts = {}) => {
    const els = resolve(target);
    const speed = reduced() ? 0 : (opts.speed ?? 25);
    for (const el of els) el.textContent = "";
    for (let i = 1; i <= text.length; i++) {
      for (const el of els) el.textContent = text.slice(0, i);
      if (speed) await new Promise((r) => setTimeout(r, speed));
    }
  };

  const pulse: AnimApi["pulse"] = (target, opts = {}) =>
    animate(target, { transform: ["scale(1)", "scale(1.04)", "scale(1)"] }, { duration: 500, fill: "none", ...opts });

  const highlight: AnimApi["highlight"] = (target, opts = {}) => {
    const color = opts.color ?? "var(--accent)";
    return animate(
      target,
      [
        { boxShadow: "0 0 0 0 transparent", transform: "scale(1)" },
        { boxShadow: `0 0 0 4px ${color}`, transform: "scale(1.01)", offset: 0.35 },
        { boxShadow: "0 0 0 0 transparent", transform: "scale(1)" },
      ],
      { duration: 1100, fill: "none", ...opts },
    );
  };

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const timeline: AnimApi["timeline"] = () => {
    const steps: ((() => Promise<unknown> | unknown) | number)[] = [];
    const tl = {
      add(step: (() => Promise<unknown> | unknown) | number) {
        steps.push(step);
        return tl;
      },
      async play() {
        for (const s of steps) {
          if (typeof s === "number") await sleep(s);
          else await s();
        }
      },
    };
    return tl;
  };

  return { animate, stagger, reveal, countUp, typewriter, pulse, highlight, timeline, sleep };
}
