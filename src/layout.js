// Stage 4 — layout: data/graph-raw.json -> public/graph.json
//
// Cluster-aware ForceAtlas2. We add one invisible "hub" node per MAIN category and
// attract its members to it, so ForceAtlas2 pulls same-category nodes together while
// real links still shape within-cluster structure and pull related categories adjacent.
// The long tail of small categories (and uncategorized posts) get no hub and are placed
// purely by their links, so the few main clusters stand out. Hubs are removed at the end.
//
// Usage:  node src/layout.js
//   TOP_CLUSTERS=24  HUB_WEIGHT=10  REAL_EDGE_WEIGHT=0.35  FA2_ITERS=1600  node src/layout.js

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IN = path.join(ROOT, 'data', 'graph-raw.json');
const OUT = path.join(ROOT, 'public', 'graph.json');

const ITERATIONS = Number(process.env.FA2_ITERS ?? 1600);
const MIN_HUB = Number(process.env.MIN_HUB ?? 3);   // categories with >= this many posts get a cluster hub
const HUB_WEIGHT = Number(process.env.HUB_WEIGHT ?? 10);
const REAL_EDGE_WEIGHT = Number(process.env.REAL_EDGE_WEIGHT ?? 0.35);
const MUTED = '#c9c9d2';

// A high-contrast qualitative palette for the largest clusters.
// Smaller clusters reuse these hues with light/dark variants so the top clusters
// stay visually separated instead of collapsing into similar neighboring hues.
const BASE_COLORS = [
  '#e45756', '#4c78a8', '#54a24b', '#f58518', '#b279a2', '#72b7b2',
  '#eeca3b', '#ff9da6', '#9d755d', '#bab0ac', '#1f77b4', '#2ca02c',
  '#d62728', '#9467bd', '#8c564b', '#17becf', '#bcbd22', '#ff7f0e',
  '#7f7f7f', '#1b9e77', '#d95f02', '#7570b3', '#e7298a', '#66a61e',
];

