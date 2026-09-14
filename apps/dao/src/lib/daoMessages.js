// hooks/useDao.js, hooks/useTipJar.js, hooks/useForum.js and
// lib/locationZk.js return/throw plain, hardcoded-English strings for
// on-chain action progress ("Sending mint() for SHIELD SBT...") and for
// simple, expected failures ("not_connected", "Cannot tip your own post").
// Those hooks aren't React components and are deep, transaction-heavy
// call chains — routing every one of them through useTranslation() would
// mean threading `t` through dozens of useCallback dependency arrays for
// little benefit. Instead, the small set of pages that display these
// strings run them through tDaoMessage() below, which maps each known
// exact string to a translation key.
//
// NOT covered here, intentionally: the detailed on-chain diagnostics from
// _decodeContractError()/_friendlyMintError() in useDao.js (missing
// roles, Timelock states, admin `cast send ...` instructions). Those are
// dynamic (embed addresses, role names, ids) and are aimed at whoever is
// debugging a deployment (the DAO admin/dev), not at an end user acting
// on the app in their own language — so they intentionally stay in
// English, the same way a stack trace would. If that should change, the
// fix belongs in useDao.js itself (build a {code, params} object instead
// of a formatted sentence), not in this file.

const MESSAGE_KEYS = {
  // ── hooks/useDao.js — action-result codes ─────────────────────────
  not_connected: "dao.errors.notConnected",
  tx_reverted: "dao.errors.txReverted",
  policy_accept_reverted: "dao.errors.policyAcceptReverted",
  policy_hash_unknown: "dao.errors.policyHashUnknown",
  missing_target: "dao.errors.missingTarget",

  // ── hooks/useDao.js — action-result sentences ─────────────────────
  "Only a COUNCIL SBT holder can propose.": "dao.errors.councilRequired",
  "An active SHIELD or COUNCIL token is required": "dao.errors.shieldOrCouncilRequired",
  "Voting power is suspended (an active sanction)": "dao.errors.votingSuspended",
  "You must first accept the current Human Rights Policy (ShieldSBT.acceptPolicy)":
    "dao.errors.mustAcceptPolicy",
  "This post has already been submitted for a sanction vote before (it can't be reused - a contract restriction)":
    "dao.errors.postAlreadyReported",
  "A valid bytes32 hash is required (0x + 64 hex chars)": "dao.errors.invalidHash",
  "A link to the policy text is required": "dao.errors.policyLinkRequired",
  "Could not find proposal data": "dao.errors.proposalDataNotFound",
  "Proposal already executed.": "dao.errors.proposalAlreadyExecuted",

  // ── hooks/useDao.js — onProgress status lines ─────────────────────
  "Accepting the Human Rights Policy...": "dao.progress.acceptingPolicy",
  "Sending mint() for SHIELD SBT...": "dao.progress.mintingShield",
  "Accepting the updated Human Rights Policy...": "dao.progress.acceptingUpdatedPolicy",
  "✓ Policy accepted": "dao.progress.policyAccepted",
  "Sending mint() for COUNCIL SBT...": "dao.progress.mintingCouncil",
  "Sending proposeSanction()...": "dao.progress.sendingProposeSanction",
  "✓ Vote recorded": "dao.progress.voteRecorded",
  "Casting veto (Council)...": "dao.progress.castingVeto",
  "✓ Veto recorded": "dao.progress.vetoRecorded",
  "Finalizing Shield voting...": "dao.progress.finalizingShieldVoting",
  "✓ Done": "dao.progress.done",
  "Executing sanction...": "dao.progress.executingSanction",
  "✓ Sanction executed": "dao.progress.sanctionExecuted",
  "Sending proposeScoped()...": "dao.progress.sendingProposeScoped",
  "Requesting browser geolocation permission...": "dao.progress.requestingGeoPermission",
  "Accepting the location disclosure notice...": "dao.progress.acceptingLocationNotice",
  "Recording the location commitment on-chain...": "dao.progress.recordingLocationCommitment",
  "Submitting the proof on-chain...": "dao.progress.submittingProof",

  // ── hooks/useTipJar.js ─────────────────────────────────────────────
  "Author address missing": "dao.errors.authorAddressMissing",
  "This token isn't accepted by TipJar": "dao.errors.tokenNotAccepted",
  "Cannot tip your own post": "dao.errors.cannotTipOwnPost",
  approve_tx_failed: "dao.errors.approveTxFailed",
  "Wallet not connected": "dao.errors.walletNotConnected",

  // ── hooks/useForum.js ────────────────────────────────────────────
  "Failed to load the forum from the relay servers.": "dao.errors.forumLoadFailed",
  "No relay accepted the event.": "dao.errors.forumNoRelayThread",
  "Failed to publish the thread.": "dao.errors.forumPublishThreadFailed",
  "No relay accepted the reply.": "dao.errors.forumNoRelayReply",
  "Failed to publish the reply.": "dao.errors.forumPublishReplyFailed",

  // ── lib/locationZk.js ────────────────────────────────────────────
  "Geolocation isn't supported by this browser.": "dao.errors.geoUnsupported",
  "Geolocation access was denied by the browser. Allow geolocation for this site in your browser settings and try again.":
    "dao.errors.geoPermissionDenied",
  "Position unavailable — check that geolocation is enabled in your OS/browser settings.":
    "dao.errors.geoPositionUnavailable",
  "Determining precise (GPS) position...": "dao.progress.determiningGpsPosition",
  "GPS didn't complete in time — trying network geolocation (may take up to 30s)...":
    "dao.progress.gpsFallbackToNetwork",
  "Computing cryptographic commitment locally...": "dao.progress.computingCommitment",
  "Generating ZK proof locally (may take a few seconds)...": "dao.progress.generatingProof",
};

/**
 * Translates a raw status/error string from the DAO hooks, if recognized.
 * Anything not in the table (dynamic diagnostics, or a raw e.message from
 * a wallet/provider) is returned unchanged.
 */
export function tDaoMessage(t, raw) {
  if (!raw || typeof raw !== "string") return raw;
  const key = MESSAGE_KEYS[raw];
  return key ? t(key) : raw;
}
