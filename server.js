// server.js
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCES, resolveSource, getSource } from "./lib/sources.js";
import { mergeSearch } from "./lib/search.js";
import { streamChapterPdf, buildChapterPdfBuffer } from "./lib/pdf.js";
import { createZip } from "./lib/zip.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// In-memory job store (Render's disk is ephemeral -> we never write files).
// A "job" holds the downloaded page buffers for one chapter, briefly, between
// the SSE "prepare" phase and the actual PDF download. Auto-expires so a user
// who abandons a download can't leak memory on the free tier.
// ---------------------------------------------------------------------------
const jobs = new Map();
const JOB_TTL_MS = 2 * 60 * 1000; // 2 minutes to click "download"
const MAX_JOBS = 8; // hard cap; free tier has ~512MB RAM

function putJob(id, data) {
  if (jobs.size >= MAX_JOBS) {
    // Evict the oldest job to stay within the memory budget.
    const oldest = jobs.keys().next().value;
    jobs.delete(oldest);
  }
  const timer = setTimeout(() => jobs.delete(id), JOB_TTL_MS);
  jobs.set(id, { ...data, timer });
}

function takeJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  clearTimeout(job.timer);
  jobs.delete(id); // one-shot: freed the moment it's served
  return job;
}

const safeName = (s) => s.replace(/[^\w.\- ]+/g, "_").slice(0, 120);

// Open a Server-Sent Events stream and return a `send(event, data)` helper.
function openSse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  return (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health check — also handy as the target for an external uptime pinger that
// keeps the free instance from spinning down after 15 min idle.
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Shared: load a title's metadata + chapter list for a known source + id.
async function loadTitle(source, mangaId, language) {
  const [manga, chapters] = await Promise.all([
    source.getManga(mangaId),
    source.getChapters(mangaId, language),
  ]);
  return { manga, chapters };
}

// 1) Resolve a source URL -> manga metadata + chapter list.
//    The source is auto-detected from the URL and echoed back so the client can
//    tag later prepare/download calls with it.
app.get("/api/manga", async (req, res) => {
  const source = resolveSource(req.query.url);
  if (!source) {
    return res.status(400).json({
      error: "Unrecognized URL. Paste a MangaDex or Dynasty Scans link.",
    });
  }
  try {
    const mangaId = source.parseId(req.query.url);
    if (!mangaId) {
      return res
        .status(400)
        .json({ error: `Could not find a ${source.name} id in that URL.` });
    }
    const { manga, chapters } = await loadTitle(
      source,
      mangaId,
      (req.query.lang || "en").toString()
    );
    if (chapters.length === 0) {
      return res.status(404).json({
        error: `No downloadable chapters found for this title.`,
      });
    }
    res.json({ source: source.id, manga, chapters });
  } catch (err) {
    console.error("GET /api/manga:", err.message);
    res.status(502).json({ error: `Failed to reach ${source.name}. Try again.` });
  }
});

// 1a) Unified search across every source, deduplicated. No URL needed.
//     Not case-sensitive; matching is word-based for typo tolerance.
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (!q) {
    return res.status(400).json({ error: "Type a title to search for." });
  }
  try {
    // Query every source in parallel; a single source failing shouldn't sink
    // the whole search.
    const lists = await Promise.all(
      SOURCES.map((s) =>
        s.searchManga(q).catch((err) => {
          console.error(`${s.id} search:`, err.message);
          return [];
        })
      )
    );
    res.json({ results: mergeSearch(q, lists.flat()) });
  } catch (err) {
    console.error("GET /api/search:", err.message);
    res.status(502).json({ error: "Search failed. Try again." });
  }
});

// 1b) Quick info for one title (used to fill covers/descriptions we didn't
//     already have — chiefly Dynasty-only results).
app.get("/api/info", async (req, res) => {
  const source = getSource(req.query.source);
  if (!source || !req.query.id) {
    return res.status(400).json({ error: "Missing source or id." });
  }
  try {
    const manga = await source.getManga(req.query.id.toString());
    res.json({ manga });
  } catch (err) {
    console.error("GET /api/info:", err.message);
    res.status(502).json({ error: `Failed to reach ${source.name}. Try again.` });
  }
});

// 1c) Load a specific title's chapters by source + id (from a search result).
app.get("/api/title", async (req, res) => {
  const source = getSource(req.query.source);
  if (!source || !req.query.id) {
    return res.status(400).json({ error: "Missing source or id." });
  }
  try {
    const { manga, chapters } = await loadTitle(
      source,
      req.query.id.toString(),
      (req.query.lang || "en").toString()
    );
    if (chapters.length === 0) {
      return res.status(404).json({
        error: "No downloadable chapters found for this title.",
      });
    }
    res.json({ source: source.id, manga, chapters });
  } catch (err) {
    console.error("GET /api/title:", err.message);
    res.status(502).json({ error: `Failed to reach ${source.name}. Try again.` });
  }
});

