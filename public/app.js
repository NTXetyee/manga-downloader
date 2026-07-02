// public/app.js
const $ = (sel) => document.querySelector(sel);

const form = $("#search-form");
const urlInput = $("#url");
const langSel = $("#lang");
const loadBtn = $("#load-btn");
const alertBox = $("#alert");
const mangaSec = $("#manga");
const titleEl = $("#manga-title");
const metaEl = $("#manga-meta");
const listEl = $("#chapters");
const qualitySel = $("#quality");
const zipChk = $("#zip");
const downloadBtn = $("#download-btn");

// Search + info-panel elements.
const nameForm = $("#name-form");
const queryInput = $("#query");
const searchBtn = $("#search-btn");
const resultsSec = $("#results");
const resultsGrid = $("#results-grid");
const infoSec = $("#info");
const infoBack = $("#info-back");
const infoCover = $("#info-cover");
const infoTitle = $("#info-title");
const infoMeta = $("#info-meta");
const infoDesc = $("#info-desc");
const infoSourceRow = $("#info-source-row");
const infoSources = $("#info-sources");
const infoLoad = $("#info-load");

const SOURCE_NAMES = { mangadex: "MangaDex", dynasty: "Dynasty Scans" };

let chapters = [];
let source = "mangadex";
let mangaTitle = "chapters";
let selected = null; // { sources, selectedSource } for the open info panel

function showAlert(msg) {
  alertBox.textContent = msg;
  alertBox.classList.remove("hidden");
}
function clearAlert() {
  alertBox.classList.add("hidden");
}
const hide = (el) => el.classList.add("hidden");
const show = (el) => el.classList.remove("hidden");

// Adopt a { source, manga, chapters } payload and render the chapter list,
// hiding the search UI. Shared by the URL loader and the search info panel.
function showChapters(data) {
  chapters = data.chapters;
  source = data.source || "mangadex";
  mangaTitle = data.manga.title || "chapters";
  hide(resultsSec);
  hide(infoSec);
  renderManga(data.manga, chapters);
}

