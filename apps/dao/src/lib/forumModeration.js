// src/lib/forumModeration.js
//
// The moderation queue for the forum's reports (see useForum.js's
// reportPost() / FORUM_REPORT_TAG). PORTED from dossier-app's own
// src/utils/moderationActions.js — same tally/reducer logic
// (computeModerationState), same action vocabulary (blur/hide/
// critical_hide/critical_confirm), same thresholds/windows. The only
// real difference is the transport: dossier's version reads/writes
// Lens comments (a public, but non-deletable-by-us, GraphQL API);
// this one reads/writes Nostr events on public relays (also
// effectively non-deletable — see useForum.js's own comment on that).
// Same reasoning applies either way: the frontend computes the current
// moderation state from the full action log on every load, there's no
// separate database of "current state" to keep in sync.
//
// Moderator accountability: Shield/Council members are themselves SBT
// holders, so abuse of this right (wrongfully hiding legitimate
// content) is itself grounds for a sanction against THEM via the
// already-existing DisciplineModule.proposeSanction() — see
// ModerationPage.jsx. No separate mechanism needed for that.
//
// ⚠️ Limits of what's possible: "hiding" here always means only WITHIN
// THIS APP's own UI. Nostr events published to public relays cannot be
// reliably deleted or blocked at the protocol level — this only
// changes what THIS app chooses to render.

import { pool, RELAYS, publishEvent } from "./nostrLookup";
import { FORUM_TAG, FORUM_REPORT_TAG } from "../hooks/useForum";

export const MOD_ACTION_TAG = `${FORUM_TAG}-mod-action`;

export const MOD_ACTIONS = {
  BLUR: "blur",
  UNBLUR: "unblur",
  HIDE: "hide",
  UNHIDE: "unhide",
  CRITICAL_HIDE: "critical_hide",
  CRITICAL_CONFIRM: "critical_confirm",
};

export const CRITICAL_CONFIRM_REQUIRED = 2;
export const CRITICAL_CONFIRM_WINDOW_MS = 48 * 60 * 60 * 1000; // 48h

// ── Reading reports (see useForum.js's reportPost — NIP-56 kind:1984) ──

function parseReportEvent(ev) {
  let parsed;
  try {
    parsed = JSON.parse(ev.content);
  } catch {
    return null;
  }
  if (parsed?.app !== "hrpdao-forum-report") return null;
  const eTag = ev.tags.find((t) => t[0] === "e");
  const pTag = ev.tags.find((t) => t[0] === "p");
  if (!eTag) return null;
  return {
    id: ev.id,
    targetEventId: eTag[1],
    targetPubkey: pTag?.[1] || null,
    reporterPubkey: ev.pubkey,
    reporterAddress: parsed.reporterAddress || null,
    category: parsed.category || "other",
    description: parsed.description || "",
    createdAt: ev.created_at,
  };
}

export async function fetchAllForumReports() {
  const events = await pool.querySync(RELAYS, { kinds: [1984], "#t": [FORUM_REPORT_TAG], limit: 500 });
  return events
    .map(parseReportEvent)
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}

// ── Reading/publishing moderation actions ──────────────────────────────

function buildModActionContent({ action, targetEventId }) {
  return JSON.stringify({ app: "hrpdao-forum-mod", v: 1, action, targetEventId });
}

function parseModActionEvent(ev) {
  let parsed;
  try {
    parsed = JSON.parse(ev.content);
  } catch {
    return null;
  }
  if (parsed?.app !== "hrpdao-forum-mod") return null;
  return {
    id: ev.id,
    moderatorPubkey: ev.pubkey,
    // "address" tag, same convention as useForum.js's threads/replies —
    // quorum/peer-review checks below rely on the wallet, not the
    // deterministic Nostr pubkey derived from it (equivalent, but the
    // wallet address is what the rest of the app already keys on).
    moderatorAddress: ev.tags.find((t) => t[0] === "address")?.[1] || null,
    createdAt: ev.created_at,
    action: parsed.action,
    targetEventId: parsed.targetEventId,
  };
}