// 1d) Cover-image proxy. uploads.mangadex.org applies hotlink protection: a
//     browser <img> request carries our origin as Referer and gets a "read this
//     on MangaDex" placeholder back. Fetching server-side lets us send the
//     site's own Referer and relay the real image. Host-allowlisted so this
//     can't be used as an open proxy.
const COVER_HOSTS = {
  "uploads.mangadex.org": "https://mangadex.org/",
  "dynasty-scans.com": "https://dynasty-scans.com/",
};
app.get("/api/cover", async (req, res) => {
  let url;
  try {
    url = new URL(req.query.url);
  } catch {
    return res.status(400).send("Bad cover url.");
  }
  const referer = COVER_HOSTS[url.hostname];
  if (!referer || url.protocol !== "https:") {
    return res.status(400).send("Cover host not allowed.");
  }
  try {
    const upstream = await fetch(url.href, {
      headers: { "User-Agent": "manga-pdf-downloader/1.0 (personal use)", Referer: referer },
    });
    if (!upstream.ok) return res.status(502).send("Cover fetch failed.");
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.error("GET /api/cover:", err.message);
    res.status(502).send("Cover fetch failed.");
  }
});

// 2) Prepare a chapter: download every page, streaming progress over SSE.
//    On completion we stash the buffers as a one-shot job and hand back a jobId.
app.get("/api/chapter/:id/prepare", async (req, res) => {
  const chapterId = req.params.id;
  const dataSaver = req.query.quality !== "original";
  // Default to MangaDex so older clients (no ?source=) keep working.
  const source = getSource(req.query.source) || getSource("mangadex");

  const send = openSse(res);

  let aborted = false;
  req.on("close", () => (aborted = true));

  try {
    const urls = await source.getChapterPageUrls(chapterId, { dataSaver });
    const images = [];

    send("progress", { done: 0, total: urls.length });
    for (let i = 0; i < urls.length; i++) {
      if (aborted) return; // client navigated away -> stop wasting bandwidth
      images.push(await source.downloadImage(urls[i]));
      send("progress", { done: i + 1, total: urls.length });
    }

    const jobId = `${chapterId}-${Date.now()}`;
    const label = (req.query.label || `chapter-${chapterId}`).toString();
    putJob(jobId, { images, filename: `${safeName(label)}.pdf` });

    send("ready", { jobId, pages: images.length });
    res.end();
  } catch (err) {
    console.error("prepare error:", err.message);
    send("error", { message: `Download failed. ${source.name} may be busy — retry.` });
    res.end();
  }
});

// 3) Stream the assembled PDF, then drop the job so memory is reclaimed.
app.get("/api/chapter/download/:jobId", (req, res) => {
  const job = takeJob(req.params.jobId);
  if (!job) {
    return res
      .status(410)
      .send("This download expired. Please prepare the chapter again.");
  }
  streamChapterPdf(res, { filename: job.filename, images: job.images });
});

// 4) (Optional) Prepare several chapters into ONE zip of PDFs. Downloads every
//    chapter sequentially — building one PDF buffer per chapter and freeing its
//    page images as we go — streaming combined progress over SSE. Unlike the
//    per-chapter flow this stashes a single job, so it isn't affected by the
//    MAX_JOBS cap / 2-minute TTL that a long multi-chapter run would trip.
app.get("/api/zip/prepare", async (req, res) => {
  const source = getSource(req.query.source) || getSource("mangadex");
  const dataSaver = req.query.quality !== "original";

  // items = encodeURIComponent(JSON.stringify([{ id, label }, ...]))
  let items;
  try {
    items = JSON.parse(req.query.items || "[]");
  } catch {
    items = [];
  }

  const send = openSse(res);
  if (!Array.isArray(items) || items.length === 0) {
    send("error", { message: "No chapters selected for the zip." });
    return res.end();
  }

  let aborted = false;
  req.on("close", () => (aborted = true));

  try {
    const files = [];
    for (let idx = 0; idx < items.length; idx++) {
      if (aborted) return;
      const { id, label } = items[idx];
      const urls = await source.getChapterPageUrls(id, { dataSaver });
      const images = [];

      send("progress", { index: idx, total: items.length, done: 0, pages: urls.length });
      for (let i = 0; i < urls.length; i++) {
        if (aborted) return;
        images.push(await source.downloadImage(urls[i]));
        send("progress", { index: idx, total: items.length, done: i + 1, pages: urls.length });
      }

      // Collapse this chapter to a PDF now so its raw images can be reclaimed.
      const pdf = await buildChapterPdfBuffer({ images });
      files.push({ name: `${safeName(label || `chapter-${idx + 1}`)}.pdf`, data: pdf });
    }

    const jobId = `zip-${Date.now()}`;
    const zipName = safeName((req.query.name || "chapters").toString());
    putJob(jobId, { zip: true, filename: `${zipName}.zip`, files });

    send("ready", { jobId, chapters: files.length });
    res.end();
  } catch (err) {
    console.error("zip prepare error:", err.message);
    send("error", { message: `Zip failed. ${source.name} may be busy — retry.` });
    res.end();
  }
});

// 5) Stream the assembled ZIP, then drop the job so memory is reclaimed.
app.get("/api/zip/download/:jobId", (req, res) => {
  const job = takeJob(req.params.jobId);
  if (!job || !job.zip) {
    return res
      .status(410)
      .send("This download expired. Please prepare the chapters again.");
  }
  const buf = createZip(job.files);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(job.filename)}"`
  );
  res.setHeader("Content-Length", buf.length);
  res.end(buf);
});

// ---------------------------------------------------------------------------
// Render requires binding to process.env.PORT on 0.0.0.0.
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Manga PDF downloader listening on :${PORT}`);
});
