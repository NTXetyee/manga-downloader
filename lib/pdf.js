// lib/pdf.js
// Build a PDF from an ordered list of image buffers and stream it straight to
// the HTTP response. Nothing touches disk -> no cleanup needed on Render's
// ephemeral filesystem, and memory is freed as soon as the response ends.

import PDFDocument from "pdfkit";

// PDFKit natively embeds JPEG and PNG. MangaDex "data-saver" pages are always
// JPEG; "data" (original) pages are JPEG or PNG. Both are covered without any
// image-conversion dependency.

export function streamChapterPdf(res, { filename, images }) {
  const doc = new PDFDocument({ autoFirstPage: false, margin: 0 });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(filename)}"`
  );

  doc.pipe(res);

  for (const buf of images) {
    try {
      // openImage lets us size each page to the native image dimensions so
      // pages aren't stretched or letter-boxed.
      const img = doc.openImage(buf);
      doc.addPage({ size: [img.width, img.height], margin: 0 });
      doc.image(img, 0, 0);
    } catch {
      // A single corrupt/unsupported page shouldn't kill the whole chapter.
      doc
        .addPage({ size: [800, 1200], margin: 40 })
        .fontSize(20)
        .text("[ page could not be rendered ]", { align: "center" });
    }
  }

  // If every page failed we still need a valid one-page PDF.
  if (doc.bufferedPageRange().count === 0) {
    doc.addPage().fontSize(20).text("No pages could be downloaded.");
  }

  doc.end();
}
