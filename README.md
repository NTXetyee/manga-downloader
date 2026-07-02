# Manga → PDF Downloader

**Search by title** across MangaDex + Dynasty Scans at once (or paste a title
URL), pick chapters, and download each one as a well-formatted PDF — or tick
**Zip together** to get all selected chapters bundled into a single `.zip`.
Built to run on **Render.com's free tier** — everything is processed **in
memory** (no disk writes), it binds to Render's dynamic `PORT`, and it survives
the 15-minute idle spin-down.

## Search

The search box queries every source in parallel and merges the hits into one
deduplicated list:

- **Not case-sensitive**, and matched **word by word** — a typo in one word of a
  multi-word title still matches on the others (`lib/search.js`).
- A title found in **both** sources collapses into a single result; opening it
  shows a quick info page (cover + description, pulled from MangaDex) with a
  **source selector** defaulted to MangaDex. Pick a source, then **Load
  chapters**.
- Cross-source de-duplication is a title-similarity heuristic (token
  containment / Jaccard overlap in `lib/search.js`) — tune the threshold there if
  you see wrong merges or missed pairs.

> Dynasty has no JSON search endpoint, so `lib/dynasty.js` scrapes series links
> out of its HTML results page. If Dynasty changes that markup, the regex in
> `searchManga()` is the one spot to adjust.

## Supported sources

| Source | Paste a URL like | Notes |
| --- | --- | --- |
| **MangaDex** | `https://mangadex.org/title/<uuid>/…` | Language + quality (data-saver / original) selectable. |
| **Dynasty Scans** | `https://dynasty-scans.com/series/<slug>` (or a `/chapters/<slug>` link) | English releases; the language/quality selectors don't apply. |

Sources are auto-detected from the URL. Adding another is a matter of dropping a
module in `lib/` that implements the small source interface and registering it in
`lib/sources.js` — the server routes and UI are source-agnostic.

---

## Tech stack & why

| Concern | Choice | Reason |
| --- | --- | --- |
| Runtime | **Node.js 18+** | Built-in `fetch`, great streaming I/O, one language front-to-back. |
| Web server | **Express** | Minimal, serves the static UI + JSON/SSE API. |
| PDF | **PDFKit** | Streams a PDF directly to the HTTP response; natively embeds JPEG/PNG. |
| Image transcode | **sharp** | PDFKit can't embed **WebP** (which Dynasty Scans serves) or GIF, so those pages are converted to JPEG first (`lib/image.js`). Loaded lazily + treated as optional — MangaDex (JPEG/PNG) works without it. |
| Progress | **Server-Sent Events** | One-way page-by-page progress with zero client libraries. |
| Storage | **None (in-memory)** | Render's filesystem is ephemeral; we never touch disk, so there's nothing to clean up. |

> **Node vs. Python/Flask+ReportLab:** Python works too, but you'd typically add
> Pillow/img2pdf for image handling and manage a WSGI server (gunicorn). The Node
> path here keeps dependencies lean and streams the PDF straight to the socket,
> which is lighter on the free tier's ~512 MB RAM.
>
> **On `sharp`:** it's the one native dependency, pulled in only because Dynasty
> Scans serves WebP and PDFKit can't embed it. It ships prebuilt binaries (no
> build toolchain needed on Render or Windows) and is loaded via dynamic import,
> so if it's ever missing the app still runs — WebP pages just fall back instead
> of converting. `npm install` pulls it in automatically.

---

## How Render's constraints are handled

- **Ephemeral filesystem** — pages are downloaded into `Buffer`s and piped
  through PDFKit into the response. Nothing is written to disk. Buffers are held
  in a one-shot in-memory job store that auto-expires after 2 minutes and is
  deleted the instant the PDF is served (`lib` + `server.js`).
- **Dynamic port** — `app.listen(process.env.PORT || 3000, "0.0.0.0")`. Never
  hard-code the port; Render injects it.
- **15-min idle spin-down** — free instances sleep after 15 min of no traffic;
  the next request takes ~30–60 s to wake. A `/healthz` endpoint is provided so
  you can point an external uptime pinger at it (see below).
- **Memory ceiling** — downloads run **one chapter at a time**, and the job
  store is capped (`MAX_JOBS`) with oldest-eviction.

---

## Respecting each source's rate limits

Every source funnels all its API and image requests through its own scheduler
(`lib/mangadex.js`, `lib/dynasty.js`) that:

