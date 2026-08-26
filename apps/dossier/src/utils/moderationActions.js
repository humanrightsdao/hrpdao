// src/utils/moderationActions.js
//
// Moderation actions available to Shield/Council-status holders over
// content and accounts: blur, urgent hide, critical hide (extremism/CSAM),
// ban voting against an account without SBT status.
//
// Same pattern as postReports.js - a regular Lens comment/post with a
// special prefix marker in content. No new smart contract: the FRONTEND
// itself computes the current state (blurred/hidden/banned) from the
// stream of these actions on every load - the same way CountryFeed.jsx
// already tallies reports from postReports.js.
//
// Moderator accountability: Shield/Council members are themselves SBT
// holders, so abuse of this right (wrongfully hiding legitimate content)
// is by itself grounds for a regular sanction against THEM via the
// already-existing DisciplineModule.proposeSanction() - no separate
// mechanism is needed for this.
//
// ⚠️ As with postReports.js - this is NOT privacy, Lens content is public
// by protocol design. The marker only hides these entries from the UI of
// the normal thread.
//
// ⚠️ Limits of what's possible: "banning an account" and "hiding" here
// always mean only "within this app". Neither a Lens Account nor a user's
// wallet can be deleted or blocked at the protocol level - it's their
// property, and Lens doesn't give third-party apps that right.

import { evmAddress } from "@lens-protocol/client";
import { fetchPosts } from "@lens-protocol/client/actions";
import { lensClient } from "../lib/lens";

const APP_ADDRESS = import.meta.env.VITE_LENS_APP_ADDRESS;

export const MOD_ACTION_TAG = "[HRDAO_MOD_ACTION]";

// A Lens tag (tags: [...]) - unlike comments (blur/hide/critical - always
// have commentOn: targetPostId, so they're already naturally excluded from
// feeds by the "!item.commentOn" filter in useLensPosts.js), an account
// ban vote (ban_vote) is published as a REGULAR Lens post (there's no
// natural "post" to attach it to - it concerns an account, not a specific
// post). To keep such a post from showing up in the regular feed,
// MOD_ACTION_POST_TAG needs to be added to NON_FEED_TAGS (useLensPosts.js).
export const MOD_ACTION_POST_TAG = "mod_action";

export const MOD_ACTIONS = {
  BLUR: "blur",
  UNBLUR: "unblur",
  HIDE: "hide",
  UNHIDE: "unhide",
  CRITICAL_HIDE: "critical_hide",
  CRITICAL_CONFIRM: "critical_confirm",
  BAN_VOTE: "ban_vote",
};

// ── Thresholds/windows - named constants, to make it easy to change
//    without rewriting the logic (as agreed - 50% for a ban "for now",
//    can be changed to a fixed number later without changing computeBanState()).
export const CRITICAL_CONFIRM_REQUIRED = 2; // + critical_hide itself as the 1st "vote" - these 2 are ADDITIONAL
export const CRITICAL_CONFIRM_WINDOW_MS = 48 * 60 * 60 * 1000; // 48h to confirm
export const BAN_QUORUM_PCT = 0.5; // 50%+ of Shield holders
export const BAN_VOTING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, matches DisciplineModule

export function buildModActionContent({
  action,
  targetPostId = null,
  targetAccount = null,
}) {
  const payload = {
    app: "hrdao-mod",
    v: 1,
    action,
    targetPostId,
    targetAccount,
  };
  return `${MOD_ACTION_TAG}${JSON.stringify(payload)}`;
}

export function isModActionComment(content) {
  return typeof content === "string" && content.startsWith(MOD_ACTION_TAG);
}

export function parseModActionComment(content) {
  if (!isModActionComment(content)) return null;
  try {
    const json = content.slice(MOD_ACTION_TAG.length);
    const data = JSON.parse(json);
    if (data.app !== "hrdao-mod") return null;
    return data;
  } catch {
    return null;
  }
}

// Several components on the same page (RightSidebar computes this both for
// "Violations" and "Help Requests"; plus ViolationsListPage/SupportPage
// elsewhere) each call fetchAllModActions() with their own
// useEffect+setInterval. Without a cache, this means N identical full
// fetchPosts() scans running at once. A module-level cache (not a hook,
// not a separate file) - TTL plus dedup of parallel calls via a single
// shared promise.
const MOD_ACTIONS_CACHE_TTL_MS = 30 * 1000;
let _modActionsCache = null;
let _modActionsCacheAt = 0;
let _modActionsInFlight = null;

/**
 * Resets the cache - call immediately after successfully publishing a new
 * moderation action (blur/hide/...), so you don't have to wait for the
 * TTL to see your own action.
 */
export function invalidateModActionsCache() {
  _modActionsCache = null;
  _modActionsCacheAt = 0;
}

