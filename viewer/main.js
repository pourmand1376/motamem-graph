// Stage 5 — viewer: renders public/graph.json with Sigma.js. No layout is computed
// here; x/y come baked in. Bundled by esbuild to public/app.js.

import Graph from 'graphology';
import Sigma from 'sigma';

const container = document.getElementById('graph');
const statusEl = document.getElementById('status');
const searchInput = document.getElementById('search');
const searchList = document.getElementById('nodes');

async function main() {
  const res = await fetch('./graph.json');
  if (!res.ok) { statusEl.textContent = 'graph.json failed to load'; return; }
  const data = await res.json();

  const graph = new Graph();
  for (const n of data.nodes) graph.addNode(n.id, { ...n });
  for (const e of data.edges) { if (!graph.hasEdge(e.source, e.target)) graph.addEdge(e.source, e.target); }

  const renderer = new Sigma(graph, container, {
    labelRenderedSizeThreshold: 8,           // hub/zoom adaptive: only big-enough nodes get labels
    labelFont: 'Vazirmatn, Tahoma, sans-serif',
    labelColor: { color: '#222' },
    labelDensity: 0.6,
    labelGridCellSize: 80,
    defaultEdgeColor: '#e4e4ea',
    zIndex: true,
  });

  // ---- hover: highlight the node and its neighbors, fade the rest ----
  let active = null;
  const setActive = (node) => { active = node; renderer.refresh({ skipIndexation: true }); };

  renderer.setSetting('nodeReducer', (node, attr) => {
    if (!active) return attr;
    if (node === active) return { ...attr, zIndex: 2, highlighted: true };
    if (graph.areNeighbors(active, node)) return { ...attr, zIndex: 1 };
    return { ...attr, color: '#e8e8ee', label: '', zIndex: 0 };
  });
  renderer.setSetting('edgeReducer', (edge, attr) => {
    if (!active) return attr;
    return graph.hasExtremity(edge, active)
      ? { ...attr, color: '#9aa', zIndex: 1 }
      : { ...attr, hidden: true };
  });

  renderer.on('enterNode', ({ node }) => { container.style.cursor = 'pointer'; setActive(node); });
  renderer.on('leaveNode', () => { container.style.cursor = 'default'; setActive(null); });
  renderer.on('clickNode', ({ node }) => {
    const url = graph.getNodeAttribute(node, 'url');
    if (url) window.open(url, '_blank', 'noopener');
  });

  // ---- search: jump the camera to a post by title ----
  const byLabel = new Map();
  graph.forEachNode((id, attr) => {
    byLabel.set(attr.label, id);
    const opt = document.createElement('option');
    opt.value = attr.label;
    searchList.appendChild(opt);
  });
  searchInput.addEventListener('change', () => {
    const id = byLabel.get(searchInput.value.trim());
    if (!id) return;
    const p = renderer.getNodeDisplayData(id);
    renderer.getCamera().animate({ x: p.x, y: p.y, ratio: 0.08 }, { duration: 500 });
    setActive(id);
  });

  statusEl.textContent = `${graph.order.toLocaleString('fa-IR')} نوشته · ${graph.size.toLocaleString('fa-IR')} پیوند`;
}

main().catch((err) => {
  console.error(err);
  statusEl.textContent = 'error: ' + err.message;
});
