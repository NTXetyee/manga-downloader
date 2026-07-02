// lib/search.js
// Merge search hits from multiple sources into one deduplicated list.
//
// Matching is deliberately word-based (case-insensitive, accent-folded) so that
// a typo in one word of a multi-word title still matches on the others, and so
// the same title from two sources ("Kase-san" vs "Asagao to Kase-san") can be
// recognised as one manga and offered with a source selector.

// A few filler words that shouldn't drive a match on their own.
const STOP = new Set([
  "the", "a", "an", "of", "to", "and", "no", "wa", "ga", "in", "on", "de",
  "le", "la", "el", "and", "wo", "e", "ni",
]);

// Split a string into lowercase, accent-stripped alphanumeric words.
export function tokenize(s = "") {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // drop combining accents
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// Significant tokens: drop stopwords and 1-char noise, but never return empty.
function significant(tokens) {
  const kept = tokens.filter((t) => t.length > 1 && !STOP.has(t));
  return kept.length ? kept : tokens;
}

// Do two token sets describe the same title? Single-word titles must match
// exactly; longer titles match on full containment or strong overlap, which
// tolerates a source appending/omitting words.
function sameTitle(a, b) {
  if (!a.size || !b.size) return false;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const smaller = Math.min(a.size, b.size);
  if (smaller === 1) return inter === 1 && a.size === b.size;
  if (inter === smaller) return true; // one set fully contained in the other
  const union = a.size + b.size - inter;
  return inter / union >= 0.6; // Jaccard similarity
}

// How many query words appear in a title's token set (used for ranking).
function score(queryTokens, titleTokens) {
  let s = 0;
  for (const w of queryTokens) if (titleTokens.has(w)) s++;
  return s;
}

/**
 * @param {string} query
 * @param {{source,id,title,cover,description,year,status}[]} items
 * @returns {{title,cover,description,year,status,sources:Record<string,string>}[]}
 */
export function mergeSearch(query, items) {
  const qTok = new Set(significant(tokenize(query)));
  const groups = [];

  for (const it of items) {
    const tok = new Set(significant(tokenize(it.title)));
    let group = groups.find((g) => sameTitle(g.tok, tok));
    if (!group) {
      group = { tok, sources: {}, entries: [] };
      groups.push(group);
    }
    // First id wins per source (search is already relevance-ordered).
    if (!group.sources[it.source]) group.sources[it.source] = it.id;
    group.entries.push(it);
  }

  return groups
    .map((g) => {
      // Prefer MangaDex for the displayed info (richer metadata + cover).
      const primary =
        g.entries.find((e) => e.source === "mangadex") || g.entries[0];
      const withCover = g.entries.find((e) => e.cover) || primary;
      return {
        title: primary.title,
        cover: withCover.cover || null,
        description: primary.description || "",
        year: primary.year || null,
        status: primary.status || "",
        sources: g.sources,
        _score: score(qTok, g.tok),
      };
    })
    .sort((a, b) => b._score - a._score || a.title.localeCompare(b.title))
    .map(({ _score, ...rest }) => rest);
}
