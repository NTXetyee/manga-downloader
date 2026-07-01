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
const downloadBtn = $("#download-btn");

let chapters = [];

function showAlert(msg) {
  alertBox.textContent = msg;
  alertBox.classList.remove("hidden");
}
function clearAlert() {
  alertBox.classList.add("hidden");
}

// -------------------------------------------------------------------------
// Load manga + chapters
// -------------------------------------------------------------------------
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAlert();
  mangaSec.classList.add("hidden");
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

    chapters = data.chapters;
    renderManga(data.manga, chapters);
  } catch (err) {
    showAlert(err.message);
  } finally {
    loadBtn.disabled = false;
    loadBtn.textContent = "Load";
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

    const label = c.chapter ? `Ch. ${c.chapter}` : "Oneshot";
    const vol = c.volume ? `Vol. ${c.volume} · ` : "";

    li.innerHTML = `
      <input type="checkbox" class="pick" />
      <div class="info">
        <div class="num">${label} <span class="ttl">${c.title ? "— " + escapeHtml(c.title) : ""}</span></div>
        <div class="grp">${vol}${c.pages} pages · ${escapeHtml(c.group)}</div>
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

  for (const li of rows) {
    await downloadOne(li);
  }

  downloadBtn.disabled = false;
});

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
    const ch = chapters.find((c) => c.id === chapterId);
    const label = ch?.chapter ? `chapter-${ch.chapter}` : `oneshot-${chapterId.slice(0, 6)}`;
    const quality = qualitySel.value === "original" ? "original" : "datasaver";
    const fill = ensureBar(li);

    setStatus(li, "Starting…");
    const params = new URLSearchParams({ quality, label });
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
