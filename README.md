# motamem-graph

An **Obsidian-style interactive graph** of the posts on [motamem.org](https://motamem.org) —
each node is an article, each edge is an in-body link the author wrote from one article to
another. Explore it live, hover to light up a post's neighbours, click to open the post, and
tune the layout forces in the browser like Obsidian's graph view.

> **🔗 Live graph:** https://pourmand1376.github.io/motamem-graph/

![pipeline](https://img.shields.io/badge/pipeline-enumerate→fetch→parse→layout→viewer-6b7cff)

---

## Why it's built this way

motamem.org can't be read directly by a tool: its **WordPress REST API is disabled**
(`rest_disabled`, 403) and the live site **blocks non-browser clients** (bot protection —
the sitemap, feed, and pages all 403 automated fetchers). So the graph is rebuilt from the
**Internet Archive (Wayback Machine)**, which mirrors the site and answers plain HTTP happily.
Both nodes and edges come from Wayback — no live-site crawl, no browser, no bot-blocking.

Trade-off: archived snapshots can lag, so very recent posts may be under-represented. Re-run
the pipeline periodically to refresh.

## How it works — five stages

```
Wayback CDX API ──► enumerate ──► data/urls.json        (~4.8k posts)
archived HTML   ──► fetch     ──► cache/*.html           (resumable)
                    parse     ──► data/graph-raw.json    (nodes + editorial edges)
                    layout    ──► public/graph.json      (positions + clusters)
                    viewer    ──► public/app.js           (Sigma.js static viewer)
```

1. **enumerate** — query the Wayback CDX API for every archived HTML capture, filter to
   real posts (root-level Persian permalinks, dropping pagination / categories / feeds /
   double-encoded stubs), and keep the newest capture above a size floor per post.
2. **fetch** — download each post's archived HTML (`…id_/…` raw variant, no Wayback toolbar)
   into `cache/`. Resumable and polite; retries hard, logs failures.
3. **parse** — extract the title and **only the author's in-body links** from `div.entry`.
   Auto-generated noise is stripped: the related-posts widget, the course/series navigation
   (each lesson otherwise links all its siblings → 50-node cliques), and the
   Shortcodes-Ultimate promo/CTA/limitation boxes (`su-*`). Site chrome — top menu, sidebar
   widgets, header, footer — is never read, because only `div.entry` is parsed. Course
   categories are read from the `meta_categories` block (access/engagement labels dropped).
4. **layout** — cluster-aware **ForceAtlas2**: an invisible attraction hub per course category
   pulls same-category posts together while real links shape within-cluster structure and pull
   related courses adjacent. Every category is coloured; positions are baked in.
5. **viewer** — a static **Sigma.js** (WebGL) page. No layout runs for visitors; it just renders.

### What the numbers look like

- ~4,800 posts enumerated → ~4,800 archived pages fetched
- ~34k **editorial** edges after stripping boilerplate (median degree ~7 — a clean graph, not a hairball)
- 148 course categories, coloured; the larger ones labelled on the map

## The interactive viewer

- **Clusters** — nodes coloured by course category; big clusters show a floating name label
  (repositioned as you pan/zoom).
- **Live forces** (ForceAtlas2 in a web worker, Obsidian-style): repel, gravity, link strength,
  cluster cohesion, run/pause/reset. Seeded from the baked layout; runs only when you tweak it.
- **Display**: node size, label-fade threshold, edge opacity, colour-by-cluster toggle.
- **Filter**: search-to-focus, hide sparse nodes by link count.
- Hover highlights a post's neighbourhood; click opens the live post.

## Run it yourself

Requires Node.js and [`just`](https://github.com/casey/just) (optional).

```bash
just install          # or: npm install
just build            # enumerate → fetch → parse → layout → viewer
just serve            # preview at http://localhost:8080
```

Handy: `just regraph` rebuilds the graph + viewer from the existing cache (skips the ~4,800-page
download). Tuning knobs for the build layout are env vars: `MIN_HUB`, `HUB_WEIGHT`, `FA2_ITERS`.

## Data & hosting

The generated graph (`graph.json`) and the intermediate data are published as a
[GitHub Release](https://github.com/pourmand1376/motamem-graph/releases). The GitHub Pages site
pulls `graph.json` from the release at deploy time and serves it alongside the viewer, so the
repository itself stays source-only (the crawl cache and generated artifacts are git-ignored).

## Tech stack

Node.js · [cheerio](https://cheerio.js.org) (HTML parsing) ·
[graphology](https://graphology.github.io) + graphology-layout-forceatlas2 (graph + layout) ·
[Sigma.js](https://www.sigmajs.org) (WebGL rendering) · esbuild (bundling).

## Credits & disclaimer

Content belongs to **[motamem.org](https://motamem.org)** (Mohammadreza Shabanali and the
متمم team); this project only builds a navigational map of the public post graph from
Internet Archive snapshots and links back to the original posts. It is an unofficial,
fan-made visualization and is not affiliated with or endorsed by متمم.

🤖 **This project was created with AI** (Claude Code) — the pipeline design, code, and this
README were produced through an AI pair-programming session.
