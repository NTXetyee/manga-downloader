// lib/dynasty.js
// Source adapter for Dynasty Scans (https://dynasty-scans.com).
//
// Dynasty exposes a read-only JSON API by appending ".json" to a URL:
//   • Series:  GET /series/<permalink>.json
//              -> { name, cover, taggings: [ {header} | {permalink,title,…} ] }
// The chapter JSON does NOT contain page image URLs, though — those are embedded
// in the chapter HTML page (`/chapters/<permalink>`) as a `var pages = [...]`
// array of { image: "/system/…" } entries, which getChapterPageUrls scrapes.
// Search likewise has no JSON endpoint and is scraped from the HTML results.
// All image/cover paths are site-relative and resolved against BASE.
//
// Implements the common "source" interface consumed by lib/sources.js:
//   id, name, match(url), parseId(url), getManga(id), getChapters(id, lang),
//   getChapterPageUrls(chapterId, opts), downloadImage(url)

const BASE = "https://dynasty-scans.com";
const USER_AGENT = "manga-pdf-downloader/1.0 (personal use)";

// ---------------------------------------------------------------------------
// Polite, serialized fetching (Dynasty is a small community server — be gentle).
// Mirrors the approach in lib/mangadex.js: one request at a time, spaced out,
// with timeout, retries and 429 back-off.
// ---------------------------------------------------------------------------
const MIN_GAP_MS = 300;
let lastRequestAt = 0;
let chain = Promise.resolve();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function politeFetch(url, { timeoutMs = 20000, retries = 3, headers = {} } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, Referer: BASE + "/", ...headers },
      });
      clearTimeout(timer);

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after")) || 2;
        await sleep(retryAfter * 1000);
        continue;
      }
      if (res.status >= 500 && attempt < retries) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      if (attempt === retries) throw err;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error(`Failed to fetch after ${retries} retries: ${url}`);
}

async function apiGet(pathname) {
  const res = await schedule(() => politeFetch(`${BASE}${pathname}`));
  if (!res.ok) throw new Error(`Dynasty ${res.status} for ${pathname}`);
  return res.json();
}

async function fetchText(pathname) {
  const res = await schedule(() => politeFetch(`${BASE}${pathname}`));
  if (!res.ok) throw new Error(`Dynasty ${res.status} for ${pathname}`);
  return res.text();
}

const stripTags = (s = "") => s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
const absolute = (u) => (u ? new URL(u, BASE).href : null);

// ---------------------------------------------------------------------------
// Source metadata
// ---------------------------------------------------------------------------
export const id = "dynasty";
export const name = "Dynasty Scans";

export function match(url = "") {
  return /dynasty-scans\.com/i.test(url);
}

// A Dynasty URL points at either a series or a standalone chapter. We keep both
// working by encoding the kind into the id we hand back to the client:
//   "series:<permalink>"  or  "chapter:<permalink>"
// (Individual chapter ids used for downloads are just the bare <permalink>.)
export function parseId(input) {
  if (!input) return null;
  const s = input.trim();
  const series = s.match(/\/series\/([^/?#]+)/i);
  if (series) return `series:${series[1]}`;
  const chapter = s.match(/\/chapters\/([^/?#]+)/i);
  if (chapter) return `chapter:${chapter[1]}`;
  return null;
}

function splitId(id = "") {
  const idx = id.indexOf(":");
  if (idx === -1) return { kind: "chapter", permalink: id };
  return { kind: id.slice(0, idx), permalink: id.slice(idx + 1) };
}

// Pull a chapter number out of a Dynasty title like "Chapter 12" / "Ch. 3.5".
function chapterNumber(title = "") {
  const m = title.match(/ch(?:apter|\.)?\s*([\d.]+)/i);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Public helpers (source interface)
// ---------------------------------------------------------------------------
export async function getManga(id) {
  const { kind, permalink } = splitId(id);

  if (kind === "chapter") {
    // Standalone chapter / oneshot / doujin with no parent series.
    const data = await apiGet(`/chapters/${permalink}.json`);
    return {
      id,
      title: data.title || permalink,
      description: "",
      status: "",
      cover: absolute(data.pages?.[0]?.url) || null,
    };
  }

  const data = await apiGet(`/series/${permalink}.json`);
  const author = (data.tags || []).find((t) => t.type === "Author");
  return {
    id,
    title: data.name || permalink,
    description: author ? `by ${author.name}` : "",
    status: "",
    cover: absolute(data.cover),
  };
}

// Search Dynasty for series. Dynasty's search page is HTML (no JSON endpoint),
// so we scrape the series links out of the results markup.
//
// NOTE: this parses live HTML — if Dynasty changes its markup the regex below
// is the thing to adjust. Restricted to `Series` (the URL kind this source
// knows how to download); anthologies/doujins/standalone issues are skipped.
export async function searchManga(query, limit = 15) {
  const html = await fetchText(
    `/search?q=${encodeURIComponent(query)}&classes[]=Series`
  );
  const re = /<a\b[^>]*href="\/series\/([^"?#]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const title = stripTags(m[2]);
    if (!title) continue;
    out.push({
      source: id,
      id: `series:${slug}`,
      title,
      cover: null, // discovered lazily via getManga when a title is opened
      description: "",
      year: null,
      status: "",
    });
  }
  return out;
}

// `language` is accepted for interface parity but ignored — Dynasty releases
// are already translated (predominantly English) with no per-language feed.
export async function getChapters(id, _language = "en") {
  const { kind, permalink } = splitId(id);

  if (kind === "chapter") {
    const data = await apiGet(`/chapters/${permalink}.json`);
    return [
      {
        id: permalink,
        chapter: chapterNumber(data.title),
        volume: null,
        title: data.title || permalink,
        pages: Array.isArray(data.pages) ? data.pages.length : null,
        language: "en",
        group: name,
      },
    ];
  }

  const data = await apiGet(`/series/${permalink}.json`);
  const chapters = [];
  let volume = null;

  // taggings is an ordered mix of header separators ({header}) and chapter
  // entries ({permalink, title, released_on}). Headers name volumes/sections.
  for (const t of data.taggings || []) {
    if (t.header) {
      const v = t.header.match(/vol(?:ume)?\.?\s*([\d.]+)/i);
      volume = v ? v[1] : null;
      continue;
    }
    if (!t.permalink) continue;
    chapters.push({
      id: t.permalink,
      chapter: chapterNumber(t.title),
      volume,
      title: t.title || t.permalink,
      pages: null, // page count isn't in the series feed; discovered on prepare
      language: "en",
      group: name,
    });
  }
  return chapters;
}

// `opts` (e.g. dataSaver) is accepted for interface parity; Dynasty serves a
// single image quality.
//
// The chapter's page images are NOT in the `.json` payload — they're embedded
// in the chapter HTML as a `var pages = [{ "image": "/system/…" }, …]` array
// (same approach established Dynasty clients use). We fetch the HTML and parse
// that array out.
export async function getChapterPageUrls(chapterId, _opts = {}) {
  const html = await fetchText(`/chapters/${chapterId}`);
  const m = html.match(/var\s+pages\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) return [];
  let pages;
  try {
    pages = JSON.parse(m[1]);
  } catch {
    return [];
  }
  return pages
    .map((p) => p.image || p.url) // `image` is the real key; `url` as a fallback
    .filter(Boolean)
    .map((path) => new URL(path, BASE).href);
}

export async function downloadImage(url) {
  const res = await schedule(() => politeFetch(url, { timeoutMs: 30000, retries: 3 }));
  if (!res.ok) throw new Error(`Image fetch ${res.status}: ${url}`);
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}
