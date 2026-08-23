// URL canonicalization for motamem.org archived pages.
//
// The Wayback CDX list mixes two encodings of the same Persian post:
//   - single-encoded (the real page):   /%D8%A8%D8%B1%D9%86%D8%AF/   -> "برند"
//   - double-encoded (a broken stub):   /%C3%98%C2%A8.../            -> "برند" too
// We normalize both to one canonical slug so a post appears once and links resolve.

export const HOST = 'motamem.org';

// System / non-post root segments to drop (kept as *whole* single segments only).
const EXCLUDED = /^(page|category|tag|author|feed|comments?|amp|attachment|embed|wp-.*|xmlrpc\.php)$/i;

// Percent-decode a segment, then repair "UTF-8 bytes misread as Latin-1" mojibake
// that double-encoding produces. Returns canonical, NFC-normalized, lowercased text.
export function canonicalizeSegment(seg) {
  let s = seg;
  try { s = decodeURIComponent(s); } catch { /* leave raw if malformed */ }
  // Chars in the Latin-1 supplement range are the tell-tale of double-encoding:
  // re-read them as bytes and decode as UTF-8 to recover the real characters.
  if (/[À-ÿ]/.test(s)) {
    const fixed = Buffer.from(s, 'latin1').toString('utf8');
    if (!fixed.includes('�')) s = fixed; // only accept a clean repair
  }
  return s.normalize('NFC').trim().toLowerCase();
}

function pathOf(urlOrPath) {
  try {
    return new URL(urlOrPath, `https://${HOST}/`).pathname;
  } catch {
    let p = urlOrPath.replace(/^https?:\/\/[^/]+/i, '');
    const q = p.indexOf('?');
    return q >= 0 ? p.slice(0, q) : p;
  }
}

// Canonical slug id for a root-level post URL, or null if the URL is not a post.
export function postId(urlOrPath) {
  const segs = pathOf(urlOrPath).split('/').filter(Boolean);
  if (segs.length !== 1) return null;            // posts live at the site root only
  const id = canonicalizeSegment(segs[0]);
  if (!id || /\s/.test(id)) return null;         // drop empties and control-char junk (e.g. %0A)
  if (EXCLUDED.test(id)) return null;            // drop system paths (/feed/, /amp/, ...)
  return id;
}

// Canonical live URL for a slug (single-encoded Persian) — used for click-through.
export function liveUrl(id) {
  return `https://${HOST}/${encodeURIComponent(id)}/`;
}
