/** Small in-memory LRU with TTL (stands in for Redis in single-node deployments). */
export class TtlCache<V> {
  private map = new Map<string, { v: V; exp: number }>();
  constructor(private max = 500) {}
  get(k: string): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (e.exp < Date.now()) {
      this.map.delete(k);
      return undefined;
    }
    this.map.delete(k);
    this.map.set(k, e);
    return e.v;
  }
  set(k: string, v: V, ttlMs: number) {
    if (ttlMs <= 0) return;
    this.map.delete(k);
    this.map.set(k, { v, exp: Date.now() + ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
  deletePrefix(prefix: string) {
    for (const k of this.map.keys()) if (k.startsWith(prefix)) this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

/** Fixed-window rate limiter keyed by user and bucket. */
export class RateLimiter {
  private hits = new Map<string, { n: number; window: number }>();
  check(key: string, perMinute: number): boolean {
    const w = Math.floor(Date.now() / 60_000);
    const e = this.hits.get(key);
    if (!e || e.window !== w) {
      this.hits.set(key, { n: 1, window: w });
      if (this.hits.size > 10_000) this.hits.clear();
      return true;
    }
    e.n++;
    return e.n <= perMinute;
  }
}