/**
 * Scans all of the app's posts (posts and comments - fetchPosts with an
 * apps filter returns both types) and extracts moderation actions.
 * Returns a flat list, SORTED CHRONOLOGICALLY (oldest → newest) - the
 * reducers below (computeModerationState/computeBanState) expect exactly
 * this order, since for blur/hide/unhide what matters is which action was
 * the LAST one.
 */
export async function fetchAllModActions() {
  const now = Date.now();
  if (_modActionsCache && now - _modActionsCacheAt < MOD_ACTIONS_CACHE_TTL_MS) {
    return _modActionsCache;
  }
  // Several components mounted at the same time and both missed the
  // cache - give them the same promise instead of two parallel scans.
  if (_modActionsInFlight) {
    return _modActionsInFlight;
  }

  _modActionsInFlight = (async () => {
    const actions = [];
    let cursor;

    do {
      const result = await fetchPosts(lensClient, {
        filter: { apps: [evmAddress(APP_ADDRESS)] },
        cursor,
      });

      if (result.isErr()) {
        throw new Error(
          result.error?.message || "Failed to load moderation actions",
        );
      }

      const { items, pageInfo } = result.value;
      for (const item of items) {
        const content = item.metadata?.content;
        if (!isModActionComment(content)) continue;

        const parsed = parseModActionComment(content);
        if (!parsed) continue; // malformed JSON - skip, don't fail the whole tally

        actions.push({
          id: item.id,
          // .owner - the EOA owner of the Lens Account (the same path
          // already used to resolve sanction targets in
          // DisciplineModule) - quorum counting and "peer review" (not
          // the same moderator) should rely on the REAL owner, not the
          // Lens Account smart contract.
          moderator: item.author?.owner || item.author?.address || null,
          createdAt: item.timestamp,
          ...parsed, // action, targetPostId, targetAccount
        });
      }

      cursor = pageInfo?.next || undefined;
    } while (cursor);

    actions.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    return actions;
  })();

  try {
    const actions = await _modActionsInFlight;
    _modActionsCache = actions;
    _modActionsCacheAt = Date.now();
    return actions;
  } finally {
    _modActionsInFlight = null;
  }
}

// ── Automatic temporary quarantine based on report velocity ──────────────
//
// Goal: close the gap between "a post has already caused harm" and
// "Shield/Council had time to vote" (sanction voting - BAN_VOTING_WINDOW_MS,
// 7 days). If a post receives reports from AUTO_QUARANTINE_REPORT_THRESHOLD
// DIFFERENT wallets within AUTO_QUARANTINE_WINDOW_MS - it automatically
// gets the same `blurred` state as a manual moderator BLUR. This is NOT a
// ban and NOT a hide - it stays the mildest action available (visible on
// click via onRevealBlurred), just without waiting for manual review.
//
// Anti-abuse: only UNIQUE reporterAddress values within the window are
// counted - a single wallet that files 5 reports in a row does not by
// itself trigger quarantine (each report is a separate Lens comment/gas
// cost, but Lens Chain's cheap gas shouldn't be considered a reliable
// Sybil barrier).
//
// Human override: if a Shield/Council moderator EXPLICITLY did a BLUR or
// UNBLUR LATER (or at the same moment) than the auto-quarantine would have
// triggered - the manual decision is trusted and automation is NOT
// applied. If NEW reports come in after that (a new wave AFTER the manual
// action) - the count for the window starts over from them, and
// quarantine can trigger again.
export const AUTO_QUARANTINE_REPORT_THRESHOLD = 5;
export const AUTO_QUARANTINE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Finds the earliest moment when the number of DIFFERENT reporters for a
 * postId within a sliding AUTO_QUARANTINE_WINDOW_MS window first reached
 * AUTO_QUARANTINE_REPORT_THRESHOLD. Returns null if no such moment
 * occurred (even if the total number of reports exceeds the threshold,
 * but they're spread out over a period wider than the window - that's not
 * a "spike", just a slow natural stream of reports that should go through
 * the normal ModerationQueue path, without automation).
 *
 * @param {Array} reports - flat list of reports from utils/postReports.js
 *   (fetchAllReportComments()) - expects parentPostId, reporterAddress,
 *   createdAt fields (the same format already used by ModerationQueue.jsx).
 * @param {string} postId - the lens_post_id of the post being counted for.
 */
