// src/lib/moderationCheck.js
//
// PORTED (read-only) from dossier-app's src/utils/moderationActions.js —
// this app never PUBLISHES a moderation action (that only happens in
// dossier's own ModerationQueue.jsx), it only needs to know, for the
// read-only world map/feed on the DAO home page, whether a given post is
// currently hidden or its author currently banned, so the DAO app never
// shows content dossier's own moderators have already taken down.
//
// Everything below is a straight copy of dossier's tally/reducer logic
// (fetchAllModActions / computeModerationState / computeBanState) — same
// Lens-native "a regular comment/post with a special content prefix"
// pattern, same module-level cache. Only fetchShieldTotalSupply() is
// adapted: dossier's version reads CONTRACTS.shieldSBT/ACTIVE_CHAIN from
// its OWN hooks/useLensDAO.js — here it reads THIS app's own
// hooks/useDao.js instead, which already exports the exact same
// shieldSBT contract address/chain (dao-app IS the DAO whose contracts
// dossier links out to — no duplication, just the correct local source).
import { evmAddress } from "@lens-protocol/client";
import { fetchPosts } from "@lens-protocol/client/actions";
import { lensClient } from "./lensLookup";

const APP_ADDRESS = import.meta.env.VITE_LENS_APP_ADDRESS;

export const MOD_ACTION_TAG = "[HRDAO_MOD_ACTION]";
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

export const CRITICAL_CONFIRM_REQUIRED = 2;
export const CRITICAL_CONFIRM_WINDOW_MS = 48 * 60 * 60 * 1000;
export const BAN_QUORUM_PCT = 0.5;
export const BAN_VOTING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function isModActionComment(content) {
  return typeof content === "string" && content.startsWith(MOD_ACTION_TAG);
}

function parseModActionComment(content) {
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

// Same module-level cache as dossier's original — several widgets on the
// same home page (map + feed) both need this, without a cache that would
// be two identical full fetchPosts() scans firing at once.
const MOD_ACTIONS_CACHE_TTL_MS = 30 * 1000;
let _modActionsCache = null;
let _modActionsCacheAt = 0;
let _modActionsInFlight = null;

export async function fetchAllModActions() {
  const now = Date.now();
  if (_modActionsCache && now - _modActionsCacheAt < MOD_ACTIONS_CACHE_TTL_MS) {
    return _modActionsCache;
  }
  if (_modActionsInFlight) return _modActionsInFlight;

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
        if (!parsed) continue;

        actions.push({
          id: item.id,
          moderator: item.author?.owner || item.author?.address || null,
          createdAt: item.timestamp,
          ...parsed,
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

// Auto-quarantine (report-velocity based auto-blur) is deliberately NOT
// ported here — it only matters to a feed that also displays a
// (currently) blurred-but-clickable-to-reveal post; this read-only world
// feed just skips hidden/banned content outright, so the extra
// "temporarily blurred, click to reveal" state has nothing to attach to.
export function computeModerationState(actions, postId) {
  const relevant = actions.filter((a) => a.targetPostId === postId);

  let blurred = false;
  let hidden = false;
  let hiddenBy = null;
  let hiddenReason = null;
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
      hiddenBy = a.moderator;
      hiddenReason = "hide";
    } else if (a.action === MOD_ACTIONS.UNHIDE) {
      if (a.moderator !== hiddenBy) {
        hidden = false;
        hiddenBy = null;
        hiddenReason = null;
      }
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

  if (hiddenReason === "critical" && criticalHideAt) {
    const criticalDeadline =
      new Date(criticalHideAt).getTime() + CRITICAL_CONFIRM_WINDOW_MS;
    const criticalConfirmed =
      criticalConfirmations.length >= CRITICAL_CONFIRM_REQUIRED;
    if (!criticalConfirmed && Date.now() > criticalDeadline) {
      hidden = false;
      hiddenReason = null;
      hiddenBy = null;
    }
  }

  return { blurred, hidden, hiddenBy, hiddenReason };
}

export function computeBanState(actions, targetAccount, totalEligibleVoters) {
  const relevant = actions.filter(
    (a) =>
      a.action === MOD_ACTIONS.BAN_VOTE &&
      a.targetAccount?.toLowerCase() === targetAccount?.toLowerCase(),
  );

  if (relevant.length === 0) {
    return { voters: [], quorumPct: 0, banned: false };
  }

  const firstVoteAt = new Date(relevant[0].createdAt).getTime();
  const votingDeadline = firstVoteAt + BAN_VOTING_WINDOW_MS;

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
  };
}

// ADAPTED: reads THIS app's own CONTRACTS.shieldSBT / ACTIVE_CHAIN
// (hooks/useDao.js) instead of dossier's copy of the same values — see
// the file header. Same public, walletless view call either way.
export async function fetchShieldTotalSupply() {
  try {
    const { ethers } = await import("ethers");
    const { CONTRACTS, ACTIVE_CHAIN } = await import("../hooks/useDao");
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
    return 0;
  }
}
