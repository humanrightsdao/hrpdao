export function truncAddr(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function fmtNum(n, digits = 0) {
  const v = typeof n === "string" ? Number(n) : n;
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
  }).format(v);
}

// Seconds (epoch) -> "in 3h" / "12m ago" etc.
export function fmtRelative(unixSeconds) {
  if (!unixSeconds) return "—";
  const now = Date.now() / 1000;
  const diff = Number(unixSeconds) - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
}

// Duration in seconds -> "3d 4h" / "12m" etc. Adaptive — on testnet the
// requirement may be a matter of minutes, on a future mainnet it's most
// likely tens of days; rounding to whole days (as before) would hide the
// requirement behind a zero on testnet.
export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s === 0) return "0m";
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${s}s`;
}

// Seconds (epoch) -> "Aug 11, 2026, 14:30"
export function fmtDateTime(unixSeconds) {
  if (!unixSeconds) return "—";
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(Number(unixSeconds) * 1000));
}

// Colors only — the label text is looked up from dao.proposalStates.*
// in the active locale by the component (see StatusStamp.jsx), so this
// stays a plain (non-hook) module that any code can import.
export const STATE_META = {
  Pending: { color: "#8B8F99" },
  Active: { color: "#3B7DFF" },
  Canceled: { color: "#8B8F99" },
  Defeated: { color: "#e8a0b0" },
  Succeeded: { color: "#C9A227" },
  Queued: { color: "#C9A227" },
  Expired: { color: "#e8a0b0" },
  Executed: { color: "#6FA0FF" },
};
