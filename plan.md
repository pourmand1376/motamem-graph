# motamem.org Graph Generator — General Architecture

## Context

We want an Obsidian-style interactive graph of motamem.org's posts (nodes = posts,
edges = internal links between them), rendered with Sigma.js and served to visitors
as a static artifact so nobody computes layout in the browser.

The hard constraint discovered during planning: **we have no backend access, the
WordPress REST API is disabled (`rest_disabled`, 403), and the live site 403s all
non-browser clients** (WebFetch on the sitemap, feed, and pages all failed). So we
cannot pull data from motamem.org directly.

**The unlock:** the Internet Archive (Wayback Machine) has motamem.org thoroughly
captured and its CDX API + archived pages respond fine to plain HTTP from here.
Verified during planning:
- CDX API returns motamem.org URLs (Persian pretty-permalinks at the site root, e.g. `https://motamem.org/<persian-slug>/`).
- ~79k raw HTML captures → after filtering (drop query-strings, `/page/`, `/category|tag|author/`, `/wp-*`, `/feed|comment/`) → **~4,876 distinct real post URLs**.

So the whole pipeline sources **both nodes and edges from Wayback** — no live-site
crawl, no browser, no bot-blocking. Tradeoff: archived snapshots can lag, so very
recent posts may be under-represented (acceptable for v1; re-run periodically).

**Alternatives ruled out during planning:**
- *Pre-built downloadable graph* — does not exist for an arbitrary site; the internal
  link structure only lives inside each page's HTML (or a WordPress export file).
- *Common Crawl* — only **7 motamem.org pages** in the latest indexes (CC-MAIN-2026-30/25);
  the site's bot-protection blocks CCBot too. Its published web graph is domain-to-domain,
  never post-to-post. Unusable here.
- *WXR export* (Tools→Export in wp-admin) — the one true no-fetch source, but needs
  backend access we don't have. Chose the self-service Wayback fetch instead.
  (If an export is obtained later, it can replace stages 1–3; stages 4–5 are unchanged.)

## Architecture (4 stages + viewer)

```
Wayback CDX API ──► enumerate ──► urls.json         (nodes, ~4.9k)
                                     │
archived HTML  ──► fetch    ──► cache/*.html         (raw article HTML, resumable)
                                     │
                    parse    ──► graph-raw.json       (nodes + edges, no coords)
                                     │
                    layout   ──► public/graph.json    (ForceAtlas2 x/y baked in)
                                     │
                    viewer   ──► Sigma.js static page  (render only)
```

## Stack

Node.js end-to-end (graphology, ForceAtlas2, and Sigma are all JS — one toolchain).
- Fetch: built-in `fetch`. HTML parse: `cheerio`.
- Graph + layout: `graphology`, `graphology-layout-forceatlas2`.
- Viewer: `sigma` + `graphology`, bundled with `vite` (or esbuild).

## Project structure

```
motamem_graph_generator/
  package.json            # scripts: enumerate, fetch, parse, layout, build, viewer
  src/
    enumerate.js          # CDX → data/urls.json
    fetch.js              # urls.json → cache/ (latest snapshot per URL)
    parse.js              # cache/ → data/graph-raw.json
    layout.js             # graph-raw.json → public/graph.json
    lib/url.js            # canonicalize: double-decode UTF-8, lowercase, strip trailing slash
  data/                   # urls.json, graph-raw.json (intermediate)
  cache/                  # archived HTML, content-addressed (gitignored)
  viewer/
    index.html            # <div id="graph">, RTL, loads main.js
    main.js               # Sigma renderer
  public/graph.json       # final artifact (committable)
```
`npm run build` chains enumerate → fetch → parse → layout.

## Stage detail

