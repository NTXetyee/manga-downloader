// lib/mangadex.js
// Thin wrapper around the public MangaDex API with built-in, polite rate limiting.
// Docs: https://api.mangadex.org/docs/
//
// Implements the common "source" interface consumed by lib/sources.js:
//   id, name, match(url), parseId(url), getManga(id), getChapters(id, lang),
//   getChapterPageUrls(chapterId, opts), downloadImage(url)

const API = "https://api.mangadex.org";
const USER_AGENT = "mangadex-pdf-downloader/1.0 (personal use)";

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
// MangaDex enforces a global limit of ~5 requests/second per IP, plus tighter
// per-endpoint limits. We serialize every API call through a single queue that
// guarantees a minimum gap between requests, and we honour 429 + Retry-After.
// This is the single most important thing for not getting your IP throttled.

const MIN_GAP_MS = 250; // ~4 req/s, comfortably under the 5 req/s ceiling
let lastRequestAt = 0;
let chain = Promise.resolve();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Serialize + space out an async task.
function schedule(task) {
  chain = chain.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    try {
      return await task();
    } finally {
      lastRequestAt = Date.now();
    }
  });
  return chain;
}

// fetch with timeout, retries, and 429 back-off. Used for both JSON API calls
// and binary image downloads.
async function politeFetch(url, { timeoutMs = 20000, retries = 3, headers = {} } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, ...headers },
      });
      clearTimeout(timer);

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after")) || 2;
        await sleep(retryAfter * 1000);
        continue;
      }
      if (res.status >= 500 && attempt < retries) {
        await sleep(1000 * (attempt + 1)); // linear back-off on server errors
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      if (attempt === retries) throw err; // network error / timeout exhausted
      await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error(`Failed to fetch after ${retries} retries: ${url}`);
}

async function apiGet(path) {
  const res = await schedule(() => politeFetch(`${API}${path}`));
  if (!res.ok) {
    throw new Error(`MangaDex API ${res.status} for ${path}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Source metadata (see lib/sources.js)
// ---------------------------------------------------------------------------
export const id = "mangadex";
export const name = "MangaDex";

// True when a URL (or bare UUID) belongs to this source.
export function match(url = "") {
  return /mangadex\.org/i.test(url) || Boolean(parseMangaId(url));
}

// Uniform alias for the source interface (MangaDex historically used parseMangaId).
export const parseId = parseMangaId;

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

// Accepts a full mangadex.org/title/<uuid>/... URL or a bare UUID.
export function parseMangaId(input) {
  if (!input) return null;
  const trimmed = input.trim();
  const uuid =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  // Prefer the id that appears right after /title/ ...
  const fromUrl = trimmed.match(/title\/([0-9a-f-]{36})/i);
  if (fromUrl) return fromUrl[1];
  // ... otherwise fall back to the first UUID we find (covers bare-id input).
  const any = trimmed.match(uuid);
  return any ? any[0] : null;
}

export async function getManga(mangaId) {
  const { data } = await apiGet(`/manga/${mangaId}`);
  const attr = data.attributes;
  const title =
    attr.title.en ||
    attr.title[Object.keys(attr.title)[0]] ||
    "Untitled";
  return {
    id: data.id,
    title,
    description: attr.description?.en || "",
    year: attr.year,
    status: attr.status,
  };
}

// Fetch the full chapter list for a language, paginating through the feed.
export async function getChapters(mangaId, language = "en") {
  const chapters = [];
  const limit = 100;
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      "translatedLanguage[]": language,
      "order[volume]": "asc",
      "order[chapter]": "asc",
      "includes[]": "scanlation_group",
    });
    // Include all content ratings so nothing is silently dropped.
    ["safe", "suggestive", "erotica", "pornographic"].forEach((r) =>
      params.append("contentRating[]", r)
    );

    const page = await apiGet(`/manga/${mangaId}/feed?${params.toString()}`);
    total = page.total;

    for (const c of page.data) {
      // Skip external chapters that have no hosted pages on MangaDex.
      if (c.attributes.pages < 1 || c.attributes.externalUrl) continue;
      const group = c.relationships?.find((r) => r.type === "scanlation_group");
      chapters.push({
        id: c.id,
        chapter: c.attributes.chapter, // e.g. "12" or null for oneshots
        volume: c.attributes.volume,
        title: c.attributes.title || "",
        pages: c.attributes.pages,
        language: c.attributes.translatedLanguage,
        group: group?.attributes?.name || "Unknown",
      });
    }
    offset += limit;
  }

  // De-duplicate by chapter number (multiple groups translate the same one);
  // keep the first we saw, which is fine for a personal downloader.
  const seen = new Set();
  return chapters.filter((c) => {
    const key = `${c.volume}-${c.chapter}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Resolve the image server + build the ordered list of page URLs for a chapter.
// `dataSaver` = true uses compressed JPEGs (smaller, always JPEG -> friendlier
// for PDF embedding and for free-tier memory). false = original quality.
export async function getChapterPageUrls(chapterId, { dataSaver = true } = {}) {
  const { baseUrl, chapter } = await apiGet(`/at-home/server/${chapterId}`);
  const mode = dataSaver ? "data-saver" : "data";
  const files = dataSaver ? chapter.dataSaver : chapter.data;
  return files.map((f) => `${baseUrl}/${mode}/${chapter.hash}/${f}`);
}

// Download a single image as a Buffer, routed through the polite scheduler.
export async function downloadImage(url) {
  const res = await schedule(() =>
    politeFetch(url, { timeoutMs: 30000, retries: 3 })
  );
  if (!res.ok) throw new Error(`Image fetch ${res.status}: ${url}`);
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}
