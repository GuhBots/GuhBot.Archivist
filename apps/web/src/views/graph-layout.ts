/**
 * The character graph's deterministic force layout, as the owner approved in
 * the prototype. Every pair of characters pushes apart, and each visible
 * connection pulls its pair together, harder when they share more, so groups
 * form by connection. The same characters and connections always give the
 * same picture. The pull only places nodes; no strength score is shown.
 */

export interface Link {
  a: string;
  b: string;
  /** How hard the pair pulls together, from what the visible layers count for it. */
  weight: number;
}

/** A small seeded random number generator, so the starting positions repeat. */
function seeded(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The pull for a pair that shares `count` things in the visible layers. */
export function linkWeight(count: number): number {
  return 0.35 + Math.log2(1 + count) * 0.35;
}

/**
 * Most steps the layout takes. A large archive takes fewer, since every step
 * compares every pair, so the page stays responsive.
 */
function stepsFor(n: number): number {
  return Math.max(40, Math.min(500, Math.floor(40_000_000 / Math.max(n * n, 1))));
}

/** Places `ids` in a `width` by `height` box. `ids` must be in a stable order. */
export function graphLayout(
  ids: readonly string[],
  links: readonly Link[],
  width: number,
  height: number,
): Map<string, { x: number; y: number }> {
  const n = ids.length;
  const out = new Map<string, { x: number; y: number }>();
  if (!n) return out;
  const index = new Map(ids.map((id, i) => [id, i]));
  const random = seeded(n * 7919 + links.length * 104729);
  const pos = ids.map((_, i) => {
    const angle = (i / n) * Math.PI * 2;
    const radius = 60 + random() * 60;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  });
  const k = Math.sqrt((width * height) / n) * 0.42;
  let temperature = k * 2;
  const steps = stepsFor(n);
  const move = pos.map(() => ({ x: 0, y: 0 }));
  for (let step = 0; step < steps; step++) {
    for (const m of move) {
      m.x = 0;
      m.y = 0;
    }
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pos[i]!.x - pos[j]!.x;
        const dy = pos[i]!.y - pos[j]!.y;
        const d = Math.max(Math.hypot(dx, dy), 1);
        const push = (k * k) / d;
        move[i]!.x += (dx / d) * push;
        move[i]!.y += (dy / d) * push;
        move[j]!.x -= (dx / d) * push;
        move[j]!.y -= (dy / d) * push;
      }
    }
    for (const { a, b, weight } of links) {
      const i = index.get(a);
      const j = index.get(b);
      if (i === undefined || j === undefined) continue;
      const dx = pos[i]!.x - pos[j]!.x;
      const dy = pos[i]!.y - pos[j]!.y;
      const d = Math.max(Math.hypot(dx, dy), 1);
      const pull = ((d * d) / k) * weight;
      move[i]!.x -= (dx / d) * pull;
      move[i]!.y -= (dy / d) * pull;
      move[j]!.x += (dx / d) * pull;
      move[j]!.y += (dy / d) * pull;
    }
    for (let i = 0; i < n; i++) {
      // A gentle pull to the middle keeps unconnected characters near the rest.
      move[i]!.x -= pos[i]!.x * 0.06;
      move[i]!.y -= pos[i]!.y * 0.06;
      const length = Math.max(Math.hypot(move[i]!.x, move[i]!.y), 0.001);
      pos[i]!.x += (move[i]!.x / length) * Math.min(length, temperature);
      pos[i]!.y += (move[i]!.y / length) * Math.min(length, temperature);
    }
    temperature = Math.max(temperature * 0.985, 0.5);
  }
  // Fit the result into the box, without blowing a small graph up.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pos) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const margin = 48;
  const scale = Math.min(
    (width - margin * 2) / Math.max(maxX - minX, 1),
    (height - margin * 2) / Math.max(maxY - minY, 1),
    3,
  );
  const offsetX = (width - (maxX - minX) * scale) / 2;
  const offsetY = (height - (maxY - minY) * scale) / 2;
  ids.forEach((id, i) =>
    out.set(id, {
      x: offsetX + (pos[i]!.x - minX) * scale,
      y: offsetY + (pos[i]!.y - minY) * scale,
    }),
  );
  return out;
}
