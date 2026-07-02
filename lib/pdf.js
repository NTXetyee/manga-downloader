// lib/pdf.js
// Build a PDF from an ordered list of image buffers. Two entry points:
//   • streamChapterPdf   — pipe the PDF straight to an HTTP response (single
//                          chapter download; nothing touches disk).
//   • buildChapterPdfBuffer — resolve the finished PDF as a Buffer, used to
//                          collect multiple chapters into a ZIP.

import PDFDocument from "pdfkit";

// PDFKit natively embeds JPEG and PNG. MangaDex "data-saver" pages are always
// JPEG; "data" (original) pages and Dynasty Scans pages are JPEG or PNG. Both
// are covered without any image-conversion dependency.

// Identify a buffer by its magic bytes, so a failed page tells us *why* it
// failed (wrong URL -> HTML; unsupported codec -> webp/gif; etc.).
function sniff(buf) {
  if (!buf || buf.length < 4) return "empty";
  const b = buf;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  if (
    b.length > 12 &&
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  )
    return "webp";
  if (b.toString("utf8", 0, 64).trimStart().startsWith("<")) return "html/xml";
  return "unknown";
}

// Add every image as its own native-sized page. Shared by both entry points so
// the single-chapter and ZIP paths render identically.
function renderPages(doc, images) {
  images.forEach((buf, i) => {
    try {
      // openImage lets us size each page to the native image dimensions so
      // pages aren't stretched or letter-boxed.
      const img = doc.openImage(buf);
      doc.addPage({ size: [img.width, img.height], margin: 0 });
      doc.image(img, 0, 0);
    } catch {
      // A single corrupt/unsupported page shouldn't kill the whole chapter.
      // Log what we actually received so the cause is diagnosable server-side.
      console.warn(
        `pdf: page ${i + 1} not embeddable — format=${sniff(buf)} size=${buf?.length || 0}B`
      );
      doc
        .addPage({ size: [800, 1200], margin: 40 })
        .fontSize(20)
        .text(`[ page could not be rendered — ${sniff(buf)} ]`, { align: "center" });
    }
  });

  // If every page failed we still need a valid one-page PDF.
  if (doc.bufferedPageRange().count === 0) {
    doc.addPage().fontSize(20).text("No pages could be downloaded.");
  }
}

export function streamChapterPdf(res, { filename, images }) {
  const doc = new PDFDocument({ autoFirstPage: false, margin: 0 });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(filename)}"`
  );

  doc.pipe(res);
  renderPages(doc, images);
  doc.end();
}

// Assemble the PDF entirely in memory and resolve it as a single Buffer.
export function buildChapterPdfBuffer({ images }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false, margin: 0 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    renderPages(doc, images);
    doc.end();
  });
}
