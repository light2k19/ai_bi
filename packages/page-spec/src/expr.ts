/**
 * A small, safe expression language used for calculated columns, conditional styles,
 * `visibleWhen`, and text bindings. No access to globals, prototypes, or functions other
 * than the whitelisted ones below.
 *
 * Grammar (precedence low → high):
 *   ternary:  or ('?' expr ':' expr)?
 *   or:       and ('||' and)*            also 'or'
 *   and:      eq ('&&' eq)*              also 'and'
 *   eq:       cmp (('=='|'!='|'==='|'!==') cmp)*
 *   cmp:      add (('<'|'<='|'>'|'>=') add)*
 *   add:      mul (('+'|'-') mul)*
 *   mul:      unary (('*'|'/'|'%') unary)*
 *   unary:    ('!'|'-'|'not') unary | postfix
 *   postfix:  primary ('.' ident | '[' expr ']' | '(' args ')')*
 *   primary:  number | string | true | false | null | ident | '(' expr ')' | '[' list ']'
 */

export type Node =
  | { t: "lit"; v: unknown }
  | { t: "id"; name: string }
  | { t: "mem"; obj: Node; prop: Node; computed: boolean }
  | { t: "call"; callee: string; args: Node[] }
  | { t: "un"; op: string; arg: Node }
  | { t: "bin"; op: string; l: Node; r: Node }
  | { t: "cond"; test: Node; yes: Node; no: Node }
  | { t: "arr"; items: Node[] };

export class ExprError extends Error {}

type Tok = { k: "num" | "str" | "id" | "op" | "eof"; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ k: "num", v: m[0] });
      i += m[0].length;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") {
          j++;
          const e = src[j];
          s += e === "n" ? "\n" : e === "t" ? "\t" : e;
        } else s += src[j];
        j++;
      }
      if (j >= src.length) throw new ExprError("Unterminated string");
      out.push({ k: "str", v: s });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i))!;
      out.push({ k: "id", v: m[0] });
      i += m[0].length;
      continue;
    }
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    if (["===", "!=="].includes(three)) {
      out.push({ k: "op", v: three });
      i += 3;
      continue;
    }
    if (["==", "!=", "<=", ">=", "&&", "||", "??"].includes(two)) {
      out.push({ k: "op", v: two });
      i += 2;
      continue;
    }
    if ("+-*/%<>!?:.,()[]".includes(c)) {
      out.push({ k: "op", v: c });
      i++;
      continue;
    }
    throw new ExprError(`Unexpected character '${c}'`);
  }
  out.push({ k: "eof", v: "" });
  return out;
}

export function parseExpr(src: string): Node {
  const toks = lex(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => toks[p].k === "op" && toks[p].v === v;
  const isWord = (v: string) => toks[p].k === "id" && toks[p].v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExprError(`Expected '${v}' but found '${toks[p].v || "end"}'`);
    p++;
  };

  function ternary(): Node {
    const test = nullish();
    if (isOp("?")) {
      p++;
      const yes = ternary();
      expect(":");
      const no = ternary();
      return { t: "cond", test, yes, no };
    }
    return test;
  }
  function nullish(): Node {
    let l = or();
    while (isOp("??")) {
      p++;
      l = { t: "bin", op: "??", l, r: or() };
    }
    return l;
  }
  function or(): Node {
    let l = and();
    while (isOp("||") || isWord("or")) {
      p++;
      l = { t: "bin", op: "||", l, r: and() };
    }
    return l;
  }
  function and(): Node {
    let l = eq();
    while (isOp("&&") || isWord("and")) {
      p++;
      l = { t: "bin", op: "&&", l, r: eq() };
    }
    return l;
  }
  function eq(): Node {
    let l = cmp();
    while (["==", "!=", "===", "!=="].some(isOp)) {
      const op = toks[p++].v;
      l = { t: "bin", op, l, r: cmp() };
    }
    return l;
  }
  function cmp(): Node {
    let l = add();
    while (["<", "<=", ">", ">="].some(isOp)) {
      const op = toks[p++].v;
      l = { t: "bin", op, l, r: add() };
    }
    return l;
  }
  function add(): Node {
    let l = mul();
    while (isOp("+") || isOp("-")) {
      const op = toks[p++].v;
      l = { t: "bin", op, l, r: mul() };
    }
    return l;
  }
  function mul(): Node {
    let l = unary();
    while (isOp("*") || isOp("/") || isOp("%")) {
      const op = toks[p++].v;
      l = { t: "bin", op, l, r: unary() };
    }
    return l;
  }
  function unary(): Node {
    if (isOp("!") || isWord("not")) {
      p++;
      return { t: "un", op: "!", arg: unary() };
    }
    if (isOp("-")) {
      p++;
      return { t: "un", op: "-", arg: unary() };
    }
    return postfix();
  }
  function postfix(): Node {
    let n = primary();
    for (;;) {
      if (isOp(".")) {
        p++;
        const t = peek();
        if (t.k !== "id" && t.k !== "num") throw new ExprError("Expected property name after '.'");
        p++;
        n = { t: "mem", obj: n, prop: { t: "lit", v: t.v }, computed: false };
      } else if (isOp("[")) {
        p++;
        const prop = ternary();
        expect("]");
        n = { t: "mem", obj: n, prop, computed: true };
      } else if (isOp("(")) {
        if (n.t !== "id") throw new ExprError("Only built-in functions can be called");
        p++;
        const args: Node[] = [];
        if (!isOp(")")) {
          args.push(ternary());
          while (isOp(",")) {
            p++;
            args.push(ternary());
          }
        }
        expect(")");
        n = { t: "call", callee: n.name, args };
      } else return n;
    }
  }
  function primary(): Node {
    const t = peek();
    if (t.k === "num") {
      p++;
      return { t: "lit", v: Number(t.v) };
    }
    if (t.k === "str") {
      p++;
      return { t: "lit", v: t.v };
    }
    if (t.k === "id") {
      p++;
      if (t.v === "true") return { t: "lit", v: true };
      if (t.v === "false") return { t: "lit", v: false };
      if (t.v === "null") return { t: "lit", v: null };
      return { t: "id", name: t.v };
    }
    if (isOp("(")) {
      p++;
      const e = ternary();
      expect(")");
      return e;
    }
    if (isOp("[")) {
      p++;
      const items: Node[] = [];
      if (!isOp("]")) {
        items.push(ternary());
        while (isOp(",")) {
          p++;
          items.push(ternary());
        }
      }
      expect("]");
      return { t: "arr", items };
    }
    throw new ExprError(`Unexpected '${t.v || "end of expression"}'`);
  }

  const node = ternary();
  if (peek().k !== "eof") throw new ExprError(`Unexpected '${peek().v}'`);
  return node;
}

