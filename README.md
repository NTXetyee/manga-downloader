# MangaDex → PDF Downloader

Paste a MangaDex title URL, pick chapters, and download each one as a
well-formatted PDF. Built to run on **Render.com's free tier** — everything is
processed **in memory** (no disk writes), it binds to Render's dynamic `PORT`,
and it survives the 15-minute idle spin-down.

---

## Tech stack & why

| Concern | Choice | Reason |
| --- | --- | --- |
| Runtime | **Node.js 18+** | Built-in `fetch`, great streaming I/O, one language front-to-back. |
| Web server | **Express** | Minimal, serves the static UI + JSON/SSE API. |
| PDF | **PDFKit** | Streams a PDF directly to the HTTP response; natively embeds JPEG/PNG, so **no image-conversion native dependency** (important on the free tier). |
| Progress | **Server-Sent Events** | One-way page-by-page progress with zero client libraries. |
| Storage | **None (in-memory)** | Render's filesystem is ephemeral; we never touch disk, so there's nothing to clean up. |

> **Node vs. Python/Flask+ReportLab:** Python works too, but you'd typically add
> Pillow/img2pdf for image handling and manage a WSGI server (gunicorn). The Node
> path here keeps dependencies to just two packages and streams the PDF straight
> to the socket, which is lighter on the free tier's ~512 MB RAM.

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

## Respecting MangaDex's rate limits

All API and image requests funnel through a single scheduler in
`lib/mangadex.js` that:

- serializes requests and enforces a **~250 ms minimum gap** (≈4 req/s, under
  the documented 5 req/s global cap),
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
│   ├── mangadex.js      # API client + rate limiter + image downloader
│   └── pdf.js           # image buffers -> streamed PDF
├── public/              # frontend (no build step)
│   ├── index.html
│   ├── style.css
│   └── app.js
├── render.yaml          # optional: Render Blueprint
├── package.json
└── README.md
```

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