export async function fetchAllForumModActions() {
  const events = await pool.querySync(RELAYS, { kinds: [1], "#t": [MOD_ACTION_TAG], limit: 1000 });
  return events
    .map(parseModActionEvent)
    .filter(Boolean)
    .sort((a, b) => a.createdAt - b.createdAt); // oldest → newest, reducer expects this order
}

/**
 * Signs and publishes a single moderation action event.
 * `signEvent`/`getSignerPubkey`/`address` — pass through from
 * useNostrIdentity()/dao, same signer identity as everything else this
 * app publishes to Nostr with (see useForum.js).
 */
export async function publishModAction({ action, targetEventId, getSignerPubkey, signEvent, address }) {
  try {
    const pubkey = await getSignerPubkey();
    const unsigned = {
      kind: 1,
      pubkey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["t", MOD_ACTION_TAG],
        ...(address ? [["address", address.toLowerCase()]] : []),
      ],
      content: buildModActionContent({ action, targetEventId }),
    };
    const signed = await signEvent(unsigned);
    const res = await publishEvent(signed);
    if (!res.ok) return { success: false, error: "No relay accepted the moderation action." };
    return { success: true, id: signed.id };
  } catch (e) {
    return { success: false, error: e.message || "Failed to publish the moderation action." };
  }
}

/**
 * Computes the current moderation state of a single thread/reply
 * (identified by its Nostr event id) from the full action log.
 * Identical rules to dossier's computeModerationState:
 *  - blur/unblur: last chronological action wins, by anyone Shield/Council.
 *  - hide: 1 vote hides immediately. unhide requires a DIFFERENT
 *    moderator than the one who hid it (peer review).
 *  - critical_hide: hides INSTANTLY. Needs CRITICAL_CONFIRM_REQUIRED
 *    confirmations from OTHER moderators within CRITICAL_CONFIRM_WINDOW_MS,
 *    or it auto-reverts (computed live against Date.now(), no separate
 *    "revert" event needs to be published).
 */
export function computeModerationState(actions, targetEventId) {
  const relevant = actions.filter((a) => a.targetEventId === targetEventId);

  let blurred = false;
  let hidden = false;
  let hiddenBy = null;
  let hiddenReason = null; // "hide" | "critical" | null
  let criticalHideAt = null;
  let criticalHideBy = null;
  let criticalConfirmations = [];

  for (const a of relevant) {
    if (a.action === MOD_ACTIONS.BLUR) {
      blurred = true;
    } else if (a.action === MOD_ACTIONS.UNBLUR) {
      blurred = false;
    } else if (a.action === MOD_ACTIONS.HIDE) {
      hidden = true;
      hiddenBy = a.moderatorAddress;
      hiddenReason = "hide";
    } else if (a.action === MOD_ACTIONS.UNHIDE) {
      if (a.moderatorAddress !== hiddenBy) {
        hidden = false;
        hiddenBy = null;
        hiddenReason = null;
      }
    } else if (a.action === MOD_ACTIONS.CRITICAL_HIDE) {
      hidden = true;
      hiddenReason = "critical";
      hiddenBy = a.moderatorAddress;
      criticalHideAt = a.createdAt;
      criticalHideBy = a.moderatorAddress;
      criticalConfirmations = [];
    } else if (a.action === MOD_ACTIONS.CRITICAL_CONFIRM) {
      if (
        hiddenReason === "critical" &&
        a.moderatorAddress !== criticalHideBy &&
        !criticalConfirmations.includes(a.moderatorAddress)
      ) {
        criticalConfirmations.push(a.moderatorAddress);
      }
    }
  }

  let criticalDeadline = null;
  let criticalConfirmed = false;
  if (hiddenReason === "critical" && criticalHideAt) {
    criticalDeadline = criticalHideAt * 1000 + CRITICAL_CONFIRM_WINDOW_MS;
    criticalConfirmed = criticalConfirmations.length >= CRITICAL_CONFIRM_REQUIRED;
    if (!criticalConfirmed && Date.now() > criticalDeadline) {
      hidden = false;
      hiddenReason = null;
      hiddenBy = null;
    }
  }

  return {
    blurred,
    hidden,
    hiddenBy,
    hiddenReason,
    criticalHideAt,
    criticalHideBy,
    criticalConfirmations,
    criticalConfirmed,
    criticalDeadline,
  };
}
