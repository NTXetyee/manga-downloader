// lib/sources.js
// Registry of manga sources. Each module implements the same small interface:
//   id, name, match(url), parseId(url), getManga(id), getChapters(id, lang),
//   getChapterPageUrls(chapterId, opts), downloadImage(url)
//
// To add a new source: create lib/<source>.js, implement that interface, and
// append it to SOURCES below. Everything else (server routes, UI) is generic.

import * as mangadex from "./mangadex.js";
import * as dynasty from "./dynasty.js";

// Order = match priority. Host-specific sources first; MangaDex last since its
// match() also accepts bare UUIDs as a fallback.
export const SOURCES = [dynasty, mangadex];

// Pick the source that recognises a pasted URL (or bare id).
export function resolveSource(url) {
  return SOURCES.find((s) => s.match(url)) || null;
}

// Look a source up by its stable id (sent back by the client on later calls).
export function getSource(id) {
  return SOURCES.find((s) => s.id === id) || null;
}
