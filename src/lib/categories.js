// Course/topic categories from motamem's <span class="meta_categories"> block.
// We keep genuine course/topic categories and drop access + engagement labels.

// Access/membership labels all start with "مختص کاربر" (premium / free / active-free).
const ACCESS_PREFIX = 'مختص کاربر';

// Engagement / content-type markers that are not a course.
const BLOCK_EXACT = new Set([
  'تمرین و مشارکت در بحث',
  'تمرین دارد',
  'دعوت به گفتگو',
  'عمومی',
]);

// Normalize Persian text so the same category matches across pages
// (unify Arabic Yeh/Kaf, collapse whitespace, NFC).
export function normalizeCategory(s) {
  return s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .normalize('NFC');
}

// Filter + de-dupe a list of raw label strings down to course/topic categories.
export function courseCategories(rawLabels) {
  const out = [];
  const seen = new Set();
  for (const raw of rawLabels) {
    const c = normalizeCategory(raw);
    if (!c || c === '✔') continue;
    if (c.startsWith(ACCESS_PREFIX)) continue;
    if (BLOCK_EXACT.has(c)) continue;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}