- serializes requests and enforces a **minimum gap** between them (MangaDex
  ~250 ms ≈ 4 req/s, under its documented 5 req/s cap; Dynasty ~300 ms to stay
  gentle on a small community server),
- retries with back-off on network errors / HTTP 5xx,
- honours **HTTP 429 + `Retry-After`** before retrying,
- sends a descriptive `User-Agent`.

This is the difference between "works" and "IP temporarily blocked."

---

## Project layout

```
.
├── server.js            # Express app: static UI, /api routes, PORT binding
├── lib/
│   ├── sources.js       # source registry + URL resolver
│   ├── search.js        # merge/dedupe multi-source search hits
│   ├── mangadex.js      # MangaDex source: API client + rate limiter + images
│   ├── dynasty.js       # Dynasty Scans source (same interface)
│   ├── pdf.js           # image buffers -> streamed PDF / PDF Buffer
│   └── zip.js           # dependency-free ZIP writer (STORE method)
├── public/              # frontend (no build step)
│   ├── index.html
│   ├── style.css
│   └── app.js
├── render.yaml          # optional: Render Blueprint
├── package.json
└── README.md
```

### The source interface

Each file in `lib/` that backs a source exports the same shape, consumed by
`lib/sources.js`:

```js
id, name                         // stable id + display name
match(url)                       // does this source own the pasted URL?
parseId(url)                     // url -> opaque manga id
getManga(id)                     // -> { id, title, description, cover, ... }
getChapters(id, language)        // -> [{ id, chapter, volume, title, pages, group }]
getChapterPageUrls(chapterId, o) // -> [imageUrl, ...]
downloadImage(url)               // -> Buffer
searchManga(query, limit)        // -> [{ source, id, title, cover, ... }]
```

### Zipping multiple chapters

Ticking **Zip together** (with 2+ chapters selected) posts the selection to
`/api/zip/prepare`, which downloads each chapter sequentially, collapses it to a
PDF buffer (freeing that chapter's page images before moving on), and stashes a
single combined job. `/api/zip/download/:jobId` then emits one `.zip` of PDFs.
Because it's one job, the multi-chapter run isn't affected by the `MAX_JOBS` cap
or the 2-minute per-job TTL. The ZIP is assembled in memory with a tiny built-in
writer (`lib/zip.js`, STORE method — the PDFs' embedded images are already
compressed), so **no new dependency** is added.

---

## Local setup

```bash
# 1. Install dependencies (Node 18+ required)
npm install

# 2. Run it
npm start
#   → MangaDex PDF downloader listening on :3000

# 3. Open http://localhost:3000
#    Paste a title URL, e.g.
#    https://mangadex.org/title/a1c7c817-4e59-43b7-9365-09675a149a6f/one-piece
```

`npm run dev` starts it with `--watch` for auto-reload during development.

---

## Deploying to Render.com (Web Service, free tier)

### Option A — Blueprint (uses `render.yaml`)

1. Push this repo to GitHub/GitLab.
2. In Render: **New → Blueprint**, select the repo. Render reads `render.yaml`
   and creates the service. Click **Apply**.

### Option B — Manual dashboard setup

1. **Push to GitHub.**
   ```bash
   git init && git add . && git commit -m "MangaDex PDF downloader"
   git branch -M main
   git remote add origin https://github.com/<you>/mangadex-pdf.git
   git push -u origin main
   ```
2. In Render: **New → Web Service** → connect the repo.
3. Fill in:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
   - **Health Check Path:** `/healthz`
4. **Do not** add a `PORT` env var — Render sets it. (Optionally add
   `NODE_VERSION = 20`.)
5. **Create Web Service.** First deploy takes a couple of minutes. Your app is at
   `https://<name>.onrender.com`.

### Keeping it awake (optional)

Free services sleep after 15 min idle. To reduce cold starts, create a free
uptime monitor (e.g. UptimeRobot / cron-job.org) that hits
`https://<name>.onrender.com/healthz` every 10–14 minutes.
> Note: this keeps the instance running against your free monthly hours — fine
> for personal use, but don't expect 24/7 uptime for free.

---

## Notes & limitations

- **Personal use only.** Respect MangaDex's Terms of Service and support the
  official releases and scanlation groups.
- Large chapters (very high-res original pages) use more memory; prefer the
  **Data-saver** quality on the free tier.
- Cold starts: the first request after idle can take 30–60 s while the instance
  wakes — this is a free-tier characteristic, not a bug.
