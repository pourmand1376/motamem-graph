// Stage 2 — fetch: data/urls.json -> cache/<id>.html
//
// Downloads each post's archived HTML from the Wayback Machine using the raw `id_`
// variant (no Wayback toolbar/rewrites). Resumable: already-cached pages are skipped.
// Failures are retried hard inline, then logged to data/fetch-failures.json so a
// re-run picks up only what's still missing.
//
// Usage:
//   node src/fetch.js               # fetch everything missing
//   node src/fetch.js --limit 30    # only first 30 posts (quick test)
//   node src/fetch.js --force       # re-fetch even if cached

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchText } from './lib/http.js';
import { cacheName } from './lib/cache.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URLS = path.join(ROOT, 'data', 'urls.json');
const CACHE_DIR = path.join(ROOT, 'cache');
const FAILS = path.join(ROOT, 'data', 'fetch-failures.json');

const CONCURRENCY = 6;
const MIN_BYTES = 5000;       // smaller than this = a Wayback error/placeholder page
const SIZE_ATTEMPTS = 3;      // "retry harder": re-pull if the body comes back too small

const args = process.argv.slice(2);
const argNum = (f) => { const i = args.indexOf(f); return i >= 0 ? Number(args[i + 1]) : undefined; };
const limit = argNum('--limit');
const force = args.includes('--force');

const rawUrl = (timestamp, original) => `https://web.archive.org/web/${timestamp}id_/${original}`;

// Fetch one post; returns { ok, bytes } or { ok:false, reason }.
async function fetchOne(post) {
  const file = path.join(CACHE_DIR, cacheName(post.id));

  if (!force) {
    try {
      const st = await fs.stat(file);
      if (st.size >= MIN_BYTES) return { ok: true, bytes: st.size, cached: true };
    } catch { /* not cached yet */ }
  }

  let lastReason = 'unknown';
  for (let attempt = 1; attempt <= SIZE_ATTEMPTS; attempt++) {
    try {
      const { status, text } = await fetchText(rawUrl(post.timestamp, post.original), {
        retries: 6,          // hard inline retry on 429/5xx/network (backoff inside fetchText)
        timeoutMs: 90000,
      });
      if (status >= 400) { lastReason = `HTTP ${status}`; continue; }
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes < MIN_BYTES) { lastReason = `too small (${bytes}B)`; continue; }
      await fs.writeFile(file, text, 'utf8');
      return { ok: true, bytes };
    } catch (err) {
      lastReason = err?.message || String(err);
    }
  }
  return { ok: false, reason: lastReason };
}

async function main() {
  let posts = JSON.parse(await fs.readFile(URLS, 'utf8'));
  if (limit) posts = posts.slice(0, limit);
  await fs.mkdir(CACHE_DIR, { recursive: true });

  console.log(`[fetch] ${posts.length} posts, concurrency=${CONCURRENCY}, min=${MIN_BYTES}B`);

  const failures = [];
  let ok = 0, cached = 0, done = 0;

  // Bounded worker pool over a shared cursor.
  let cursor = 0;
  async function worker() {
    while (cursor < posts.length) {
      const post = posts[cursor++];
      const r = await fetchOne(post);
      done++;
      if (r.ok) { ok++; if (r.cached) cached++; }
      else failures.push({ id: post.id, url: post.url, reason: r.reason });
      if (done % 100 === 0 || done === posts.length) {
        console.log(`[fetch]   ${done}/${posts.length}  ok=${ok} (cached ${cached})  failed=${failures.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  await fs.writeFile(FAILS, JSON.stringify(failures, null, 2));
  console.log(`[fetch] done: ${ok} ok, ${failures.length} failed`);
  if (failures.length) {
    console.log(`[fetch] failures logged -> ${path.relative(ROOT, FAILS)} (re-run to retry them)`);
  }
}

main().catch((err) => {
  console.error('[fetch] failed:', err);
  process.exit(1);
});