const BLOCKED_PROPS = new Set(["__proto__", "prototype", "constructor", "__defineGetter__", "__defineSetter__", "__lookupGetter__"]);

const num = (v: unknown) => (v === null || v === undefined || v === "" ? NaN : Number(v));
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const FUNCTIONS: Record<string, (...a: unknown[]) => unknown> = {
  abs: (x) => Math.abs(num(x)),
  round: (x, d = 0) => {
    const f = 10 ** Number(d);
    return Math.round(num(x) * f) / f;
  },
  floor: (x) => Math.floor(num(x)),
  ceil: (x) => Math.ceil(num(x)),
  min: (...a) => Math.min(...(a.length === 1 && Array.isArray(a[0]) ? a[0] : a).map(num)),
  max: (...a) => Math.max(...(a.length === 1 && Array.isArray(a[0]) ? a[0] : a).map(num)),
  sum: (a) => arr(a).reduce((s: number, x) => s + (Number.isFinite(num(x)) ? num(x) : 0), 0),
  avg: (a) => {
    const v = arr(a).map(num).filter(Number.isFinite);
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  },
  count: (a) => arr(a).length,
  len: (x) => (typeof x === "string" || Array.isArray(x) ? x.length : 0),
  coalesce: (...a) => a.find((x) => x !== null && x !== undefined && x !== ""),
  if: (c, a, b) => (c ? a : b),
  safeDiv: (a, b) => (num(b) === 0 || !Number.isFinite(num(b)) ? null : num(a) / num(b)),
  pct: (a, b) => (num(b) === 0 ? null : (num(a) / num(b)) * 100),
  lower: (s) => String(s ?? "").toLowerCase(),
  upper: (s) => String(s ?? "").toUpperCase(),
  concat: (...a) => a.map((x) => (x === null || x === undefined ? "" : String(x))).join(""),
  contains: (h, n) => (Array.isArray(h) ? h.includes(n) : String(h ?? "").includes(String(n))),
  startsWith: (s, p) => String(s ?? "").startsWith(String(p)),
  number: (x) => num(x),
  string: (x) => (x === null || x === undefined ? "" : String(x)),
  year: (d) => new Date(String(d)).getUTCFullYear(),
  month: (d) => new Date(String(d)).getUTCMonth() + 1,
  day: (d) => new Date(String(d)).getUTCDate(),
  quarter: (d) => Math.floor(new Date(String(d)).getUTCMonth() / 3) + 1,
  date: (d) => String(d ?? "").slice(0, 10),
  left: (s, n) => String(s ?? "").slice(0, Number(n)),
  right: (s, n) => String(s ?? "").slice(-Number(n)),
  substr: (s, a, n) => String(s ?? "").substr(Number(a), n === undefined ? undefined : Number(n)),
  isNull: (x) => x === null || x === undefined,
  first: (a) => arr(a)[0],
  last: (a) => {
    const v = arr(a);
    return v[v.length - 1];
  },
  pluck: (a, k) => arr(a).map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>)[String(k)] : undefined)),
  fixed: (x, d = 2) => (Number.isFinite(num(x)) ? num(x).toFixed(Number(d)) : ""),
};

const FUNCTIONS_CI: Record<string, (...a: unknown[]) => unknown> = Object.fromEntries(Object.entries(FUNCTIONS).map(([k, v]) => [k.toLowerCase(), v]));

