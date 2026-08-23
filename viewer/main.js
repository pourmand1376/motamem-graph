// Stage 5 — viewer: renders public/graph.json with Sigma.js.
// Obsidian-style: live ForceAtlas2 (web worker) driven by a controls panel, cluster
// name labels floating at each cluster barycenter, and live display/filter knobs.
// Positions come pre-baked from the build; the sim only runs when the user asks.

import Graph from 'graphology';
import Sigma from 'sigma';
import FA2Layout from 'graphology-layout-forceatlas2/worker';

const el = (id) => document.getElementById(id);
const container = el('graph');
const clustersEl = el('clusters');
const statusEl = el('status');
const MUTED = '#c9c9d2';
const MIN_HUB = 3;

const state = { nodeSize: 1, colorClusters: true, edgeOpacity: 0.55, minDegree: 0, active: null, pinned: null };
let baseStatus = '';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function main() {
  const data = await (await fetch('./graph.json')).json();

  const graph = new Graph();
  for (const n of data.nodes) graph.addNode(n.id, { ...n, baseSize: n.size });
  for (const e of data.edges) if (!graph.hasEdge(e.source, e.target)) graph.addEdge(e.source, e.target, { weight: 1 });
  graph.forEachNode((id) => graph.setNodeAttribute(id, 'degree', graph.degree(id)));

  // Group nodes by category (for hubs + cluster labels).
  const cats = new Map();
  graph.forEachNode((id, a) => {
    if (!a.category) return;
    if (!cats.has(a.category)) cats.set(a.category, { nodes: [], color: a.color });
    cats.get(a.category).nodes.push(id);
  });

  // Invisible cohesion hubs (rebuilt here so graph.json stays clean).
  for (const [cat, c] of cats) {
    if (c.nodes.length < MIN_HUB) continue;
    const [cx, cy] = centroid(c.nodes);
    const hid = `__hub__${cat}`;
    graph.addNode(hid, { x: cx, y: cy, size: 0, isHub: true });
    for (const id of c.nodes) graph.addEdge(hid, id, { weight: 4, isHub: true });
  }

  function centroid(ids) {
    let x = 0, y = 0;
    for (const id of ids) { x += graph.getNodeAttribute(id, 'x'); y += graph.getNodeAttribute(id, 'y'); }
    return [x / ids.length, y / ids.length];
  }

  // ---------- Sigma ----------
  const renderer = new Sigma(graph, container, {
    labelRenderedSizeThreshold: 8,
    labelFont: 'Vazirmatn, Tahoma, sans-serif',
    labelColor: { color: '#222' },
    defaultEdgeColor: `rgba(150,150,165,${state.edgeOpacity})`,
    zIndex: true,
  });

  renderer.setSetting('nodeReducer', (node, a) => {
    if (a.isHub) return { ...a, hidden: true };
    const res = { ...a, size: a.baseSize * state.nodeSize };
    if (!state.colorClusters) res.color = a.category ? '#9a9aa6' : MUTED;
    if (state.minDegree && a.degree < state.minDegree) { res.hidden = true; return res; }
    if (state.active) {
      if (node === state.active) { res.zIndex = 2; res.highlighted = true; }
      else if (graph.areNeighbors(state.active, node)) { res.zIndex = 1; }
      else { res.color = '#e8e8ee'; res.label = ''; res.zIndex = 0; }
    }
    return res;
  });
  renderer.setSetting('edgeReducer', (edge, a) => {
    if (graph.getEdgeAttribute(edge, 'isHub')) return { ...a, hidden: true };
    if (state.active) {
      return graph.hasExtremity(edge, state.active)
        ? { ...a, color: '#8890b0', zIndex: 1 }
        : { ...a, hidden: true };
    }
    return a;
  });

  // ---------- cluster labels (DOM overlay at barycenters) ----------
  const labelState = { show: true, min: 15 };
  const labelEls = new Map();
  const darken = (hex, f = 0.55) => {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.round(((n >> 16) & 255) * f), g = Math.round(((n >> 8) & 255) * f), b = Math.round((n & 255) * f);
    return `rgb(${r},${g},${b})`;
  };
  function buildLabels() {
    clustersEl.innerHTML = '';
    labelEls.clear();
    for (const [cat, c] of cats) {
      if (c.nodes.length < labelState.min) continue;
      const d = document.createElement('div');
      d.className = 'cluster-label';
      d.textContent = cat;
      d.style.color = darken(c.color);           // tint the label with a darker shade of the cluster colour
      d.style.fontSize = `${Math.max(12, Math.min(28, 10 + Math.sqrt(c.nodes.length)))}px`;
      clustersEl.appendChild(d);
      labelEls.set(cat, d);
    }
  }
  function placeLabels() {
    clustersEl.style.display = labelState.show ? '' : 'none';
    if (!labelState.show) return;
    for (const [cat, d] of labelEls) {
      const [x, y] = centroid(cats.get(cat).nodes);
      const p = renderer.graphToViewport({ x, y });
      d.style.left = `${p.x}px`;
      d.style.top = `${p.y}px`;
    }
  }
  renderer.on('afterRender', placeLabels);

  // ---------- live ForceAtlas2 ----------
  let layout = null, running = false;
  const fa2Settings = () => ({
    scalingRatio: Number(el('repel').value),
    gravity: Number(el('gravity').value),
    edgeWeightInfluence: 1,
    barnesHutOptimize: true,
    adjustSizes: true,
    outboundAttractionDistribution: true,
    slowDown: 2,
  });
  function applyWeights() {
    const link = Number(el('link').value), coh = Number(el('cohesion').value);
    graph.forEachEdge((e, a) => graph.setEdgeAttribute(e, 'weight', a.isHub ? coh : link));
  }
  function rebuildLayout() {
    if (layout) { layout.kill(); layout = null; }
    applyWeights();
    try {
      layout = new FA2Layout(graph, { settings: fa2Settings(), getEdgeWeight: 'weight' });
      if (running) layout.start();
    } catch (err) {
      console.error('layout worker failed', err);
      statusEl.textContent = 'شبیه‌سازی در دسترس نیست';
    }
  }
  function setRunning(on) {
    running = on;
    const b = el('run');
    b.classList.toggle('on', on);
    b.textContent = on ? '⏸ توقف شبیه‌سازی' : '▶ اجرای شبیه‌سازی';
    if (on) { if (!layout) rebuildLayout(); layout && layout.start(); }
    else layout && layout.stop();
  }
  el('run').onclick = () => setRunning(!running);
  el('reset').onclick = () => {
    setRunning(false);
    for (const n of data.nodes) { graph.setNodeAttribute(n.id, 'x', n.x); graph.setNodeAttribute(n.id, 'y', n.y); }
    for (const [cat, c] of cats) {
      const hid = `__hub__${cat}`;
      if (!graph.hasNode(hid)) continue;
      const [cx, cy] = centroid(c.nodes);
      graph.setNodeAttribute(hid, 'x', cx); graph.setNodeAttribute(hid, 'y', cy);
    }
    renderer.refresh();
  };

  // ---------- controls ----------
  const debounce = (fn, ms = 180) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const onForce = debounce(() => { running ? rebuildLayout() : setRunning(true); });
  ['repel', 'gravity', 'link', 'cohesion'].forEach((id) =>
    el(id).addEventListener('input', () => { updateVals(); onForce(); }));

  el('nodeSize').addEventListener('input', () => { state.nodeSize = +el('nodeSize').value; updateVals(); renderer.refresh({ skipIndexation: true }); });
  el('labelThreshold').addEventListener('input', () => { renderer.setSetting('labelRenderedSizeThreshold', +el('labelThreshold').value); updateVals(); });
  el('edgeOpacity').addEventListener('input', () => { state.edgeOpacity = +el('edgeOpacity').value; renderer.setSetting('defaultEdgeColor', `rgba(150,150,165,${state.edgeOpacity})`); updateVals(); renderer.refresh({ skipIndexation: true }); });
  el('colorClusters').addEventListener('change', () => { state.colorClusters = el('colorClusters').checked; renderer.refresh({ skipIndexation: true }); });
  el('clusterLabels').addEventListener('change', () => { labelState.show = el('clusterLabels').checked; placeLabels(); });
  el('clusterMin').addEventListener('input', () => { labelState.min = +el('clusterMin').value; updateVals(); buildLabels(); placeLabels(); });
  el('minDegree').addEventListener('input', () => { state.minDegree = +el('minDegree').value; updateVals(); renderer.refresh({ skipIndexation: true }); });

  function updateVals() {
    el('v-repel').textContent = el('repel').value;
    el('v-gravity').textContent = el('gravity').value;
    el('v-link').textContent = el('link').value;
    el('v-cohesion').textContent = el('cohesion').value;
    el('v-size').textContent = `${el('nodeSize').value}×`;
    el('v-label').textContent = el('labelThreshold').value;
    el('v-edge').textContent = el('edgeOpacity').value;
    el('v-clmin').textContent = el('clusterMin').value;
    el('v-deg').textContent = el('minDegree').value;
  }

  // ---------- selection + related-lessons panel ----------
  const selectedEl = el('selected');
  function renderRelated(id) {
    const a = graph.getNodeAttributes(id);
    const neighbors = graph.neighbors(id)
      .filter((n) => !graph.getNodeAttribute(n, 'isHub'))
      .sort((x, y) => graph.degree(y) - graph.degree(x));
    const rows = neighbors.map((n) => {
      const na = graph.getNodeAttributes(n);
      return `<li data-id="${encodeURIComponent(n)}"><span class="dot" style="background:${na.color}"></span>`
        + `<span class="t" title="${esc(na.label)}">${esc(na.label)}</span>`
        + `<a class="open" href="${esc(na.url)}" target="_blank" rel="noopener" title="باز کردن نوشته">↗</a></li>`;
    }).join('');
    selectedEl.innerHTML =
      `<div class="sel-title">${esc(a.label)} <a href="${esc(a.url)}" target="_blank" rel="noopener">باز کردن ↗</a></div>`
      + `<div class="sel-sub">${a.category ? esc(a.category) + ' · ' : ''}${neighbors.length.toLocaleString('fa-IR')} نوشتهٔ مرتبط</div>`
      + `<ul>${rows || '<li class="t">بدون پیوند</li>'}</ul>`;
    selectedEl.hidden = false;
    selectedEl.querySelectorAll('li[data-id]').forEach((li) => {
      li.addEventListener('click', (e) => {
        if (e.target.closest('a.open')) return; // let the ↗ link open the post
        selectNode(decodeURIComponent(li.getAttribute('data-id')), true);
      });
    });
  }
  function selectNode(id, focus) {
    state.pinned = state.active = id;
    if (focus) {
      const p = renderer.getNodeDisplayData(id);
      renderer.getCamera().animate({ x: p.x, y: p.y, ratio: 0.06 }, { duration: 500 });
    }
    renderer.refresh({ skipIndexation: true });
    renderRelated(id);
  }

  // ---------- hover + click + search ----------
  renderer.on('enterNode', ({ node }) => {
    if (graph.getNodeAttribute(node, 'isHub')) return;
    state.active = node; container.style.cursor = 'pointer';
    renderer.refresh({ skipIndexation: true });
    const a = graph.getNodeAttributes(node);
    statusEl.textContent = a.category ? `${a.label}  ·  ${a.category}` : a.label;
  });
  renderer.on('leaveNode', () => {
    state.active = state.pinned; container.style.cursor = 'default';
    renderer.refresh({ skipIndexation: true });
    statusEl.textContent = baseStatus;
  });
  renderer.on('clickNode', ({ node }) => {
    if (graph.getNodeAttribute(node, 'isHub')) return;
    selectNode(node, false); // pin it + show related; use the panel's ↗ to open the post
  });

  const byLabel = new Map();
  graph.forEachNode((id, a) => {
    if (a.isHub) return;
    byLabel.set(a.label, id);
    const opt = document.createElement('option'); opt.value = a.label; el('nodes').appendChild(opt);
  });
  el('search').addEventListener('change', () => {
    const id = byLabel.get(el('search').value.trim());
    if (id) selectNode(id, true);
  });

  // ---------- init ----------
  buildLabels();
  updateVals();
  placeLabels();
  baseStatus = `${data.nodes.length.toLocaleString('fa-IR')} نوشته · ${data.edges.length.toLocaleString('fa-IR')} پیوند · ${cats.size.toLocaleString('fa-IR')} خوشه`;
  statusEl.textContent = baseStatus;
}

main().catch((err) => { console.error(err); statusEl.textContent = 'خطا: ' + err.message; });
