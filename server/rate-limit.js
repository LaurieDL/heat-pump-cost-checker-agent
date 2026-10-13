// In-memory fixed-window limiter. Fine for one Railway instance; if the
// service is ever scaled to several replicas, move this to Redis.
export function createRateLimiter({ limit, windowMs, now = () => Date.now() }) {
  const hits = new Map(); // key -> { count, resetAt }

  function sweep(t) {
    for (const [key, entry] of hits) if (entry.resetAt <= t) hits.delete(key);
  }

  return {
    /** @returns {{ allowed: boolean, retryAfterSeconds: number }} */
    take(key) {
      const t = now();
      if (hits.size > 10_000) sweep(t);
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= t) {
        entry = { count: 0, resetAt: t + windowMs };
        hits.set(key, entry);
      }
      if (entry.count >= limit) {
        return { allowed: false, retryAfterSeconds: Math.ceil((entry.resetAt - t) / 1000) };
      }
      entry.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}