**1. enumerate.js** — Query CDX:
`.../cdx?url=motamem.org&matchType=domain&output=json&filter=statuscode:200&filter=mimetype:text/html&collapse=urlkey&fl=original,timestamp`.
Apply the post filter (single root-level path segment; no query; exclude
`page|category|tag|author|wp-*|feed|comments|amp`). **Gotcha found during planning:**
the CDX list is polluted with *double-encoded* Persian URLs (UTF-8 of already-encoded
bytes) that the archive stored as ~550-byte redirect stubs — fetching one returned 182
bytes of nothing. Normalize by fully un-quoting each slug to canonical Persian, then
re-encoding once; dedupe on that canonical `id` and prefer the capture with the largest
`length` (the real page, ~200 KB, not the stub). Keep the newest good timestamp per id.
Write `data/urls.json` (`[{id, url, timestamp}]`).

**2. fetch.js** — For each URL, download the raw archived HTML via the `id_` variant
(no Wayback toolbar/rewrite): `https://web.archive.org/web/<timestamp>id_/<original>`.
Cache to `cache/<id>.html`; skip if cached (resumable). Politeness: concurrency cap
(~3–4), small delay, retry with backoff on 429/5xx. ~4.9k pages one-time, then cached.

**3. parse.js** — For each cached page: pull the **title** (`<h1 class="entry-title">`
or `<title>`, strip the " | متمم" suffix) and the internal links **from the article
body only**. Confirmed by inspecting a real archived post (postid-4498, "برند و
برندسازی"): the theme puts the authored article text in **`<div class="entry clearfix">`**,
and the auto-generated "related posts" widget (`div.wp_rp_content` / `ul.related_post`)
sits at the end and **must be excluded**. Measured effect on that page: whole-page =
157 motamem post-links (menu/sidebar/footer/related noise) vs **11 real edges** inside
`div.entry` after dropping the `wp_rp` block — and those 11 are all genuine topical
cross-references. Rule: parse with `cheerio`, select `div.entry`, remove any `.wp_rp_*`
nodes, take its `<a href>`, resolve each to a canonical root-level slug, keep an edge
only when the target is in the node set, dedupe undirected pairs. Write `data/graph-raw.json`.

**4. layout.js** — Load into graphology, `mergeEdge` to dedupe, **drop degree-0 orphans**,
size nodes by `sqrt(degree)`, seed with `circular`, run
`forceAtlas2.assign(graph, { iterations: 400, settings: { ...inferSettings(graph), barnesHutOptimize: true }})`.
Emit `public/graph.json` (`{nodes:[{id,label,url,x,y,size,color}], edges:[{source,target}]}`).

**5. viewer** — Static page: fetch `graph.json`, add nodes (coords already present) +
edges, `new Sigma(...)`. Interactions: hover → highlight neighbors + fade the rest
(node/edge reducers); `labelRenderedSizeThreshold` so labels appear only when zoomed in;
`clickNode` → `window.location = node.url` (opens the **live** motamem.org post). Persian
RTL labels render fine in Sigma's WebGL text.

## Decisions

- **Data source:** Wayback fetch, self-service (Common Crawl ruled out — 7 pages).
- **Edges:** internal links only, from inside `div.entry` (truest to the Obsidian
  metaphor). Shared-tag edges can be added later behind a flag.
- **Output:** standalone static viewer (no WP access to embed into the theme; can be
  iframed into a motamem.org page later).
- **Freshness:** Wayback-sourced, so slightly stale; re-run the pipeline periodically.
  If wp-admin access is obtained later, a WXR export can replace stages 1–3 for a fresh,
  complete graph with the same stages 4–5 downstream.

## Verification

- `enumerate`: `urls.json` has ~4–5k entries; spot-check a few `id`s decode to real Persian slugs and their `url` loads in a normal browser.
- `fetch`: a random `cache/<id>.html` contains the real article body (not a Wayback error page).
- `parse`: `graph-raw.json` edge count > node count; manually open one post, confirm its outbound internal links match the parsed edges for that node.
- `layout`: every node in `graph.json` has finite numeric `x`/`y` (no `NaN`); orphan count reported.
- `viewer`: `npm run viewer`, open in browser — graph renders, hover highlights a neighborhood, clicking a node opens the correct live post. Confirm it's smooth at ~4.9k nodes (WebGL should be fine).
