// src/utils/aiMediaPrep.js
//
// Turns a File the user picked (image / video / PDF) into the small,
// already-capped payload /api/moderate/media expects — so the network
// request stays light and the server only ever sees a handful of small
// files (see AI_MEDIA limits mirrored below from worker/moderation.js).
//
// Nothing here uploads anywhere: it only reads the file locally (Canvas /
// <video> / FileReader) to build a base64 payload for the moderation
// endpoint. The ORIGINAL file — full resolution, untouched — is what
// actually gets uploaded to Grove afterwards.

export const SUPPORTED_MODERATION_MIMES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
];

const IMAGE_MAX_DIMENSION = 1280; // px, long edge — plenty for a safety read, keeps requests small
const IMAGE_JPEG_QUALITY = 0.82;
const VIDEO_MAX_FRAMES = 6;
const VIDEO_MAX_DURATION_FOR_ALL_FRAMES = 30; // seconds; longer videos are still sampled across their full length
const PDF_MAX_BYTES = 12 * 1024 * 1024; // stays under the server's 14MB cap with base64 overhead
const PREP_TIMEOUT_MS = 15_000;

export function mediaKindOf(file) {
  if (!file) return null;
  if (file.type === "application/pdf") return "pdf";
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  return null;
}

/** Whether canModerateMedia() below can actually do something with this file. */
export function isModerationSupported(file) {
  const kind = mediaKindOf(file);
  if (kind === "video") return true; // any browser-playable video: frames are re-encoded as JPEG
  return kind ? SUPPORTED_MODERATION_MIMES.includes(file.type) : false;
}

const readAsDataURL = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });

const dataUrlToBase64 = (dataUrl) => dataUrl.slice(dataUrl.indexOf(",") + 1);

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Downscales an image to at most IMAGE_MAX_DIMENSION on the long edge and re-encodes as JPEG. */
async function prepareImage(file) {
  const dataUrl = await readAsDataURL(file);
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("Could not decode the image"));
    img.src = dataUrl;
  });

  const scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const jpegDataUrl = canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY);
  return { kind: "image", parts: [{ mime: "image/jpeg", data: dataUrlToBase64(jpegDataUrl) }] };
}

/** Samples up to VIDEO_MAX_FRAMES evenly spaced frames and re-encodes each as JPEG. */
async function prepareVideo(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;

  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error("Could not read the video"));
    });

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
    const frameCount = Math.min(VIDEO_MAX_FRAMES, Math.max(1, Math.ceil(duration)));
    // Skip the very first and last instants (often black/blank) when there's room to.
    const margin = duration > 1 ? Math.min(0.5, duration * 0.05) : 0;
    const span = Math.max(duration - margin * 2, 0.001);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(video.videoWidth, video.videoHeight, 1));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale)) || IMAGE_MAX_DIMENSION;
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale)) || IMAGE_MAX_DIMENSION;

    const parts = [];
    for (let i = 0; i < frameCount; i++) {
      const t =
        margin + (frameCount === 1 ? span / 2 : (span * i) / (frameCount - 1));
      await new Promise((resolve, reject) => {
        const onSeeked = () => {
          video.removeEventListener("seeked", onSeeked);
          resolve();
        };
        video.addEventListener("seeked", onSeeked);
        video.onerror = () => reject(new Error("Could not seek the video"));
        video.currentTime = Math.min(t, Math.max(duration - 0.05, 0));
      });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      parts.push({ mime: "image/jpeg", data: dataUrlToBase64(canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY)) });
    }
    return { kind: "video", parts };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** PDFs are sent as-is (no re-encoding possible); oversized ones are simply skipped. */
async function preparePdf(file) {
  if (file.size > PDF_MAX_BYTES) {
    throw Object.assign(new Error("PDF too large to scan"), { code: "TOO_LARGE" });
  }
  const dataUrl = await readAsDataURL(file);
  return { kind: "pdf", parts: [{ mime: "application/pdf", data: dataUrlToBase64(dataUrl) }] };
}

/**
 * @param {File} file
 * @returns {Promise<{kind:"image"|"video"|"pdf", parts:Array<{mime:string,data:string}>}>}
 * @throws when the file can't be read/decoded, is unsupported, or (PDF) too large.
 *   Callers treat a throw as "could not be checked" (see aiMediaModeration.js).
 */
export async function prepareMediaForModeration(file) {
  const kind = mediaKindOf(file);
  if (!kind) throw Object.assign(new Error("Unsupported file type"), { code: "UNSUPPORTED" });
  const work =
    kind === "image" ? prepareImage(file) : kind === "video" ? prepareVideo(file) : preparePdf(file);
  return withTimeout(work, PREP_TIMEOUT_MS, "Preparing the file for the safety check took too long");
}

export const VIDEO_DURATION_HINT = VIDEO_MAX_DURATION_FOR_ALL_FRAMES;
