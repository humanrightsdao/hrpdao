// src/utils/liveAlerts.js
//
// Pure logic (no Leaflet, no React) for the LIVE ALERT pins: fresh, serious
// violations shown as pulsing markers on the violations map. They are
// independent of the conflict "danger zones".

// A violation counts as a "live alert" while it is newer than this…
export const LIVE_ALERT_WINDOW_HOURS = 48;
// …and has at least this severity (3 = felony only).
export const LIVE_ALERT_MIN_SEVERITY = 3;

// Dates a little in the future (clock skew, timezone) are tolerated;
// anything further ahead is treated as bad data and ignored.
const FUTURE_SKEW_MS = 6 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const parseTime = (value) => {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};

const getCoords = (violation) => {
  const lat = parseFloat(violation?.latitude);
  const lng = parseFloat(violation?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
};

/**
 * Fresh, serious violations for the pulsing "live alert" pins.
 *
 * "Fresh" uses the NEWER of the event date and the publication time, so a
 * serious violation that happened last week but was only just published
 * still raises an alert.
 *
 * @returns {Array<violation & { alertTime: number }>} newest first.
 */
export const getLiveAlerts = (
  violations,
  {
    now = Date.now(),
    windowHours = LIVE_ALERT_WINDOW_HOURS,
    minSeverity = LIVE_ALERT_MIN_SEVERITY,
  } = {},
) => {
  const alerts = [];

  for (const violation of violations || []) {
    if ((violation.severity_level ?? 1) < minSeverity) continue;
    if (!getCoords(violation)) continue;

    const times = [
      parseTime(violation.violation_date),
      parseTime(violation.created_at),
    ].filter((time) => time !== null && time <= now + FUTURE_SKEW_MS);
    if (times.length === 0) continue;

    const alertTime = Math.max(...times);
    if (now - alertTime > windowHours * HOUR_MS) continue;

    alerts.push({ ...violation, alertTime });
  }

  return alerts.sort((a, b) => b.alertTime - a.alertTime);
};
