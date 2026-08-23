// Stage 4 — layout: data/graph-raw.json -> public/graph.json
//
// Loads the raw node/edge graph, drops true orphans (degree 0), detects communities
// (Louvain) for coloring, sizes nodes by degree, and bakes in ForceAtlas2 x/y so the
// browser renders without computing any layout.
//
// Usage:  node src/layout.js

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Graph from 'graphology';
import { circular } from 'graphology-layout';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import louvain from 'graphology-communities-louvain';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IN = path.join(ROOT, 'data', 'graph-raw.json');
const OUT = path.join(ROOT, 'public', 'graph.json');
const ITERATIONS = Number(process.env.FA2_ITERS ?? 600);

// Distinct, stable color per community via golden-angle hue spacing.
function communityColor(index) {
  const hue = (index * 137.508) % 360;
  return hslToHex(hue, 62, 58);
}
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (n) => Math.round(255 * f(n)).toString(16).padStart(2, '0');
  return `#${to(0)}${to(8)}${to(4)}`;
}

async function main() {
  const raw = JSON.parse(await fs.readFile(IN, 'utf8'));
  const graph = new Graph({ type: 'undirected' });

  for (const n of raw.nodes) graph.addNode(n.id, { label: n.label, url: n.url });
  for (const e of raw.edges) {
    if (graph.hasNode(e.source) && graph.hasNode(e.target) && e.source !== e.target) {
      graph.mergeEdge(e.source, e.target);
    }
  }

  // Drop true orphans (no links). Small connected clusters are kept.
  let dropped = 0;
  for (const node of graph.nodes()) {
    if (graph.degree(node) === 0) { graph.dropNode(node); dropped++; }
  }
  console.log(`[layout] ${graph.order} nodes, ${graph.size} edges (dropped ${dropped} orphans)`);

  // Communities (Louvain) -> color.
  louvain.assign(graph, { resolution: 1 });
  const communities = new Set();
  graph.forEachNode((_, attr) => communities.add(attr.community));
  const palette = new Map([...communities].map((c, i) => [c, communityColor(i)]));
  console.log(`[layout] ${communities.size} communities detected`);

  // Size by degree (sqrt scale, clamped so hubs don't dominate).
  let maxDeg = 1;
  graph.forEachNode((node) => { maxDeg = Math.max(maxDeg, graph.degree(node)); });
  const MIN = 2, MAX = 22;
  graph.forEachNode((node, attr) => {
    const d = graph.degree(node);
    attr.size = MIN + (MAX - MIN) * (Math.sqrt(d) / Math.sqrt(maxDeg));
    attr.color = palette.get(attr.community);
  });

  // Deterministic seed, then ForceAtlas2.
  circular.assign(graph);
  const settings = forceAtlas2.inferSettings(graph);
  console.log(`[layout] running ForceAtlas2 (${ITERATIONS} iterations, barnesHut)...`);
  forceAtlas2.assign(graph, {
    iterations: ITERATIONS,
    settings: { ...settings, barnesHutOptimize: true, adjustSizes: true },
  });

  // Emit render-ready graph.
  const out = {
    nodes: graph.mapNodes((id, a) => ({
      id, label: a.label, url: a.url,
      x: round(a.x), y: round(a.y),
      size: round(a.size), color: a.color, community: a.community,
    })),
    edges: graph.mapEdges((_e, _a, s, t) => ({ source: s, target: t })),
  };

  // sanity: no NaN coordinates
  const bad = out.nodes.filter((n) => !Number.isFinite(n.x) || !Number.isFinite(n.y)).length;
  if (bad) throw new Error(`${bad} nodes have non-finite coordinates`);

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(out));
  const kb = (Buffer.byteLength(JSON.stringify(out)) / 1024).toFixed(0);
  console.log(`[layout] wrote ${out.nodes.length} nodes, ${out.edges.length} edges (${kb} KB) -> ${path.relative(ROOT, OUT)}`);
}

const round = (n) => Math.round(n * 1000) / 1000;

main().catch((err) => {
  console.error('[layout] failed:', err);
  process.exit(1);
});