// -------------------------------------------------------------------------
// Load manga + chapters from a pasted URL
// -------------------------------------------------------------------------
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAlert();
  hide(mangaSec);
  loadBtn.disabled = true;
  loadBtn.textContent = "Loading…";

  try {
    const params = new URLSearchParams({
      url: urlInput.value,
      lang: langSel.value,
    });
    const res = await fetch(`/api/manga?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    showChapters(data);
  } catch (err) {
    showAlert(err.message);
  } finally {
    loadBtn.disabled = false;
    loadBtn.textContent = "Load";
  }
});

// -------------------------------------------------------------------------
// Search by title across all sources
// -------------------------------------------------------------------------
nameForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAlert();
  hide(mangaSec);
  hide(infoSec);
  searchBtn.disabled = true;
  searchBtn.textContent = "Searching…";

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(queryInput.value)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Search failed");
    renderResults(data.results);
  } catch (err) {
    showAlert(err.message);
  } finally {
    searchBtn.disabled = false;
    searchBtn.textContent = "Search";
  }
});

function renderResults(results) {
  resultsGrid.innerHTML = "";
  if (!results.length) {
    resultsGrid.innerHTML = `<p class="meta">No titles matched. Try fewer or different words.</p>`;
    show(resultsSec);
    return;
  }

  for (const r of results) {
    const card = document.createElement("div");
    card.className = "result-card";

    const cover = r.cover
      ? `<img class="result-cover" src="${r.cover}" alt="" loading="lazy"
             onerror="this.classList.add('placeholder');this.removeAttribute('src');this.textContent='no cover'" />`
      : `<div class="result-cover placeholder">no cover</div>`;

    const badges = Object.keys(r.sources)
      .map((s) =>
        s === "mangadex"
          ? `<span class="badge md">MangaDex</span>`
          : `<span class="badge dy">Dynasty</span>`
      )
      .join("");

    card.innerHTML = `
      ${cover}
      <div class="result-body">
        <div class="result-title">${escapeHtml(r.title)}</div>
        <div class="badges">${badges}</div>
      </div>
    `;
    card.addEventListener("click", () => openInfo(r));
    resultsGrid.appendChild(card);
  }
  show(resultsSec);
}

// -------------------------------------------------------------------------
// Quick info panel for a chosen search result
// -------------------------------------------------------------------------
async function openInfo(result) {
  clearAlert();
  hide(mangaSec);
  hide(resultsSec);

  const sourceIds = Object.keys(result.sources);
  // Prefer MangaDex for the displayed info + the default source selection.
  const preferred = result.sources.mangadex ? "mangadex" : sourceIds[0];
  selected = { sources: result.sources, selectedSource: preferred };

  // Seed the panel with whatever the search already gave us…
  fillInfo(result);
  renderSourceButtons(sourceIds, preferred);
  show(infoSec);

  // …then, if we're missing a cover/description (typically a Dynasty-only
  // result), fetch it on demand from that source.
  if (!result.cover || !result.description) {
    const infoSourceId = result.sources.mangadex || preferred;
    try {
      const res = await fetch(
        `/api/info?source=${infoSourceId}&id=${encodeURIComponent(result.sources[infoSourceId])}`
      );
      const data = await res.json();
      if (res.ok) fillInfo({ ...result, ...data.manga });
    } catch {
      /* keep the seeded info */
    }
  }
}

function fillInfo(m) {
  infoTitle.textContent = m.title || "";
  const bits = [m.year, m.status].filter(Boolean);
  infoMeta.textContent = bits.join(" · ");
  infoDesc.textContent = (m.description || "").slice(0, 600);
  if (m.cover) {
    infoCover.src = m.cover;
    infoCover.style.display = "";
  } else {
    infoCover.removeAttribute("src");
    infoCover.style.display = "none";
  }
}

function renderSourceButtons(sourceIds, preferred) {
  // Only show a selector when the title exists in more than one source.
  if (sourceIds.length < 2) {
    hide(infoSourceRow);
    infoSources.innerHTML = "";
    return;
  }
  infoSources.innerHTML = "";
  for (const s of sourceIds) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = SOURCE_NAMES[s] || s;
    if (s === preferred) btn.classList.add("active");
    btn.addEventListener("click", () => {
      selected.selectedSource = s;
      infoSources
        .querySelectorAll("button")
        .forEach((b) => b.classList.toggle("active", b === btn));
    });
    infoSources.appendChild(btn);
  }
  show(infoSourceRow);
}

infoBack.addEventListener("click", () => {
  hide(infoSec);
  show(resultsSec);
});

infoLoad.addEventListener("click", async () => {
  if (!selected) return;
  const src = selected.selectedSource;
  const id = selected.sources[src];
  infoLoad.disabled = true;
  infoLoad.textContent = "Loading…";
  try {
    const params = new URLSearchParams({ source: src, id, lang: langSel.value });
    const res = await fetch(`/api/title?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load chapters");
    showChapters(data);
  } catch (err) {
    showAlert(err.message);
  } finally {
    infoLoad.disabled = false;
    infoLoad.textContent = "Load chapters";
  }
});

function renderManga(manga, chapters) {
  titleEl.textContent = manga.title;
  metaEl.textContent = `${manga.year || ""} · ${manga.status || ""} · ${chapters.length} chapters`;

  listEl.innerHTML = "";
  for (const c of chapters) {
    const li = document.createElement("li");
    li.className = "chapter";
    li.dataset.id = c.id;

    // A chapter number isn't always present (Dynasty oneshots/doujins use a
    // named title instead) — fall back to the title, then to "Oneshot".
    const main = c.chapter
      ? `Ch. ${c.chapter}`
      : c.title
        ? escapeHtml(c.title)
        : "Oneshot";
    const extra = c.chapter && c.title ? "— " + escapeHtml(c.title) : "";
    const vol = c.volume ? `Vol. ${c.volume} · ` : "";
    const pages = c.pages ? `${c.pages} pages · ` : "";

    li.innerHTML = `
      <input type="checkbox" class="pick" />
      <div class="info">
        <div class="num">${main} <span class="ttl">${extra}</span></div>
        <div class="grp">${vol}${pages}${escapeHtml(c.group)}</div>
      </div>
      <div class="status">—</div>
    `;
    listEl.appendChild(li);
  }
  mangaSec.classList.remove("hidden");
}

$("#select-all").addEventListener("click", () =>
  listEl.querySelectorAll(".pick").forEach((cb) => (cb.checked = true))
);
$("#clear-all").addEventListener("click", () =>
  listEl.querySelectorAll(".pick").forEach((cb) => (cb.checked = false))
);

