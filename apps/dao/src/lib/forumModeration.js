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
  BAN_VOTE: "ban_vote",
};

export const CRITICAL_CONFIRM_REQUIRED = 2;
export const CRITICAL_CONFIRM_WINDOW_MS = 48 * 60 * 60 * 1000; // 48h
export const BAN_QUORUM_PCT = 0.5; // 50%+ of Shield holders
export const BAN_VOTING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, matches DisciplineModule

// ── Automatic temporary quarantine based on report velocity ────────────
// Same idea and thresholds as dossier's moderationActions.js: closes the
// gap between "a post has already caused harm" and "Shield/Council had
// time to vote" — if AUTO_QUARANTINE_REPORT_THRESHOLD DIFFERENT wallets
// report the same post within AUTO_QUARANTINE_WINDOW_MS, it gets the
// same `blurred` state as a manual moderator BLUR would give it. Not a
// ban, not a hide — the mildest action, still visible on click. A single
// wallet filing repeated reports doesn't count more than once (only
// UNIQUE reporterAddress values within the window matter).
export const AUTO_QUARANTINE_REPORT_THRESHOLD = 5;
export const AUTO_QUARANTINE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

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

/**
 * Finds the earliest moment when the number of DIFFERENT reporters for a
 * targetEventId within a sliding AUTO_QUARANTINE_WINDOW_MS window first
 * reached AUTO_QUARANTINE_REPORT_THRESHOLD. Returns null if that never
 * happened (even if the total report count exceeds the threshold, but
 * spread out over a period wider than the window — a slow natural
 * stream of reports should go through the normal queue, not automation).
 * Ported 1:1 from dossier's moderationActions.js.
 */
export function findAutoQuarantineTrigger(reports, targetEventId) {
  if (!reports || reports.length === 0) return null;

  const relevant = reports
    .filter((r) => r.targetEventId === targetEventId && r.reporterAddress)
    .map((r) => ({ reporter: r.reporterAddress.toLowerCase(), at: r.createdAt * 1000 }))
    .sort((a, b) => a.at - b.at);

  if (relevant.length < AUTO_QUARANTINE_REPORT_THRESHOLD) return null;

  let left = 0;
  const countInWindow = new Map();

  for (let right = 0; right < relevant.length; right++) {
    const cur = relevant[right];
    countInWindow.set(cur.reporter, (countInWindow.get(cur.reporter) || 0) + 1);

    while (relevant[left].at < cur.at - AUTO_QUARANTINE_WINDOW_MS) {
      const old = relevant[left];
      const c = countInWindow.get(old.reporter) - 1;
      if (c <= 0) countInWindow.delete(old.reporter);
      else countInWindow.set(old.reporter, c);
      left++;
    }

    if (countInWindow.size >= AUTO_QUARANTINE_REPORT_THRESHOLD) {
      return { triggeredAt: cur.at, distinctReporters: countInWindow.size };
    }
  }

  return null;
}

// ── Reading/publishing moderation actions ──────────────────────────────