export function findAutoQuarantineTrigger(reports, postId) {
  if (!reports || reports.length === 0) return null;

  const relevant = reports
    .filter((r) => r.parentPostId === postId && r.reporterAddress)
    .map((r) => ({
      reporter: r.reporterAddress.toLowerCase(),
      at: new Date(r.createdAt).getTime(),
    }))
    .filter((r) => Number.isFinite(r.at))
    .sort((a, b) => a.at - b.at);

  if (relevant.length < AUTO_QUARANTINE_REPORT_THRESHOLD) return null;

  // Sliding window with two pointers: right walks through all reports
  // chronologically, left advances until the oldest report in the window
  // fits within AUTO_QUARANTINE_WINDOW_MS of the current one (right).
  // countInWindow tracks how many times EACH reporter appears in the
  // current window - the size of the map (number of KEYS) is the number
  // of UNIQUE reporters in the window.
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
      return {
        triggeredAt: cur.at,
        distinctReporters: countInWindow.size,
      };
    }
  }

  return null;
}

/**
 * Computes the current moderation state of a SINGLE post from the full
 * action log.
 *
 * Rules:
 *  - blur/unblur: the last chronological action wins, by anyone from Shield/Council.
 *  - hide: 1 vote hides immediately. unhide can be applied by ANYONE ELSE
 *    (not the same moderator who hid it) - intentional "peer review", so
 *    that one moderator can't both hide something and immediately unhide
 *    it themselves without anyone else's review.
 *  - critical_hide: hides INSTANTLY (for extremism/CSAM). Requires
 *    CRITICAL_CONFIRM_REQUIRED confirmations from OTHER moderators within
 *    CRITICAL_CONFIRM_WINDOW_MS - otherwise it automatically reverts.
 *    "Automatically" here just means a time-based computation on every
 *    render (Date.now() > deadline) - no separate "revert" action needs
 *    to be written to the log.
 *  - auto-quarantine: if the 3rd argument `{ reports }` is provided,
 *    findAutoQuarantineTrigger() is additionally computed and, absent a
 *    more recent manual moderator decision, sets blurred=true itself (see
 *    the block below before the return). Without the 3rd argument, the
 *    function's behavior is identical to the previous version (backward
 *    compatible with existing calls).
 */
