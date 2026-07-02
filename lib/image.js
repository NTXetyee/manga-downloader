// lib/image.js
// Normalize downloaded page images into something PDFKit can embed.
//
// PDFKit only embeds JPEG and PNG. Some sources (notably Dynasty Scans) serve
// WebP — and can serve GIF/other formats — which PDFKit rejects, producing
// blank "could not be rendered" pages. We transcode those to JPEG with `sharp`.
//
// `sharp` is a NATIVE dependency, so it's loaded lazily via dynamic import and
// treated as optional: if it isn't installed the app still runs and simply
// can't convert (WebP pages fall back as before). Install it to enable Dynasty:
//   npm install sharp

// Identify a buffer by its magic bytes.
export function sniff(buf) {
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

// Cache the sharp lookup (resolves to the module, or null if unavailable).
let sharpPromise;
function getSharp() {
  if (sharpPromise === undefined) {
    sharpPromise = import("sharp")
      .then((m) => m.default)
      .catch(() => {
        console.warn(
          "lib/image: `sharp` is not installed — WebP/GIF pages can't be converted. Run `npm install sharp`."
        );
        return null;
      });
  }
  return sharpPromise;
}

// Return a buffer PDFKit can embed. JPEG/PNG pass through untouched; anything
// else is transcoded to JPEG (flattened onto white so WebP alpha doesn't turn
// black). On any failure the original buffer is returned so the caller's own
// fallback still applies.
export async function toEmbeddable(buf) {
  const kind = sniff(buf);
  if (kind === "jpeg" || kind === "png") return buf;
  if (kind === "empty" || kind === "html/xml") return buf; // not an image at all

  const sharp = await getSharp();
  if (!sharp) return buf;
  try {
    return await sharp(buf)
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch (err) {
    console.warn(`lib/image: ${kind} conversion failed — ${err.message}`);
    return buf;
  }
}