export function evalNode(n: Node, scope: Record<string, unknown>): unknown {
  switch (n.t) {
    case "lit":
      return n.v;
    case "id":
      return Object.prototype.hasOwnProperty.call(scope, n.name) ? scope[n.name] : undefined;
    case "arr":
      return n.items.map((i) => evalNode(i, scope));
    case "mem": {
      const obj = evalNode(n.obj, scope);
      const key = String(evalNode(n.prop, scope));
      if (BLOCKED_PROPS.has(key)) throw new ExprError(`Property '${key}' is not accessible`);
      if (obj === null || obj === undefined) return undefined;
      if (typeof obj === "string" && key === "length") return obj.length;
      if (typeof obj !== "object") return undefined;
      if (Array.isArray(obj) && key === "length") return obj.length;
      return Object.prototype.hasOwnProperty.call(obj, key) ? (obj as Record<string, unknown>)[key] : undefined;
    }
    case "call": {
      // function names are case-insensitive (SQL habits: ABS, ROUND, COALESCE)
      const f = FUNCTIONS[n.callee] ?? FUNCTIONS_CI[n.callee.toLowerCase()];
      if (!f) throw new ExprError(`Unknown function '${n.callee}'`);
      return f(...n.args.map((a) => evalNode(a, scope)));
    }
    case "un": {
      const v = evalNode(n.arg, scope);
      return n.op === "!" ? !v : -num(v);
    }
    case "cond":
      return evalNode(n.test, scope) ? evalNode(n.yes, scope) : evalNode(n.no, scope);
    case "bin": {
      if (n.op === "&&") return evalNode(n.l, scope) && evalNode(n.r, scope);
      if (n.op === "||") return evalNode(n.l, scope) || evalNode(n.r, scope);
      if (n.op === "??") return evalNode(n.l, scope) ?? evalNode(n.r, scope);
      const l = evalNode(n.l, scope) as never;
      const r = evalNode(n.r, scope) as never;
      switch (n.op) {
        case "+":
          return typeof l === "string" || typeof r === "string" ? `${l ?? ""}${r ?? ""}` : num(l) + num(r);
        case "-":
          return num(l) - num(r);
        case "*":
          return num(l) * num(r);
        case "/":
          return num(r) === 0 ? null : num(l) / num(r);
        case "%":
          return num(l) % num(r);
        case "==":
          // eslint-disable-next-line eqeqeq
          return l == r;
        case "!=":
          // eslint-disable-next-line eqeqeq
          return l != r;
        case "===":
          return l === r;
        case "!==":
          return l !== r;
        case "<":
          return l < r;
        case "<=":
          return l <= r;
        case ">":
          return l > r;
        case ">=":
          return l >= r;
      }
      throw new ExprError(`Unknown operator ${n.op}`);
    }
  }
}

const cache = new Map<string, Node>();
export function compileExpr(src: string): Node {
  let n = cache.get(src);
  if (!n) {
    n = parseExpr(src);
    if (cache.size > 2000) cache.clear();
    cache.set(src, n);
  }
  return n;
}

export function evaluate(src: string, scope: Record<string, unknown>): unknown {
  return evalNode(compileExpr(src), scope);
}

/** Identifiers referenced at the root of an expression (for dependency analysis). */
export function rootIdentifiers(n: Node, out = new Set<string>()): Set<string> {
  switch (n.t) {
    case "id":
      out.add(n.name);
      break;
    case "mem":
      rootIdentifiers(n.obj, out);
      if (n.computed) rootIdentifiers(n.prop, out);
      break;
    case "call":
      n.args.forEach((a) => rootIdentifiers(a, out));
      break;
    case "un":
      rootIdentifiers(n.arg, out);
      break;
    case "bin":
      rootIdentifiers(n.l, out);
      rootIdentifiers(n.r, out);
      break;
    case "cond":
      rootIdentifiers(n.test, out);
      rootIdentifiers(n.yes, out);
      rootIdentifiers(n.no, out);
      break;
    case "arr":
      n.items.forEach((a) => rootIdentifiers(a, out));
      break;
  }
  return out;
}

/** Full member paths such as filters.date.start referenced by an expression. */
export function memberPaths(n: Node, out = new Set<string>()): Set<string> {
  const path = (m: Node): string | null => {
    if (m.t === "id") return m.name;
    if (m.t === "mem" && !m.computed) {
      const base = path(m.obj);
      return base ? `${base}.${String((m.prop as { v: unknown }).v)}` : null;
    }
    return null;
  };
  const walk = (m: Node) => {
    const p = path(m);
    if (p) {
      out.add(p);
      return;
    }
    switch (m.t) {
      case "mem":
        walk(m.obj);
        walk(m.prop);
        break;
      case "call":
        m.args.forEach(walk);
        break;
      case "un":
        walk(m.arg);
        break;
      case "bin":
        walk(m.l);
        walk(m.r);
        break;
      case "cond":
        walk(m.test);
        walk(m.yes);
        walk(m.no);
        break;
      case "arr":
        m.items.forEach(walk);
        break;
    }
  };
  walk(n);
  return out;
}
