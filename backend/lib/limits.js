// Sliding-window limits that keep a public demo from draining paid APIs.
export function createLimiter(rules) {
  const hits = new Map();
  return {
    take(rule, who) {
      const [max, windowMs] = rules[rule];
      const key = `${rule}:${who}`, now = Date.now();
      const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
      if (recent.length >= max) { hits.set(key, recent); return false; }
      recent.push(now);
      hits.set(key, recent);
      if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < 86400e3)) hits.delete(k);
      return true;
    }
  };
}
