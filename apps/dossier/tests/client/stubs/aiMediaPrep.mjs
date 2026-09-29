// Stub for utils/aiMediaPrep.js — real image/video decoding needs Canvas/<video>,
// which jsdom does not implement. Tests script the outcome via
// globalThis.__prepareMedia = (file) => ({kind, parts}) | throws.
export const SUPPORTED_MODERATION_MIMES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"];
export const VIDEO_DURATION_HINT = 30;

export function mediaKindOf(file) {
  if (!file) return null;
  if (file.type === "application/pdf") return "pdf";
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  return null;
}

export function isModerationSupported(file) {
  const kind = mediaKindOf(file);
  if (kind === "video") return true;
  return kind ? SUPPORTED_MODERATION_MIMES.includes(file.type) : false;
}

export async function prepareMediaForModeration(file) {
  if (globalThis.__prepareMedia) return globalThis.__prepareMedia(file);
  const kind = mediaKindOf(file) || "image";
  return { kind, parts: [{ mime: file.type || "image/jpeg", data: file.__marker || "OK" }] };
}
