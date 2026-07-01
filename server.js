// server.js
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseMangaId,
  getManga,
  getChapters,
  getChapterPageUrls,
  downloadImage,
} from "./lib/mangadex.js";
import { streamChapterPdf } from "./lib/pdf.js";

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

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health check — also handy as the target for an external uptime pinger that
// keeps the free instance from spinning down after 15 min idle.
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// 1) Resolve a MangaDex URL -> manga metadata + chapter list.
app.get("/api/manga", async (req, res) => {
  try {
    const mangaId = parseMangaId(req.query.url);
    if (!mangaId) {
      return res
        .status(400)
        .json({ error: "Could not find a MangaDex manga ID in that URL." });
    }
    const language = (req.query.lang || "en").toString();
    const [manga, chapters] = await Promise.all([
      getManga(mangaId),
      getChapters(mangaId, language),
    ]);
    if (chapters.length === 0) {
      return res.status(404).json({
        error: `No downloadable "${language}" chapters found for this title.`,
      });
    }
    res.json({ manga, chapters });
  } catch (err) {
    console.error("GET /api/manga:", err.message);
    res.status(502).json({ error: "Failed to reach MangaDex. Try again." });
  }
});

// 2) Prepare a chapter: download every page, streaming progress over SSE.
//    On completion we stash the buffers as a one-shot job and hand back a jobId.
app.get("/api/chapter/:id/prepare", async (req, res) => {
  const chapterId = req.params.id;
  const dataSaver = req.query.quality !== "original";

  // Server-Sent Events headers.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  let aborted = false;
  req.on("close", () => (aborted = true));

  try {
    const urls = await getChapterPageUrls(chapterId, { dataSaver });
    const images = [];

    send("progress", { done: 0, total: urls.length });
    for (let i = 0; i < urls.length; i++) {
      if (aborted) return; // client navigated away -> stop wasting bandwidth
      images.push(await downloadImage(urls[i]));
      send("progress", { done: i + 1, total: urls.length });
    }

    const jobId = `${chapterId}-${Date.now()}`;
    const label = (req.query.label || `chapter-${chapterId}`).toString();
    putJob(jobId, { images, filename: `${safeName(label)}.pdf` });

    send("ready", { jobId, pages: images.length });
    res.end();
  } catch (err) {
    console.error("prepare error:", err.message);
    send("error", { message: "Download failed. MangaDex may be busy — retry." });
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

// ---------------------------------------------------------------------------
// Render requires binding to process.env.PORT on 0.0.0.0.
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`MangaDex PDF downloader listening on :${PORT}`);
});
