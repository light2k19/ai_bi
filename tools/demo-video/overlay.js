/*
 * Presentation layer injected into the top page while the demo is recorded: a visible cursor with click
 * ripples, step captions, full-screen title cards, a live "AI is building" timer and a spotlight. Everything
 * is pointer-events: none, so the app underneath behaves exactly as it would for a user.
 */
(() => {
  if (window.top !== window || window.__demo) return;
  const css = `
  #demo-root, #demo-root * { box-sizing: border-box; font-family: Inter, "Segoe UI", system-ui, sans-serif; }
  #demo-root { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
  .demo-cursor { position: absolute; left: 0; top: 0; width: 30px; height: 30px; transform: translate(-3px, -2px); filter: drop-shadow(0 3px 6px rgba(0,0,0,.45)); transition: opacity .3s; }
  .demo-ripple { position: absolute; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%; border: 3px solid #7aa2ff; background: rgba(122,162,255,.25); animation: demo-ripple .6s ease-out forwards; }
  @keyframes demo-ripple { from { transform: scale(.4); opacity: 1; } to { transform: scale(3.2); opacity: 0; } }
  .demo-caption { position: absolute; left: 50%; bottom: 34px; transform: translate(-50%, 24px); opacity: 0; max-width: 1180px; padding: 18px 30px 20px; border-radius: 18px;
    background: rgba(10, 14, 28, .86); backdrop-filter: blur(10px); border: 1px solid rgba(122,162,255,.35); box-shadow: 0 18px 50px rgba(0,0,0,.45); color: #fff; transition: opacity .45s ease, transform .45s ease; text-align: left; }
  .demo-caption.on { opacity: 1; transform: translate(-50%, 0); }
  .demo-kicker { font-size: 13px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: #7aa2ff; margin-bottom: 6px; }
  .demo-title { font-size: 28px; font-weight: 650; line-height: 1.2; letter-spacing: -.01em; }
  .demo-sub { margin-top: 6px; font-size: 17px; line-height: 1.45; color: #b8c2dc; }
  .demo-card { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; opacity: 0; transition: opacity .7s ease;
    background: radial-gradient(1200px 700px at 30% 20%, #23336e 0%, rgba(35,51,110,0) 60%), radial-gradient(900px 600px at 80% 90%, #3b1d6e 0%, rgba(59,29,110,0) 60%), #070b18; color: #fff; }
  .demo-card.on { opacity: 1; }
  .demo-card .logo { display: flex; align-items: center; gap: 16px; margin-bottom: 30px; font-size: 30px; font-weight: 700; letter-spacing: -.01em; }
  .demo-card .logo i { display: grid; place-items: center; width: 58px; height: 58px; border-radius: 16px; background: linear-gradient(135deg, #5b8cff, #8a5bff); box-shadow: 0 10px 30px rgba(91,140,255,.45); font-style: normal; font-size: 30px; }
  .demo-card h1 { margin: 0; font-size: 64px; line-height: 1.08; font-weight: 750; letter-spacing: -.025em; max-width: 1200px; }
  .demo-card h1 em { font-style: normal; background: linear-gradient(90deg, #7aa2ff, #b48cff); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .demo-card p { margin: 22px 0 0; font-size: 25px; color: #b8c2dc; max-width: 1000px; line-height: 1.4; }
  .demo-card ul { list-style: none; margin: 34px 0 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 460px)); gap: 16px 28px; text-align: left; }
  .demo-card li { display: flex; gap: 12px; align-items: flex-start; font-size: 21px; line-height: 1.35; color: #e4e9f7; opacity: 0; transform: translateY(12px); transition: opacity .5s ease, transform .5s ease; }
  .demo-card li.on { opacity: 1; transform: none; }
  .demo-card li b { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; background: rgba(122,162,255,.18); color: #9fbaff; font-size: 16px; }
  .demo-card .cta { margin-top: 40px; padding: 14px 30px; border-radius: 999px; background: linear-gradient(90deg, #5b8cff, #8a5bff); font-size: 22px; font-weight: 650; opacity: 0; transition: opacity .6s ease; }
  .demo-card .cta.on { opacity: 1; }
  .demo-timer { position: absolute; top: 74px; left: 50%; transform: translate(-50%, -10px); opacity: 0; display: flex; align-items: center; gap: 12px; padding: 10px 20px; border-radius: 999px;
    background: rgba(10,14,28,.9); border: 1px solid rgba(122,162,255,.45); color: #fff; font-size: 17px; font-weight: 600; box-shadow: 0 10px 30px rgba(0,0,0,.4); transition: opacity .4s, transform .4s; }
  .demo-timer.on { opacity: 1; transform: translate(-50%, 0); }
  .demo-timer .dot { width: 10px; height: 10px; border-radius: 50%; background: #7aa2ff; box-shadow: 0 0 0 0 rgba(122,162,255,.7); animation: demo-pulse 1.2s infinite; }
  .demo-timer.done .dot { background: #34d399; animation: none; }
  .demo-timer .t { font-variant-numeric: tabular-nums; color: #9fbaff; }
  .demo-timer .fast { padding: 2px 9px; border-radius: 999px; background: rgba(255,255,255,.1); color: #cfd8ef; font-size: 13px; font-weight: 700; letter-spacing: .04em; }
  @keyframes demo-pulse { 0% { box-shadow: 0 0 0 0 rgba(122,162,255,.7); } 70% { box-shadow: 0 0 0 12px rgba(122,162,255,0); } 100% { box-shadow: 0 0 0 0 rgba(122,162,255,0); } }
  .demo-spot { position: absolute; border-radius: 14px; border: 2px solid rgba(122,162,255,.95); box-shadow: 0 0 0 9999px rgba(3,6,15,.55), 0 0 30px rgba(122,162,255,.5); opacity: 0; transition: all .5s ease; }
  .demo-spot.on { opacity: 1; }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  const root = document.createElement("div");
  root.id = "demo-root";
  root.innerHTML = `
    <div class="demo-spot"></div>
    <div class="demo-timer"><span class="dot"></span><span class="label"></span><span class="t">0:00</span><span class="fast" hidden></span></div>
    <div class="demo-caption"><div class="demo-kicker"></div><div class="demo-title"></div><div class="demo-sub"></div></div>
    <div class="demo-card"></div>
    <svg class="demo-cursor" viewBox="0 0 28 28"><path d="M5 3l17 10.5-7.6 1.6L10.6 23 5 3z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  const mount = () => {
    if (!document.head || !document.body) return requestAnimationFrame(mount);
    document.head.appendChild(style);
    document.body.appendChild(root);
  };
  mount();
  const $ = (s) => root.querySelector(s);
  const cur = { x: 760, y: 430 };
  const place = () => ($(".demo-cursor").style.transform = `translate(${cur.x - 3}px, ${cur.y - 2}px)`);
  place();
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  let timer = null;

  window.__demo = {
    /** glide the cursor to x,y */
    cursorTo(x, y, ms = 650) {
      const from = { ...cur };
      const t0 = performance.now();
      return new Promise((res) => {
        const step = (now) => {
          const k = Math.min(1, (now - t0) / ms);
          const e = ease(k);
          cur.x = from.x + (x - from.x) * e;
          cur.y = from.y + (y - from.y) * e;
          place();
          if (k < 1) requestAnimationFrame(step);
          else res();
        };
        requestAnimationFrame(step);
      });
    },
    ripple() {
      const r = document.createElement("div");
      r.className = "demo-ripple";
      r.style.left = `${cur.x}px`;
      r.style.top = `${cur.y}px`;
      root.appendChild(r);
      setTimeout(() => r.remove(), 700);
    },
    cursor(visible) {
      $(".demo-cursor").style.opacity = visible ? "1" : "0";
    },
    caption(kicker, title, sub) {
      const c = $(".demo-caption");
      if (!title) return c.classList.remove("on");
      const show = () => {
        $(".demo-kicker").textContent = kicker || "";
        $(".demo-kicker").style.display = kicker ? "" : "none";
        $(".demo-title").textContent = title;
        $(".demo-sub").textContent = sub || "";
        $(".demo-sub").style.display = sub ? "" : "none";
        c.classList.add("on");
      };
      if (c.classList.contains("on")) {
        c.classList.remove("on");
        setTimeout(show, 420);
      } else show();
    },
    card(html) {
      const c = $(".demo-card");
      if (!html) return c.classList.remove("on");
      c.innerHTML = html;
      requestAnimationFrame(() => c.classList.add("on"));
    },
    revealCard() {
      const items = [...root.querySelectorAll(".demo-card li, .demo-card .cta")];
      items.forEach((el, i) => setTimeout(() => el.classList.add("on"), 260 * i));
    },
    timerStart(label, fast) {
      const el = $(".demo-timer");
      el.classList.remove("done");
      el.querySelector(".label").textContent = label;
      const f = el.querySelector(".fast");
      f.hidden = !fast;
      f.textContent = fast || "";
      const t0 = Date.now();
      const tick = () => {
        const s = Math.floor((Date.now() - t0) / 1000);
        el.querySelector(".t").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      };
      tick();
      clearInterval(timer);
      timer = setInterval(tick, 250);
      el.classList.add("on");
    },
    timerDone(label) {
      clearInterval(timer);
      const el = $(".demo-timer");
      el.classList.add("done");
      el.querySelector(".label").textContent = label;
      el.querySelector(".fast").hidden = true;
    },
    timerHide() {
      $(".demo-timer").classList.remove("on");
    },
    spot(r, pad = 8) {
      const s = $(".demo-spot");
      if (!r) return s.classList.remove("on");
      Object.assign(s.style, { left: `${r.x - pad}px`, top: `${r.y - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
      s.classList.add("on");
    },
    /** smoothly scroll the nearest scrollable container of `selector` (default: the page preview) */
    scrollBy(dy, ms = 1400, selector = "iframe") {
      let el = document.querySelector(selector);
      while (el && !(el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
      if (!el) return Promise.resolve(false);
      const from = el.scrollTop;
      const to = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, from + dy));
      const t0 = performance.now();
      return new Promise((res) => {
        const step = (now) => {
          const k = Math.min(1, (now - t0) / ms);
          el.scrollTop = from + (to - from) * ease(k);
          if (k < 1) requestAnimationFrame(step);
          else res(true);
        };
        requestAnimationFrame(step);
      });
    },
  };
})();
