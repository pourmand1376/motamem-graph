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
