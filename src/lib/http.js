// Small polite HTTP helper: retries with backoff, honors a concurrency pool.

const UA = 'motamem-graph-generator/0.1 (+https://motamem.org graph builder; contact via site owner)';

export async function fetchText(url, { retries = 4, timeoutMs = 60000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
      clearTimeout(t);
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      return { status: res.status, text: await res.text() };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const wait = Math.min(30000, 1000 * 2 ** attempt); // 1s,2s,4s,8s,16s
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Run tasks with bounded concurrency, preserving input order in the result array.
export async function pool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}