// -------------------------------------------------------------------------
// Download selected chapters — strictly sequential so we never hammer
// MangaDex with parallel chapters (the backend also rate-limits per request).
// -------------------------------------------------------------------------
downloadBtn.addEventListener("click", async () => {
  const rows = [...listEl.querySelectorAll(".chapter")].filter(
    (li) => li.querySelector(".pick").checked
  );
  if (rows.length === 0) {
    showAlert("Select at least one chapter first.");
    return;
  }
  clearAlert();
  downloadBtn.disabled = true;

  try {
    if (zipChk.checked && rows.length > 1) {
      await downloadZip(rows);
    } else {
      // One chapter (or zip unchecked): stream each PDF individually.
      for (const li of rows) {
        await downloadOne(li);
      }
    }
  } finally {
    downloadBtn.disabled = false;
  }
});

// Filename stem for a chapter's PDF (server sanitizes it further).
function pdfLabel(chapterId) {
  const ch = chapters.find((c) => c.id === chapterId);
  if (ch?.chapter) return `chapter-${ch.chapter}`;
  if (ch?.title) return ch.title;
  return chapterId;
}

function setStatus(li, text, cls = "") {
  const el = li.querySelector(".status");
  el.textContent = text;
  el.className = "status " + cls;
}

function ensureBar(li) {
  let bar = li.querySelector(".bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "bar";
    bar.innerHTML = "<span></span>";
    li.appendChild(bar);
  }
  return bar.querySelector("span");
}

function downloadOne(li) {
  return new Promise((resolve) => {
    const chapterId = li.dataset.id;
    const label = pdfLabel(chapterId);
    const quality = qualitySel.value === "original" ? "original" : "datasaver";
    const fill = ensureBar(li);

    setStatus(li, "Starting…");
    const params = new URLSearchParams({ quality, label, source });
    const es = new EventSource(
      `/api/chapter/${chapterId}/prepare?${params}`
    );

    es.addEventListener("progress", (ev) => {
      const { done, total } = JSON.parse(ev.data);
      const pct = total ? Math.round((done / total) * 100) : 0;
      fill.style.width = pct + "%";
      setStatus(li, `${done}/${total} pages`);
    });

    es.addEventListener("ready", (ev) => {
      const { jobId } = JSON.parse(ev.data);
      es.close();
      fill.style.width = "100%";
      setStatus(li, "Saving PDF…", "ok");
      // Trigger the browser download of the assembled PDF.
      triggerDownload(`/api/chapter/download/${jobId}`);
      setStatus(li, "Done ✓", "ok");
      resolve();
    });

    es.addEventListener("error", (ev) => {
      es.close();
      let msg = "Failed";
      try { msg = JSON.parse(ev.data).message; } catch {}
      setStatus(li, msg, "err");
      resolve(); // continue with the next chapter regardless
    });
  });
}

// Prepare several chapters server-side and download them as one .zip of PDFs.
// A single SSE stream reports combined progress; `index` tells us which row.
function downloadZip(rows) {
  return new Promise((resolve) => {
    const items = rows.map((li) => ({
      id: li.dataset.id,
      label: pdfLabel(li.dataset.id),
    }));
    const fills = rows.map((li) => ensureBar(li));
    rows.forEach((li) => setStatus(li, "Queued…"));

    const quality = qualitySel.value === "original" ? "original" : "datasaver";
    const params = new URLSearchParams({
      source,
      quality,
      name: mangaTitle,
      items: JSON.stringify(items),
    });
    const es = new EventSource(`/api/zip/prepare?${params}`);

    es.addEventListener("progress", (ev) => {
      const { index, done, pages } = JSON.parse(ev.data);
      const li = rows[index];
      if (!li) return;
      const pct = pages ? Math.round((done / pages) * 100) : 0;
      fills[index].style.width = pct + "%";
      setStatus(li, `${done}/${pages} pages`);
    });

    es.addEventListener("ready", (ev) => {
      const { jobId } = JSON.parse(ev.data);
      es.close();
      rows.forEach((li, i) => {
        fills[i].style.width = "100%";
        setStatus(li, "Zipped ✓", "ok");
      });
      triggerDownload(`/api/zip/download/${jobId}`);
      resolve();
    });

    es.addEventListener("error", (ev) => {
      es.close();
      let msg = "Zip failed";
      try { msg = JSON.parse(ev.data).message; } catch {}
      rows.forEach((li) => setStatus(li, msg, "err"));
      resolve();
    });
  });
}

function triggerDownload(href) {
  const a = document.createElement("a");
  a.href = href;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function escapeHtml(s = "") {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