export function computeModerationState(actions, postId, { reports = null } = {}) {
  const relevant = actions.filter((a) => a.targetPostId === postId);

  let blurred = false;
  let hidden = false;
  let hiddenBy = null;
  let hiddenReason = null; // "hide" | "critical" | null
  let criticalHideAt = null;
  let criticalHideBy = null;
  let criticalConfirmations = [];
  // Timestamp of the last EXPLICIT manual blur/unblur action - needed to
  // compare against the moment auto-quarantine would trigger below
  // (manual moderator review takes priority over automation if it
  // happened after the wave of reports that would have triggered quarantine).
  let lastManualBlurActionAt = null;
  let lastManualUnblurActionAt = null;

  for (const a of relevant) {
    const actionAt = new Date(a.createdAt).getTime();
    if (a.action === MOD_ACTIONS.BLUR) {
      blurred = true;
      lastManualBlurActionAt = actionAt;
    } else if (a.action === MOD_ACTIONS.UNBLUR) {
      blurred = false;
      lastManualUnblurActionAt = actionAt;
    } else if (a.action === MOD_ACTIONS.HIDE) {
      hidden = true;
      hiddenBy = a.moderator;
      hiddenReason = "hide";
    } else if (a.action === MOD_ACTIONS.UNHIDE) {
      if (a.moderator !== hiddenBy) {
        hidden = false;
        hiddenBy = null;
        hiddenReason = null;
      }
      // if the same moderator who hid it tries to unhide it themselves -
      // ignore this action entirely (peer review).
    } else if (a.action === MOD_ACTIONS.CRITICAL_HIDE) {
      hidden = true;
      hiddenReason = "critical";
      hiddenBy = a.moderator;
      criticalHideAt = a.createdAt;
      criticalHideBy = a.moderator;
      criticalConfirmations = [];
    } else if (a.action === MOD_ACTIONS.CRITICAL_CONFIRM) {
      if (
        hiddenReason === "critical" &&
        a.moderator !== criticalHideBy &&
        !criticalConfirmations.includes(a.moderator)
      ) {
        criticalConfirmations.push(a.moderator);
      }
    }
  }

  let criticalDeadline = null;
  let criticalConfirmed = false;

  if (hiddenReason === "critical" && criticalHideAt) {
    criticalDeadline =
      new Date(criticalHideAt).getTime() + CRITICAL_CONFIRM_WINDOW_MS;
    criticalConfirmed =
      criticalConfirmations.length >= CRITICAL_CONFIRM_REQUIRED;

    // Auto-revert: the deadline has passed without reaching the confirmation quorum.
    if (!criticalConfirmed && Date.now() > criticalDeadline) {
      hidden = false;
      hiddenReason = null;
      hiddenBy = null;
    }
  }

  // ── Auto-quarantine based on report velocity ─────────────────────────────
  // Only computed if the post isn't already hidden (hide/critical) - for a
  // hidden post, blur adds nothing, it's already invisible.
  // reports is an optional parameter: if the caller doesn't pass it (old
  // calls without the 3rd argument remain fully compatible), auto-quarantine
  // simply isn't computed.
  let autoQuarantined = false;
  let autoQuarantineTriggeredAt = null;
  let autoQuarantineDistinctReporters = 0;

  if (reports && !hidden) {
    const trigger = findAutoQuarantineTrigger(reports, postId);
    if (trigger) {
      // Did a moderator make an EXPLICIT decision (blur OR unblur) after
      // (or at the same moment as) the report threshold was reached? If
      // so - this case has already been reviewed, trust the human decision.
      const humanReviewedAfterTrigger =
        (lastManualBlurActionAt !== null &&
          lastManualBlurActionAt >= trigger.triggeredAt) ||
        (lastManualUnblurActionAt !== null &&
          lastManualUnblurActionAt >= trigger.triggeredAt);

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
    // Auto-quarantine flag and metadata - separate from `blurred`, so the
    // UI can optionally show a different message ("automatic, due to
    // report velocity" instead of "blurred by moderator") wherever the
    // display component knows about it (e.g. ModerationQueue.jsx).
    autoQuarantined,
    autoQuarantineTriggeredAt,
    autoQuarantineDistinctReporters,
  };
}

/**
 * Computes the ban-voting state for a SINGLE account (by EOA address).
 *
 * totalEligibleVoters - the current number of Shield holders (not Shield +
 * Council separately - under the current minting model, Council can only
 * be obtained AFTER a period of Shield membership, i.e. Council is a
 * subset of Shield, not an additional separate group; summing
 * totalSupply() of both contracts would mean double-counting the same
 * people (the same invariant we fixed in DaoGovernor.quorum()'s quorum -
 * only shieldSBT.totalSupply(), not Shield+Council). If the minting model
 * ever changes to be independent - this calculation should be revisited).
 */
export function computeBanState(actions, targetAccount, totalEligibleVoters) {
  const relevant = actions.filter(
    (a) =>
      a.action === MOD_ACTIONS.BAN_VOTE &&
      a.targetAccount?.toLowerCase() === targetAccount?.toLowerCase(),
  );

  if (relevant.length === 0) {
    return {
      voters: [],
      quorumPct: 0,
      banned: false,
      votingDeadline: null,
      expired: false,
    };
  }

  const firstVoteAt = new Date(relevant[0].createdAt).getTime();
  const votingDeadline = firstVoteAt + BAN_VOTING_WINDOW_MS;
  const expired = Date.now() > votingDeadline;

  const withinWindow = relevant.filter(
    (a) => new Date(a.createdAt).getTime() <= votingDeadline,
  );
  const distinctVoters = [...new Set(withinWindow.map((a) => a.moderator))];
  const quorumPct =
    totalEligibleVoters > 0
      ? (distinctVoters.length / totalEligibleVoters) * 100
      : 0;

  return {
    voters: distinctVoters,
    quorumPct,
    banned: quorumPct >= BAN_QUORUM_PCT * 100,
    votingDeadline,
    expired,
  };
}

/**
 * Standalone (no React, no useLensDAO hook) reader of Shield
 * totalSupply() - needed for the root-level ban gate in
 * LensAuthContext.jsx.
 *
 * Deliberately does NOT use useLensDAO() - that hook is tied to its own
 * wallet-connection lifecycle (dao.connect()/silentConnect()), and the
 * ban check needs to work immediately, regardless of whether the user has
 * already called dao.connect() somewhere else in the component tree. The
 * totalSupply() read itself is a public view call, requiring no signature
 * or even a connected wallet - just a public RPC, the same one
 * useLensDAO.js uses to read shieldReadRef/councilReadRef (new
 * ethers.JsonRpcProvider(ACTIVE_CHAIN.rpcUrls[0])).
 */
export async function fetchShieldTotalSupply() {
  try {
    const { ethers } = await import("ethers");
    const { CONTRACTS, ACTIVE_CHAIN } = await import("../hooks/useLensDAO");
    const rp = new ethers.JsonRpcProvider(ACTIVE_CHAIN.rpcUrls[0]);
    const shield = new ethers.Contract(
      CONTRACTS.shieldSBT,
      ["function totalSupply() external view returns (uint256)"],
      rp,
    );
    const supply = await shield.totalSupply();
    return Number(supply);
  } catch (err) {
    console.warn("⚠️ fetchShieldTotalSupply failed:", err.message);
    // Fail-safe: 0 → computeBanState treats totalEligibleVoters<=0 as
    // quorumPct=0 → banned=false. A network error should NEVER by itself
    // ban anyone - only a genuinely reached vote quorum can.
    return 0;
  }
}
