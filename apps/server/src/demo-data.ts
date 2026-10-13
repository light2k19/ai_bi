/**
 * Builds a fictional company's analytics database (SQLite) for the demo project:
 * sales (orders, lines, products, customers, regions, targets) and finance
 * (general ledger, budget, headcount). Deterministic, ~3 years of data up to today.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export function buildDemoDatabase(file: string, today = new Date()) {
  if (fs.existsSync(file)) fs.rmSync(file);
  const db = new DatabaseSync(file);
  const r = rng(42);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
  db.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE regions (id INTEGER PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, manager TEXT NOT NULL);
    CREATE TABLE products (id INTEGER PRIMARY KEY, sku TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, unit_cost REAL NOT NULL, list_price REAL NOT NULL);
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, segment TEXT NOT NULL, region_id INTEGER NOT NULL REFERENCES regions(id), country TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, order_date TEXT NOT NULL, customer_id INTEGER NOT NULL REFERENCES customers(id), region_id INTEGER NOT NULL REFERENCES regions(id), channel TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE order_lines (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL, unit_price REAL NOT NULL, discount REAL NOT NULL);
    CREATE TABLE sales_targets (region_id INTEGER NOT NULL REFERENCES regions(id), month TEXT NOT NULL, target_amount REAL NOT NULL, PRIMARY KEY (region_id, month));
    CREATE TABLE gl_accounts (id INTEGER PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, category TEXT NOT NULL);
    CREATE TABLE gl_entries (id INTEGER PRIMARY KEY, entry_date TEXT NOT NULL, account_id INTEGER NOT NULL REFERENCES gl_accounts(id), region_id INTEGER REFERENCES regions(id), department TEXT NOT NULL, amount REAL NOT NULL);
    CREATE TABLE budget (month TEXT NOT NULL, account_id INTEGER NOT NULL REFERENCES gl_accounts(id), department TEXT NOT NULL, amount REAL NOT NULL);
    CREATE TABLE headcount (month TEXT NOT NULL, department TEXT NOT NULL, fte REAL NOT NULL, cost REAL NOT NULL);
    CREATE INDEX orders_date ON orders(order_date);
    CREATE INDEX lines_order ON order_lines(order_id);
    CREATE INDEX gl_date ON gl_entries(entry_date);
  `);

  const regions = [
    [1, "NORTH", "North", "A. Lindqvist"],
    [2, "SOUTH", "South", "M. Okafor"],
    [3, "EAST", "East", "J. Tanaka"],
    [4, "WEST", "West", "R. Alvarez"],
    [5, "CENTRAL", "Central", "S. Novak"],
  ] as const;
  const insR = db.prepare("INSERT INTO regions VALUES (?,?,?,?)");
  for (const x of regions) insR.run(...x);
  const regionWeight = [1.25, 0.9, 1.1, 1.0, 0.75];

  const cats: [string, string[], number, number][] = [
    ["Software", ["Analytics Suite", "Planner Pro", "Data Vault", "Insight Cloud", "Forecast Kit"], 300, 0.18],
    ["Hardware", ["Edge Gateway", "Sensor Pack", "Display Panel", "Compute Node"], 900, 0.62],
    ["Services", ["Implementation", "Training Day", "Premium Support", "Health Check"], 1200, 0.45],
    ["Accessories", ["Cable Kit", "Mount Set", "Power Unit", "Carry Case", "Adapter Pack"], 60, 0.4],
  ];
  const insP = db.prepare("INSERT INTO products VALUES (?,?,?,?,?,?)");
  const products: { id: number; price: number; cost: number; cat: string }[] = [];
  let pid = 1;
  for (const [cat, names, base, costRatio] of cats) {
    for (const n of names) {
      const price = Math.round(base * (0.6 + r() * 0.9));
      const cost = Math.round(price * costRatio * (0.9 + r() * 0.2) * 100) / 100;
      insP.run(pid, `${cat.slice(0, 3).toUpperCase()}-${String(pid).padStart(3, "0")}`, n, cat, cost, price);
      products.push({ id: pid, price, cost, cat });
      pid++;
    }
  }

  const segments = ["Enterprise", "Mid-market", "Small business", "Public sector"];
  const countries: Record<number, string[]> = { 1: ["Norway", "Sweden", "Finland"], 2: ["Spain", "Italy", "Portugal"], 3: ["Poland", "Czechia", "Hungary"], 4: ["France", "Ireland", "Belgium"], 5: ["Germany", "Austria", "Switzerland"] };
  const sylA = ["Al", "Bri", "Cor", "Del", "Ever", "Fal", "Gran", "Hol", "Ivo", "Jun", "Kel", "Lum", "Mar", "Nor", "Orb", "Pax", "Quin", "Riv", "Sol", "Tor", "Ul", "Ven", "Wex", "Yar", "Zen"];
  const sylB = ["tech", "works", "ware", "line", "gate", "field", "point", "stone", "path", "ridge", "data", "logic"];
  const sfx = ["Ltd", "Group", "GmbH", "AB", "SA", "Partners", "Systems", "Holdings"];
  const insC = db.prepare("INSERT INTO customers VALUES (?,?,?,?,?,?)");
  const customers: { id: number; region: number; seg: string }[] = [];
  const start = new Date(Date.UTC(today.getUTCFullYear() - 2, 0, 1));
  for (let i = 1; i <= 900; i++) {
    const region = 1 + Math.floor(r() * 5);
    const seg = r() < 0.2 ? "Enterprise" : pick(segments);
    const created = new Date(start.getTime() + r() * (today.getTime() - start.getTime()) * 0.7);
    insC.run(i, `${pick(sylA)}${pick(sylB)} ${pick(sfx)}`, seg, region, pick(countries[region]), ymd(created));
    customers.push({ id: i, region, seg });
  }

  const insO = db.prepare("INSERT INTO orders VALUES (?,?,?,?,?,?)");
  const insL = db.prepare("INSERT INTO order_lines VALUES (?,?,?,?,?,?)");
  const channels = ["Online", "Retail", "Partner"];
  let oid = 1;
  let lid = 1;
  const monthlyRevenue = new Map<string, number[]>(); // month -> per region revenue
  db.exec("BEGIN");
  for (let d = new Date(start); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    const monthIdx = (d.getUTCFullYear() - start.getUTCFullYear()) * 12 + d.getUTCMonth();
    const growth = 1 + monthIdx * 0.012;
    const seasonal = 1 + 0.18 * Math.sin(((d.getUTCMonth() - 2) / 12) * Math.PI * 2) + (d.getUTCMonth() === 11 ? 0.25 : 0);
    const weekday = dow === 0 || dow === 6 ? 0.35 : 1;
    const n = Math.round((14 + r() * 8) * growth * seasonal * weekday);
    for (let k = 0; k < n; k++) {
      const c = pick(customers);
      // West dips in the current year so the demo has a story
      const regionBoost = regionWeight[c.region - 1] * (c.region === 4 && d.getUTCFullYear() === today.getUTCFullYear() ? 0.78 : 1);
      if (r() > regionBoost * 0.8) continue;
      const channel = c.seg === "Enterprise" ? (r() < 0.6 ? "Partner" : "Online") : r() < 0.55 ? "Online" : pick(channels);
      const status = r() < 0.03 ? "Cancelled" : r() < 0.05 ? "Returned" : "Completed";
      insO.run(oid, ymd(d), c.id, c.region, channel, status);
      const lines = 1 + Math.floor(r() * (c.seg === "Enterprise" ? 5 : 3));
      for (let j = 0; j < lines; j++) {
        const p = pick(products);
        const qty = 1 + Math.floor(r() * (p.cat === "Accessories" ? 12 : c.seg === "Enterprise" ? 6 : 3));
        const disc = c.seg === "Enterprise" ? Math.round(r() * 20) / 100 : r() < 0.3 ? Math.round(r() * 10) / 100 : 0;
        const unit = Math.round(p.price * (0.95 + r() * 0.1) * 100) / 100;
        insL.run(lid++, oid, p.id, qty, unit, disc);
        if (status === "Completed") {
          const m = ymd(d).slice(0, 7);
          const arr = monthlyRevenue.get(m) ?? [0, 0, 0, 0, 0];
          arr[c.region - 1] += qty * unit * (1 - disc);
          monthlyRevenue.set(m, arr);
        }
      }
      oid++;
    }
  }
  db.exec("COMMIT");

  // targets: last year's actual for the month * growth expectation, set before the year started
  const insT = db.prepare("INSERT INTO sales_targets VALUES (?,?,?)");
  const months = [...monthlyRevenue.keys()].sort();
  const lastMonth = new Date(Date.UTC(today.getUTCFullYear(), 11, 1));
  for (let m = new Date(start); m <= lastMonth; m.setUTCMonth(m.getUTCMonth() + 1)) {
    const key = ymd(m).slice(0, 7);
    const ly = `${Number(key.slice(0, 4)) - 1}${key.slice(4)}`;
    const base = monthlyRevenue.get(ly) ?? monthlyRevenue.get(key) ?? monthlyRevenue.get(months[0])!;
    for (let reg = 1; reg <= 5; reg++) insT.run(reg, key, Math.round(base[reg - 1] * (1.12 + r() * 0.06)));
  }

  // finance: chart of accounts, ledger and budget
  const accounts: [number, string, string, string, string][] = [
    [1, "4000", "Product revenue", "Revenue", "Revenue"],
    [2, "4100", "Service revenue", "Revenue", "Revenue"],
    [3, "5000", "Cost of goods sold", "COGS", "Cost of sales"],
    [4, "5100", "Service delivery cost", "COGS", "Cost of sales"],
    [5, "6000", "Salaries", "Opex", "People"],
    [6, "6100", "Contractors", "Opex", "People"],
    [7, "6200", "Marketing programs", "Opex", "Marketing"],
    [8, "6300", "Travel", "Opex", "General"],
    [9, "6400", "Software subscriptions", "Opex", "IT"],
    [10, "6500", "Rent and facilities", "Opex", "General"],
    [11, "6600", "Professional fees", "Opex", "General"],
  ];
  const insA = db.prepare("INSERT INTO gl_accounts VALUES (?,?,?,?,?)");
  for (const a of accounts) insA.run(...a);
  const depts = ["Sales", "Marketing", "Engineering", "Services", "Finance", "Operations"];
  const insG = db.prepare("INSERT INTO gl_entries (entry_date, account_id, region_id, department, amount) VALUES (?,?,?,?,?)");
  const insB = db.prepare("INSERT INTO budget VALUES (?,?,?,?)");
  const insH = db.prepare("INSERT INTO headcount VALUES (?,?,?,?)");
  const revByMonthCat = db
    .prepare(
      `SELECT substr(o.order_date,1,7) m, o.region_id reg, p.category cat, SUM(l.quantity*l.unit_price*(1-l.discount)) rev, SUM(l.quantity*p.unit_cost) cost
       FROM orders o JOIN order_lines l ON l.order_id = o.id JOIN products p ON p.id = l.product_id WHERE o.status = 'Completed' GROUP BY 1,2,3`,
    )
    .all() as { m: string; reg: number; cat: string; rev: number; cost: number }[];
  db.exec("BEGIN");
  for (const x of revByMonthCat) {
    const date = `${x.m}-28`;
    const svc = x.cat === "Services";
    insG.run(date, svc ? 2 : 1, x.reg, "Sales", Math.round(x.rev * 100) / 100);
    insG.run(date, svc ? 4 : 3, x.reg, svc ? "Services" : "Operations", -Math.round(x.cost * 100) / 100);
  }
  const fte: Record<string, number> = { Sales: 38, Marketing: 14, Engineering: 52, Services: 26, Finance: 9, Operations: 16 };
  for (let m = new Date(start); m <= today; m.setUTCMonth(m.getUTCMonth() + 1)) {
    const key = ymd(m).slice(0, 7);
    const idx = (m.getUTCFullYear() - start.getUTCFullYear()) * 12 + m.getUTCMonth();
    for (const dpt of depts) {
      const f = Math.round(fte[dpt] * (1 + idx * 0.008) * (0.97 + r() * 0.06) * 10) / 10;
      const salary = f * (dpt === "Engineering" ? 9800 : dpt === "Sales" ? 8200 : 7100);
      insH.run(key, dpt, f, Math.round(salary));
      insG.run(`${key}-25`, 5, null, dpt, -Math.round(salary));
      insB.run(key, 5, dpt, -Math.round(salary * (0.98 + r() * 0.03)));
      const opex: [number, number][] = [
        [6, dpt === "Engineering" ? 42000 : 6000],
        [7, dpt === "Marketing" ? 95000 : 0],
        [8, dpt === "Sales" ? 26000 : 4000],
        [9, 5200 + f * 120],
        [10, f * 900],
        [11, dpt === "Finance" ? 18000 : 1500],
      ];
      for (const [acc, base] of opex) {
        if (!base) continue;
        const actual = base * (0.8 + r() * 0.45) * (dpt === "Marketing" && m.getUTCMonth() >= 8 ? 1.25 : 1);
        insG.run(`${key}-20`, acc, null, dpt, -Math.round(actual));
        insB.run(key, acc, dpt, -Math.round(base));
      }
    }
    // revenue budget per account
    const rev = (monthlyRevenue.get(key) ?? [0]).reduce((a, b) => a + b, 0);
    insB.run(key, 1, "Sales", Math.round(rev * 0.78 * (1.05 + r() * 0.08)));
    insB.run(key, 2, "Sales", Math.round(rev * 0.22 * (1.05 + r() * 0.08)));
  }
  db.exec("COMMIT");

  db.exec(`
    CREATE VIEW v_sales AS
    SELECT o.id AS order_id, o.order_date, substr(o.order_date,1,7) AS month, o.channel, o.status,
           r.code AS region_code, r.name AS region, c.name AS customer, c.segment, c.country,
           p.name AS product, p.category, l.quantity,
           ROUND(l.quantity * l.unit_price * (1 - l.discount), 2) AS revenue,
           ROUND(l.quantity * p.unit_cost, 2) AS cost,
           ROUND(l.quantity * l.unit_price * (1 - l.discount) - l.quantity * p.unit_cost, 2) AS margin
    FROM orders o
    JOIN order_lines l ON l.order_id = o.id
    JOIN products p ON p.id = l.product_id
    JOIN customers c ON c.id = o.customer_id
    JOIN regions r ON r.id = o.region_id;
    CREATE VIEW v_pnl AS
    SELECT substr(e.entry_date,1,7) AS month, a.type, a.category, a.name AS account, e.department, SUM(e.amount) AS amount
    FROM gl_entries e JOIN gl_accounts a ON a.id = e.account_id GROUP BY 1,2,3,4,5;
    CREATE VIEW v_budget_vs_actual AS
    SELECT b.month, a.type, a.category, a.name AS account, b.department, b.amount AS budget,
           COALESCE((SELECT SUM(e.amount) FROM gl_entries e WHERE e.account_id = b.account_id AND e.department = b.department AND substr(e.entry_date,1,7) = b.month), 0) AS actual
    FROM budget b JOIN gl_accounts a ON a.id = b.account_id;
  `);
  db.exec("ANALYZE");
  const counts = {
    orders: (db.prepare("SELECT COUNT(*) n FROM orders").get() as { n: number }).n,
    lines: (db.prepare("SELECT COUNT(*) n FROM order_lines").get() as { n: number }).n,
    gl: (db.prepare("SELECT COUNT(*) n FROM gl_entries").get() as { n: number }).n,
  };
  db.close();
  return counts;
}

export const DEMO_ANNOTATIONS = {
  glossary:
    "Revenue = quantity × unit_price × (1 − discount) for orders with status 'Completed'. Margin = revenue − quantity × products.unit_cost. " +
    "In the ledger (gl_entries, v_pnl) revenue is positive and costs are negative amounts. Months are 'YYYY-MM' text; dates are 'YYYY-MM-DD' text. " +
    "Target attainment = revenue ÷ SUM(sales_targets.target_amount) for the same region and months. Aggregate revenue and targets in separate subqueries before joining them: " +
    "joining sales_targets to orders or order lines repeats each target once per row and inflates it. Ratios such as attainment and margin % are fractions (0.95 = 95%); show them with the percent format.",
  tables: {
    "main.v_sales": { description: "One row per order line with revenue, cost and margin already computed. Best starting point for sales analysis. Filter status = 'Completed' for booked revenue." },
    "main.orders": { description: "Order headers", columns: { channel: "Online, Retail or Partner", status: "Completed, Cancelled or Returned" } },
    "main.order_lines": { description: "Order lines; revenue = quantity * unit_price * (1 - discount)", columns: { discount: "ratio 0..1" } },
    "main.products": { description: "Product catalogue", columns: { category: "Software, Hardware, Services, Accessories" } },
    "main.customers": { description: "Customers", columns: { segment: "Enterprise, Mid-market, Small business, Public sector" } },
    "main.regions": { description: "Sales regions (5)" },
    "main.sales_targets": { description: "Monthly revenue target per region (one row per region and month). Sum it per region in its own subquery, never joined to order lines.", columns: { month: "YYYY-MM", target_amount: "target revenue" } },
    "main.gl_entries": { description: "General ledger postings; revenue positive, costs negative", columns: { amount: "signed amount" } },
    "main.gl_accounts": { description: "Chart of accounts", columns: { type: "Revenue, COGS or Opex" } },
    "main.budget": { description: "Monthly budget per account and department (same sign convention as the ledger)" },
    "main.headcount": { description: "Monthly FTE and salary cost by department" },
    "main.v_pnl": { description: "Ledger summarised by month, account and department (P&L)" },
    "main.v_budget_vs_actual": { description: "Budget vs actual by month, account and department" },
  },
};
