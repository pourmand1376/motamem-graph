# motamem.org graph generator — task runner
# `just` lists recipes; run a stage with e.g. `just fetch`.

# Port for the local preview server
port := "8080"

# Show available recipes
default:
    @just --list

# Install dependencies
install:
    npm install

# Stage 1 — Wayback CDX -> data/urls.json
enumerate:
    npm run enumerate

# Stage 2 — download archived HTML -> cache/ (resumable)
fetch:
    npm run fetch

# Stage 3 — parse cached HTML -> data/graph-raw.json
parse:
    npm run parse

# Stage 4 — ForceAtlas2 layout + communities -> public/graph.json
layout:
    npm run layout

# Stage 5 — bundle the Sigma viewer -> public/app.js
viewer:
    npm run viewer:build

# Full pipeline: enumerate -> fetch -> parse -> layout -> viewer
build:
    npm run build

# Rebuild only the graph from the existing cache (skips fetch)
regraph:
    npm run parse && npm run layout && npm run viewer:build

# Serve public/ locally (open http://localhost:{{port}})
serve:
    PORT={{port}} npm run serve

# Remove generated artifacts (keeps the fetched cache)
clean:
    rm -rf public/app.js public/graph.json data/urls.json data/graph-raw.json data/fetch-failures.json

# Remove everything generated, including the archived-page cache
clean-all: clean
    rm -rf cache

# Upload graph data + packed HTML cache to the data-v1 GitHub Release
# (seeds CI so the monthly rebuild only fetches new posts)
data_tag := "data-v1"
publish-data:
    #!/usr/bin/env bash
    set -euo pipefail
    test -f public/graph.json || { echo "missing public/graph.json — run just build / just regraph first"; exit 1; }
    test -f data/graph-raw.json || { echo "missing data/graph-raw.json"; exit 1; }
    test -f data/urls.json || { echo "missing data/urls.json"; exit 1; }
    test -d cache || { echo "missing cache/ — run just fetch first"; exit 1; }
    echo "packing cache/ …"
    tar -czf /tmp/cache.tar.gz cache
    ls -lh /tmp/cache.tar.gz
    gh release upload "{{data_tag}}" \
      public/graph.json \
      data/graph-raw.json \
      data/urls.json \
      /tmp/cache.tar.gz \
      --clobber
    rm -f /tmp/cache.tar.gz
    echo "published to release {{data_tag}}"