function buildModActionContent({ action, targetEventId, targetAddress }) {
  return JSON.stringify({ app: "hrpdao-forum-mod", v: 1, action, targetEventId, targetAddress });
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
    targetEventId: parsed.targetEventId || null,
    targetAddress: parsed.targetAddress || null,
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
 * Signs and publishes a single moderation action event. `targetEventId`
 * for content actions (blur/hide/critical/confirm); `targetAddress` for
 * BAN_VOTE, which concerns an account, not one specific post.
 * `signEvent`/`getSignerPubkey`/`address` — pass through from
 * useNostrIdentity()/dao, same signer identity as everything else this
 * app publishes to Nostr with (see useForum.js).
 */
export async function publishModAction({
  action,
  targetEventId = null,
  targetAddress = null,
  getSignerPubkey,
  signEvent,
  address,
}) {
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
      content: buildModActionContent({ action, targetEventId, targetAddress }),
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
 *  - auto-quarantine: if a 3rd argument `{ reports }` is provided,
 *    findAutoQuarantineTrigger() is additionally computed and, absent a
 *    more recent manual moderator decision, sets blurred=true itself.
 *    Without the 3rd argument, behaves exactly as before (backward
 *    compatible with the calls added in the previous step).
 */
export function computeModerationState(actions, targetEventId, { reports = null } = {}) {
  const relevant = actions.filter((a) => a.targetEventId === targetEventId);

  let blurred = false;
  let hidden = false;
  let hiddenBy = null;
  let hiddenReason = null; // "hide" | "critical" | null
  let criticalHideAt = null;
  let criticalHideBy = null;
  let criticalConfirmations = [];
  // Last EXPLICIT manual blur/unblur — compared against when
  // auto-quarantine would trigger below, so a human decision made AFTER
  // the report spike takes priority over the automation.
  let lastManualBlurActionAt = null;
  let lastManualUnblurActionAt = null;

  for (const a of relevant) {
    if (a.action === MOD_ACTIONS.BLUR) {
      blurred = true;
      lastManualBlurActionAt = a.createdAt * 1000;
    } else if (a.action === MOD_ACTIONS.UNBLUR) {
      blurred = false;
      lastManualUnblurActionAt = a.createdAt * 1000;
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

  // ── Auto-quarantine ────────────────────────────────────────────────
  // Only meaningful if not already hidden — blur adds nothing to
  // something already invisible.
  let autoQuarantined = false;
  let autoQuarantineTriggeredAt = null;
  let autoQuarantineDistinctReporters = 0;

  if (reports && !hidden) {
    const trigger = findAutoQuarantineTrigger(reports, targetEventId);
    if (trigger) {
      const humanReviewedAfterTrigger =
        (lastManualBlurActionAt !== null && lastManualBlurActionAt >= trigger.triggeredAt) ||
        (lastManualUnblurActionAt !== null && lastManualUnblurActionAt >= trigger.triggeredAt);

      if (!humanReviewedAfterTrigger) {
        autoQuarantined = true;
        autoQuarantineTriggeredAt = trigger.triggeredAt;
        autoQuarantineDistinctReporters = trigger.distinctReporters;
        blurred = true;
      }
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
    autoQuarantined,
    autoQuarantineTriggeredAt,
    autoQuarantineDistinctReporters,
  };
}

/**
 * Computes the ban-voting state for a SINGLE account (by EOA address).
 * Ported 1:1 from dossier's computeBanState.
 *
 * totalEligibleVoters should be shieldInfo.totalSupply (NOT Shield +
 * Council summed — Council is a subset of Shield under the current
 * minting model, see DaoGovernor.quorum()'s same invariant).
 */
export function computeBanState(actions, targetAddress, totalEligibleVoters) {
  const relevant = actions.filter(
    (a) => a.action === MOD_ACTIONS.BAN_VOTE && a.targetAddress?.toLowerCase() === targetAddress?.toLowerCase(),
  );

  if (relevant.length === 0) {
    return { voters: [], quorumPct: 0, banned: false, votingDeadline: null, expired: false };
  }

  const firstVoteAt = relevant[0].createdAt * 1000;
  const votingDeadline = firstVoteAt + BAN_VOTING_WINDOW_MS;
  const expired = Date.now() > votingDeadline;

  const withinWindow = relevant.filter((a) => a.createdAt * 1000 <= votingDeadline);
  const distinctVoters = [...new Set(withinWindow.map((a) => a.moderatorAddress?.toLowerCase()))];
  const quorumPct = totalEligibleVoters > 0 ? (distinctVoters.length / totalEligibleVoters) * 100 : 0;

  return {
    voters: distinctVoters,
    quorumPct,
    banned: quorumPct >= BAN_QUORUM_PCT * 100,
    votingDeadline,
    expired,
  };
}
