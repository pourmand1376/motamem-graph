// Stage 5 — viewer: renders public/graph.json with Sigma.js.
// Two tabs share the same graph data:
//   • "نقشه"  — the full Obsidian-style map: live ForceAtlas2 (web worker) driven by a
//               controls panel, floating cluster labels, live display/filter knobs.
//   • "جستجو" — a lightweight search-as-you-type list + related-articles panel, no Sigma
//               render, meant for mobile and small screens.
// Sigma is initialised lazily the first time the map tab is opened. Theme (light/dark) and
// the active tab persist to localStorage; theme defaults from prefers-color-scheme.

import Graph from 'graphology';
import Sigma from 'sigma';
import FA2Layout from 'graphology-layout-forceatlas2/worker';

const el = (id) => document.getElementById(id);
const container = el('graph');
const clustersEl = el('clusters');
const statusEl = el('status');
const MIN_HUB = 3;

// Theme-dependent colours used by the Sigma reducers and the cluster labels.
const THEMES = {
  light: { muted: '#c9c9d2', dim: '#e8e8ee', neighborEdge: '#8890b0', label: '#222', labelTint: (c) => shade(c, 0.55) },
  dark:  { muted: '#4a4a58', dim: '#2a2a33', neighborEdge: '#7f88b8', label: '#d8d8e2', labelTint: (c) => shade(c, 1.55) },
};

