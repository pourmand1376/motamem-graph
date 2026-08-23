// Stage 1 — enumerate: Wayback CDX -> data/urls.json
//
// Pulls every archived HTML capture of motamem.org, keeps only root-level posts,
// and for each post picks the NEWEST capture above a size floor (skips broken stubs).
//
// Usage:
//   node src/enumerate.js                 # full run
//   node src/enumerate.js --pages 2       # only first 2 CDX pages (quick test)
//   node src/enumerate.js --limit 50      # cap output to 50 posts (quick test)
//   SIZE_FLOOR=15000 node src/enumerate.js

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { postId, liveUrl, HOST } from './lib/url.js';
import { fetchText, pool } from './lib/http.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'urls.json');

const SIZE_FLOOR = Number(process.env.SIZE_FLOOR ?? 20000);
const args = process.argv.slice(2);
const argNum = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) : undefined;
};
const maxPages = argNum('--pages');
const limit = argNum('--limit');

const CDX = 'https://web.archive.org/cdx/search/cdx';
function cdxUrl(extra = {}) {
  const p = new URLSearchParams({
    url: HOST,
    matchType: 'domain',
    output: 'json',
    fl: 'original,timestamp,length',
    ...extra,
  });
  p.append('filter', 'statuscode:200');
  p.append('filter', 'mimetype:text/html');
  return `${CDX}?${p}`;
}

async function getNumPages() {
  // showNumPages only returns a bare integer for a CLEAN query — no output=json, no fl.
  const p = new URLSearchParams({ url: HOST, matchType: 'domain', showNumPages: 'true' });
  p.append('filter', 'statuscode:200');
  p.append('filter', 'mimetype:text/html');
  const { text } = await fetchText(`${CDX}?${p}`);
  const n = parseInt(text.trim(), 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`unexpected numPages response: ${text.slice(0, 80)}`);
  return n;
}

async function fetchPage(pageIdx) {
  const { text } = await fetchText(cdxUrl({ page: String(pageIdx) }));
  const trimmed = text.trim();
  if (!trimmed) return [];
  let rows;
  try {
    rows = JSON.parse(trimmed);
  } catch {
    return []; // occasional empty/garbled page — skip, next run can re-fetch
  }
  if (!Array.isArray(rows) || rows.length <= 1) return [];
  return rows.slice(1); // drop the header row [original,timestamp,length]
}

async function main() {
  console.log(`[enumerate] size floor = ${SIZE_FLOOR} bytes`);
  let numPages = await getNumPages();
  if (maxPages) numPages = Math.min(numPages, maxPages);
  console.log(`[enumerate] fetching ${numPages} CDX page(s)...`);

  // best[id] = { id, original, timestamp, length } — newest capture above the floor
  const best = new Map();
  let seenRows = 0;
  let keptRows = 0;

  const pageIdxs = Array.from({ length: numPages }, (_, i) => i);
  let done = 0;
  await pool(pageIdxs, 4, async (idx) => {
    const rows = await fetchPage(idx);
    for (const [original, timestamp, lengthStr] of rows) {
      seenRows++;
      const id = postId(original);
      if (!id) continue;
      const length = Number(lengthStr) || 0;
      if (length < SIZE_FLOOR) continue;
      keptRows++;
      const prev = best.get(id);
      if (!prev || timestamp > prev.timestamp) {
        best.set(id, { id, original, timestamp, length });
      }
    }
    done++;
    if (done % 5 === 0 || done === numPages) {
      console.log(`[enumerate]   ${done}/${numPages} pages, ${best.size} posts so far`);
    }
  });

  let posts = [...best.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => ({ id: p.id, url: liveUrl(p.id), original: p.original, timestamp: p.timestamp, length: p.length }));

  if (limit) posts = posts.slice(0, limit);

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(posts, null, 2));

  console.log(`[enumerate] scanned ${seenRows} captures, ${keptRows} above floor`);
  console.log(`[enumerate] wrote ${posts.length} posts -> ${path.relative(ROOT, OUT)}`);
}

main().catch((err) => {
  console.error('[enumerate] failed:', err);
  process.exit(1);
});
