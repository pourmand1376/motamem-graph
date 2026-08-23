// Stage 4 — layout: data/graph-raw.json -> public/graph.json
//
// Cluster-aware ForceAtlas2. We add one invisible "hub" node per MAIN category and
// attract its members to it, so ForceAtlas2 pulls same-category nodes together while
// real links still shape within-cluster structure and pull related categories adjacent.
// The long tail of small categories (and uncategorized posts) get no hub and are placed
// purely by their links, so the few main clusters stand out. Hubs are removed at the end.
//
// Usage:  node src/layout.js
//   TOP_CLUSTERS=24  HUB_WEIGHT=4  FA2_ITERS=800  node src/layout.js

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IN = path.join(ROOT, 'data', 'graph-raw.json');
const OUT = path.join(ROOT, 'public', 'graph.json');

const ITERATIONS = Number(process.env.FA2_ITERS ?? 800);
const MIN_HUB = Number(process.env.MIN_HUB ?? 3);   // categories with >= this many posts get a cluster hub
const HUB_WEIGHT = Number(process.env.HUB_WEIGHT ?? 4);
const MUTED = '#c9c9d2';

// N visually distinct colors: evenly spaced hues, alternating lightness so neighbors differ.
function palette(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const hue = (i * 360) / n;
    const light = i % 2 ? 54 : 63;
    out.push(hslToHex(hue, 66, light));
  }
  return out;
}
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (x) => (x + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (x) => l - a * Math.max(-1, Math.min(k(x) - 3, Math.min(9 - k(x), 1)));
  const to = (x) => Math.round(255 * f(x)).toString(16).padStart(2, '0');
  return `#${to(0)}${to(8)}${to(4)}`;
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
      graph.mergeEdge(e.source, e.target, { weight: 1 });
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
    graph.addNode(HUB(c), { x: 800 * Math.cos(ang), y: 800 * Math.sin(ang), size: 0, hub: true });
  });
  const mainSet = new Set(main);
  graph.forEachNode((node, attr) => {
    if (attr.hub) return;
    // seed real nodes near their hub (or center), so FA2 converges cleanly
    const c = attr.category;
    if (c && mainSet.has(c)) {
      const h = graph.getNodeAttributes(HUB(c));
      attr.x = h.x + (hash(node) % 100) - 50;
      attr.y = h.y + (hash(node + 'y') % 100) - 50;
      graph.addEdge(node, HUB(c), { weight: HUB_WEIGHT });
    } else {
      attr.x = (hash(node) % 200) - 100;
      attr.y = (hash(node + 'y') % 200) - 100;
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

  // Emit.
  const out = {
    nodes: graph.mapNodes((id, a) => ({
      id, label: a.label, url: a.url,
      x: round(a.x), y: round(a.y),
      size: round(a.size), color: a.color,
      category: a.category, categories: a.categories,
    })),
    edges: graph.mapEdges((_e, _a, s, t) => ({ source: s, target: t })),
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