const state = { nodeSize: 1, colorClusters: true, edgeOpacity: 0.55, minDegree: 0, active: null, pinned: null };
let theme = THEMES.light;
let baseStatus = '';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Scale a #rrggbb colour toward black (f<1) or white (f>1); clamps each channel to 0–255.
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const r = ch(((n >> 16) & 255) * f), g = ch(((n >> 8) & 255) * f), b = ch((n & 255) * f);
  return `rgb(${r},${g},${b})`;
}

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

  baseStatus = `${data.nodes.length.toLocaleString('fa-IR')} نوشته · ${data.edges.length.toLocaleString('fa-IR')} پیوند · ${cats.size.toLocaleString('fa-IR')} خوشه`;

  // Sorted [label, id] index — shared by both search boxes.
  const index = [];
  graph.forEachNode((id, a) => { if (!a.isHub) index.push([a.label, id]); });
  index.sort((x, y) => x[0].localeCompare(y[0], 'fa'));
  const byLabel = new Map(index.map(([label, id]) => [label, id]));

  // ---------- shared related-lessons rendering ----------
  // Builds the inner HTML for a node's related list; used by the map panel and the lite view.
  function relatedHTML(id) {
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
    return `<div class="rel-title">${esc(a.label)} <a href="${esc(a.url)}" target="_blank" rel="noopener">باز کردن ↗</a></div>`
      + `<div class="rel-sub">${a.category ? esc(a.category) + ' · ' : ''}${neighbors.length.toLocaleString('fa-IR')} نوشتهٔ مرتبط</div>`
      + `<ul>${rows || '<li class="t">بدون پیوند</li>'}</ul>`;
  }
  // Wire neighbour clicks in a rendered related list to `onPick`.
  function wireRelated(scope, onPick) {
    scope.querySelectorAll('li[data-id]').forEach((li) => {
      li.addEventListener('click', (e) => {
        if (e.target.closest('a.open')) return; // let the ↗ link open the post
        onPick(decodeURIComponent(li.getAttribute('data-id')));
      });
    });
  }

  // ====================================================================
  // Lite search view — works without Sigma so it stays cheap on mobile.
  // ====================================================================
  el('liteSub').textContent = baseStatus;
  const liteResults = el('liteResults');
  const liteSelected = el('liteSelected');

  function showLite(id) {
    liteSelected.innerHTML = `<div class="rel"></div>`;
    const rel = liteSelected.firstElementChild;
    rel.innerHTML = relatedHTML(id);
    wireRelated(rel, (n) => { showLite(n); liteSelected.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  }
  function renderLiteResults(q) {
    const query = q.trim().toLowerCase();
    if (!query) { liteResults.innerHTML = ''; return; }
    const hits = [];
    for (const [label, id] of index) {
      if (label.toLowerCase().includes(query)) { hits.push([label, id]); if (hits.length >= 40) break; }
    }
    if (!hits.length) { liteResults.innerHTML = '<li class="empty">نوشته‌ای پیدا نشد.</li>'; return; }
    liteResults.innerHTML = hits.map(([label, id]) => {
      const color = graph.getNodeAttribute(id, 'color') || theme.muted;
      return `<li data-id="${encodeURIComponent(id)}"><span class="dot" style="background:${color}"></span>`
        + `<span class="t" title="${esc(label)}">${esc(label)}</span></li>`;
    }).join('');
    liteResults.querySelectorAll('li[data-id]').forEach((li) =>
      li.addEventListener('click', () => showLite(decodeURIComponent(li.getAttribute('data-id')))));
  }
  el('searchLite').addEventListener('input', (e) => renderLiteResults(e.target.value));

  // ====================================================================
  // Full map view (Sigma) — initialised lazily on first open.
  // ====================================================================
  let renderer = null, sigmaReady = false;
  const labelState = { show: true, min: 15 };
  const labelEls = new Map();
  let placeLabels = () => {};
  let refreshTheme = () => {};

  function initSigma() {
    if (sigmaReady) return;
    sigmaReady = true;

    renderer = new Sigma(graph, container, {
      labelRenderedSizeThreshold: 8,
      labelFont: 'Vazirmatn, Tahoma, sans-serif',
      labelColor: { color: theme.label },
      defaultEdgeColor: `rgba(150,150,165,${state.edgeOpacity})`,
      zIndex: true,
    });

    renderer.setSetting('nodeReducer', (node, a) => {
      if (a.isHub) return { ...a, hidden: true };
      const res = { ...a, size: a.baseSize * state.nodeSize };
      if (!state.colorClusters) res.color = a.category ? '#9a9aa6' : theme.muted;
      if (state.minDegree && a.degree < state.minDegree) { res.hidden = true; return res; }
      if (state.active) {
        if (node === state.active) { res.zIndex = 2; res.highlighted = true; }
        else if (graph.areNeighbors(state.active, node)) { res.zIndex = 1; }
        else { res.color = theme.dim; res.label = ''; res.zIndex = 0; }
      }
      return res;
    });
    renderer.setSetting('edgeReducer', (edge, a) => {
      if (graph.getEdgeAttribute(edge, 'isHub')) return { ...a, hidden: true };
      if (state.active) {
        return graph.hasExtremity(edge, state.active)
          ? { ...a, color: theme.neighborEdge, zIndex: 1 }
          : { ...a, hidden: true };
      }
      return a;
    });

    // ---------- cluster labels (DOM overlay at barycenters) ----------
    function buildLabels() {
      clustersEl.innerHTML = '';
      labelEls.clear();
      for (const [cat, c] of cats) {
        if (c.nodes.length < labelState.min) continue;
        const d = document.createElement('div');
        d.className = 'cluster-label';
        d.textContent = cat;
        d.style.color = theme.labelTint(c.color);   // tint with a theme-appropriate shade of the cluster colour
        d.style.fontSize = `${Math.max(12, Math.min(28, 10 + Math.sqrt(c.nodes.length)))}px`;
        clustersEl.appendChild(d);
        labelEls.set(cat, d);
      }
    }
    placeLabels = function () {
      clustersEl.style.display = labelState.show ? '' : 'none';
      if (!labelState.show) return;
      for (const [cat, d] of labelEls) {
        const [x, y] = centroid(cats.get(cat).nodes);
        const p = renderer.graphToViewport({ x, y });
        d.style.left = `${p.x}px`;
        d.style.top = `${p.y}px`;
      }
    };
    renderer.on('afterRender', placeLabels);

    // Re-apply theme-dependent Sigma settings + relabel (called on theme switch).
    refreshTheme = function () {
      if (!renderer) return;
      renderer.setSetting('labelColor', { color: theme.label });
      buildLabels();
      renderer.refresh({ skipIndexation: true });
      placeLabels();
    };

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

    // ---------- selection + related-lessons panel ----------
    const selectedEl = el('selected');
    function renderRelated(id) {
      selectedEl.innerHTML = relatedHTML(id);
      selectedEl.hidden = false;
      wireRelated(selectedEl, (n) => selectNode(n, true));
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

    for (const [label] of index) {
      const opt = document.createElement('option'); opt.value = label; el('nodes').appendChild(opt);
    }
    el('search').addEventListener('change', () => {
      const id = byLabel.get(el('search').value.trim());
      if (id) selectNode(id, true);
    });

    buildLabels();
    updateVals();
    placeLabels();
    statusEl.textContent = baseStatus;
  }

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

  // ====================================================================
  // Tabs + theme
  // ====================================================================
  const graphView = el('graphView'), searchView = el('searchView');
  function setTab(tab) {
    const isGraph = tab === 'graph';
    graphView.hidden = !isGraph;
    searchView.hidden = isGraph;
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    localStorage.setItem('mm.tab', tab);
    if (isGraph) { initSigma(); if (renderer) { renderer.refresh(); placeLabels(); } }
    else el('searchLite').focus();
  }
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  function setTheme(name) {
    theme = THEMES[name] || THEMES.light;
    document.documentElement.setAttribute('data-theme', name);
    el('themeToggle').textContent = name === 'dark' ? '☀️' : '🌙';
    localStorage.setItem('mm.theme', name);
    refreshTheme();
  }
  el('themeToggle').addEventListener('click', () =>
    setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));

  // ---------- init: restore theme + tab (small screens default to the search tab) ----------
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  setTheme(localStorage.getItem('mm.theme') || (prefersDark ? 'dark' : 'light'));

  const smallScreen = window.matchMedia && window.matchMedia('(max-width: 720px)').matches;
  setTab(localStorage.getItem('mm.tab') || (smallScreen ? 'search' : 'graph'));
}

main().catch((err) => { console.error(err); statusEl.textContent = 'خطا: ' + err.message; });