function palette(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const base = BASE_COLORS[i % BASE_COLORS.length];
    const cycle = Math.floor(i / BASE_COLORS.length);
    out.push(tint(base, cycle));
  }
  return out;
}
function tint(hex, cycle) {
  if (cycle === 0) return hex;
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const mix = cycle % 2 ? 0.18 + Math.min(0.04 * cycle, 0.16) : -0.12 - Math.min(0.03 * cycle, 0.12);
  const blend = (v) => {
    const target = mix > 0 ? 255 : 0;
    return Math.round(v + (target - v) * Math.abs(mix));
  };
  return `#${[blend(r), blend(g), blend(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
const round = (n) => Math.round(n * 1000) / 1000;

async function main() {
  const raw = JSON.parse(await fs.readFile(IN, 'utf8'));
  const graph = new Graph({ type: 'undirected' });

  for (const n of raw.nodes) {
    graph.addNode(n.id, { label: n.label, url: n.url, categories: n.categories || [] });
  }
  for (const e of raw.edges) {
    if (graph.hasNode(e.source) && graph.hasNode(e.target) && e.source !== e.target) {
      graph.mergeEdge(e.source, e.target, { weight: REAL_EDGE_WEIGHT });
    }
  }

  // Drop true orphans.
  let dropped = 0;
  for (const node of graph.nodes()) {
    if (graph.degree(node) === 0) { graph.dropNode(node); dropped++; }
  }
  console.log(`[layout] ${graph.order} nodes, ${graph.size} edges (dropped ${dropped} orphans)`);

  // Primary category + membership counts.
  const count = new Map();
  graph.forEachNode((node, attr) => {
    attr.category = attr.categories.length ? attr.categories[0] : null;
    if (attr.category) count.set(attr.category, (count.get(attr.category) || 0) + 1);
  });

  // Color EVERY category distinctly (uncategorized = gray). Bigger categories first so
  // adjacent hues differ for the ones the eye lands on most.
  const allCats = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const colors = palette(allCats.length);
  const colorOf = new Map(allCats.map((c, i) => [c, colors[i]]));
  graph.forEachNode((node, attr) => {
    attr.color = colorOf.get(attr.category) || MUTED;
  });

  // Every category big enough gets a cluster hub for the initial seed layout.
  const main = allCats.filter((c) => count.get(c) >= MIN_HUB);
  console.log(`[layout] ${allCats.length} categories, ${main.length} seeded as clusters (>=${MIN_HUB} posts)`);

  // Size by degree (sqrt, clamped).
  let maxDeg = 1;
  graph.forEachNode((node) => { maxDeg = Math.max(maxDeg, graph.degree(node)); });
  const MIN = 2, MAX = 22;
  graph.forEachNode((node, attr) => {
    attr.size = MIN + (MAX - MIN) * (Math.sqrt(graph.degree(node)) / Math.sqrt(maxDeg));
  });

  // ---- Build augmented graph with invisible category hubs, then run FA2 ----
  const HUB = (c) => `__hub__${c}`;
  main.forEach((c, i) => {
    // seed hubs on a wide circle so clusters start separated
    const ang = (i / main.length) * 2 * Math.PI;
    graph.addNode(HUB(c), { x: 450 * Math.cos(ang), y: 450 * Math.sin(ang), size: 0, hub: true });
  });
  const mainSet = new Set(main);
  graph.forEachNode((node, attr) => {
    if (attr.hub) return;
    // seed real nodes near their hub (or center), so FA2 converges cleanly
    const c = attr.category;
    if (c && mainSet.has(c)) {
      const h = graph.getNodeAttributes(HUB(c));
      attr.x = h.x + (hash(node) % 40) - 20;
      attr.y = h.y + (hash(node + 'y') % 40) - 20;
      graph.addEdge(node, HUB(c), { weight: HUB_WEIGHT });
    } else {
      attr.x = (hash(node) % 80) - 40;
      attr.y = (hash(node + 'y') % 80) - 40;
    }
  });

  const settings = forceAtlas2.inferSettings(graph);
  console.log(`[layout] ForceAtlas2 (${ITERATIONS} iters, weighted, barnesHut)...`);
  forceAtlas2.assign(graph, {
    iterations: ITERATIONS,
    getEdgeWeight: 'weight',
    settings: {
      ...settings,
      barnesHutOptimize: true,
      adjustSizes: true,
      outboundAttractionDistribution: true, // spreads high-degree hub/directory nodes
    },
  });

  // Remove hubs; keep real node positions.
  for (const c of main) graph.dropNode(HUB(c));

  // Cluster-level data (Sigma "clusters" shape): one entry per category with its
  // colour, member count, and barycenter (x,y) — computed from final node positions.
  const cmap = new Map();
  graph.forEachNode((id, a) => {
    if (!a.category) return;
    let c = cmap.get(a.category);
    if (!c) { c = { key: a.category, label: a.category, color: colorOf.get(a.category) || MUTED, sumx: 0, sumy: 0, size: 0 }; cmap.set(a.category, c); }
    c.sumx += a.x; c.sumy += a.y; c.size += 1;
  });
  const clusters = [...cmap.values()]
    .map((c) => ({ key: c.key, label: c.label, color: c.color, size: c.size, x: round(c.sumx / c.size), y: round(c.sumy / c.size) }))
    .sort((a, b) => b.size - a.size);
  console.log(`[layout] ${clusters.length} clusters emitted`);

  // Emit.
  const out = {
    nodes: graph.mapNodes((id, a) => ({
      id, label: a.label, url: a.url,
      x: round(a.x), y: round(a.y),
      size: round(a.size), color: a.color,
      category: a.category, categories: a.categories,
    })),
    edges: graph.mapEdges((_e, _a, s, t) => ({ source: s, target: t })),
    clusters,
  };
  const bad = out.nodes.filter((n) => !Number.isFinite(n.x) || !Number.isFinite(n.y)).length;
  if (bad) throw new Error(`${bad} nodes have non-finite coordinates`);

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(out));
  const kb = (Buffer.byteLength(JSON.stringify(out)) / 1024).toFixed(0);
  console.log(`[layout] wrote ${out.nodes.length} nodes, ${out.edges.length} edges (${kb} KB) -> ${path.relative(ROOT, OUT)}`);
}

// Small deterministic hash for reproducible seeding (no Math.random).
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}

main().catch((err) => {
  console.error('[layout] failed:', err);
  process.exit(1);
});
