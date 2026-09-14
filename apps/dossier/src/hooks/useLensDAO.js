// src/hooks/useLensDAO.js
//
// ⚠️ MIGRATED (see /governance and /moderation pages): this hook used to
// target the OLD DAO contracts on Lens Chain Sepolia (37111). It has been
// replaced wholesale with the exact same hook already running in the
// separate dao-app (src/hooks/useDao.js there), now targeting the NEW
// contracts on Arbitrum Sepolia (421614). Nothing here is Lens-specific —
// the hook only ever talked to the DAO's own contracts over a plain
// ethers.JsonRpcProvider, so this swap is a straight retarget: same
// function names/shapes (so every file that imports useLensDAO/CONTRACTS/
// ACTIVE_CHAIN keeps working unchanged), same env var names (VITE_
// RIGHTS_REGISTRY, VITE_DISCIPLINE_MODULE, etc. — just update .env/.env.local
// with the NEW Arbitrum Sepolia addresses), different chain + a couple of
// bugfixes picked up on the dao-app side (see PROPOSAL_LOOKBACK_FALLBACK
// below). The full governance UI (token/proposals/propose/params) that used
// to live in GovernancePage.jsx has been removed from this app — that part
// is now exclusively handled by the separate DAO app (see
// GovernanceRedirect.jsx). What DOES still live here and depends on this
// hook: ModerationQueue.jsx (report triage + escalation to a sanction via
// proposeSanction — now created directly on the new contracts), plus
// useTipJar/useEpochRanking/useLocationRegistry and a few membership-role
// checks (Navbar, CountryFeed, PostPage, etc.) — all of those keep working
// exactly as before, just reading from the new deployment.
//
// HR DAO on Arbitrum Sepolia (421614) — Influence + SHIELD + COUNCIL + Discipline
//
// ⚠️ ARCHITECTURE (updated — added HumanityGate/PassportAdapter/Treasury):
//   - A single DaoGovernor instead of two separate ones (RightsGovernor/CouncilGovernor).
//   - A single DaoTimelock as the DAO's executive Timelock.
//   - RightsTimelock no longer exists.
//   - Single DaoGovernor: Shield+Council vote IDENTICALLY on any
//     decision; only Council can propose. The "track" concept has been
//     removed entirely — it used to be an artificial UI split with no
//     on-chain basis (DaoGovernor.sol has no such concept).
//   - Mint Shield/Council: humanity verification now goes through a
//     SEPARATE shared HumanityGate contract (+ PassportAdapter as the
//     specific provider) — ShieldSBT/CouncilSBT don't call the decoder
//     directly themselves, only the proxy functions
//     previewHumanityScore()/minHumanityScore() (previously called
//     previewPassportScore()/minPassportScore() — renamed along with
//     the move to HumanityGate).
//   - ⚠️ CRITICAL: DaoGovernor.clock() now runs on block.timestamp
//     (CLOCK_MODE="mode=timestamp"), NOT on block.number as before.
//     votingDelay()/votingPeriod() return SECONDS, and quorum()/
//     proposalSnapshot()/proposalDeadline() return TIMESTAMPS, not
//     block numbers. All the logic below that used to count blocks has
//     been rewritten for seconds/timestamps.
//   - RightsRegistry.currentRights()/RIGHTS_THRESHOLD() are PLAIN
//     INTEGERS (1 RIGHT = $1 of tip donation), NOT 18-decimal
//     fixed-point, despite rights[author] superficially resembling
//     ERC20 accounting. Confirmed by a direct contract test:
//     rightsPerUnit=1 for an 18-decimal token gives a currentRights()
//     increase of exactly 1 per $1 donated (documented by the author
//     of TipJar.sol). Number(...) here is completely safe.
//   - DisciplineModule: reading isRestricted/blackMarks unchanged.

import { useState, useCallback, useRef, useEffect } from "react";
import { ethers } from "ethers";
import { useAccount } from "wagmi";
import { usePrivy } from "@privy-io/react-auth";
import { fmtDuration } from "../lib/format";

// ─────────────────────────────────────────────────────────────
//  Network configuration
// ─────────────────────────────────────────────────────────────

export const LENS_CHAIN = {
  chainId: "0x90F7",
  chainIdDec: 37111,
  chainName: "Lens Network Sepolia Testnet",
  nativeCurrency: { name: "GRASS", symbol: "GRASS", decimals: 18 },
  rpcUrls: ["https://rpc.testnet.lens.xyz"],
  blockExplorerUrls: ["https://explorer.testnet.lens.xyz"],
};

export const ANVIL_CHAIN = {
  chainId: "0x7A69",
  chainIdDec: 31337,
  chainName: "Anvil Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["http://127.0.0.1:8545"],
  blockExplorerUrls: [],
};

// The real target network for the DAO's contract deployment (replaced
// Lens Chain Sepolia — see MIGRATION_NOTES.md in the contracts
// project). LENS_CHAIN is kept below only as a historical constant
// (currently not imported anywhere outside this file) — the social
// apps connect separately and do NOT depend on this variable.
export const ARBITRUM_SEPOLIA_CHAIN = {
  chainId: "0x66EEE",
  chainIdDec: 421614,
  chainName: "Arbitrum Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: [
    import.meta.env.VITE_ARBITRUM_SEPOLIA_RPC ||
      "https://sepolia-rollup.arbitrum.io/rpc",
  ],
  blockExplorerUrls: ["https://sepolia.arbiscan.io"],
};

const USE_LOCAL = import.meta.env.VITE_USE_LOCAL_CHAIN === "true";
export const ACTIVE_CHAIN = USE_LOCAL ? ANVIL_CHAIN : ARBITRUM_SEPOLIA_CHAIN;

// ── Contract addresses (.env) ───────────────────────────────────
const PLACEHOLDER_BASE = "0x000000000000000000000000000000000000000";
const ph = (n) => `${PLACEHOLDER_BASE}${n}`;

export const CONTRACTS = {
  rightsRegistry: import.meta.env.VITE_RIGHTS_REGISTRY || ph(1),
  daoTimelock: import.meta.env.VITE_DAO_TIMELOCK || ph(2),
  daoGovernor: import.meta.env.VITE_DAO_GOVERNOR || ph(3),
  councilSBT: import.meta.env.VITE_COUNCIL_SBT || ph(4),
  shieldSBT: import.meta.env.VITE_SHIELD_SBT || ph(5),
  disciplineModule: import.meta.env.VITE_DISCIPLINE_MODULE || ph(6),
  tipJar: import.meta.env.VITE_TIP_JAR || ph(7),
  // ── New contracts (HumanityGate architecture) ───────────────
  humanityGate: import.meta.env.VITE_HUMANITY_GATE || ph(8),
  passportAdapter: import.meta.env.VITE_PASSPORT_ADAPTER || ph(9),
  treasury: import.meta.env.VITE_TREASURY || ph(10),
  // ⚠️ Renamed: it used to be "mockPassportDecoder" — the actual
  // contract is now MockHumanityProvider (setFixedScore(), not
  // setMyScore()), not MockPassportDecoder. The key is kept below for
  // backward compatibility.
  mockHumanityProvider: import.meta.env.VITE_MOCK_PASSPORT_DECODER || "",
  mockPassportDecoder: import.meta.env.VITE_MOCK_PASSPORT_DECODER || "", // deprecated alias
  // ── Geo module (H3 hexagons, cascading ranking model) ──────
  locationRegistry: import.meta.env.VITE_LOCATION_REGISTRY || "",
  councilRankingEpoch: import.meta.env.VITE_COUNCIL_RANKING_EPOCH || "",
  optimisticEpochSubmission:
    import.meta.env.VITE_OPTIMISTIC_EPOCH_SUBMISSION || "",
  // ⚠️ CHANGE: this deployment has ONLY ONE test token (tUSD, 6
  // decimals), not two (tGHO+tUSDC) as before. testTokenGHO is kept as
  // an empty slot for the future (if the DAO adds a second token via
  // TipJar.setAcceptedToken()) — code that reads CONTRACTS.testTokenGHO
  // must check for an empty string itself, not assume the token exists.
  testTokenUSD: import.meta.env.VITE_TEST_TOKEN_USD || "",
  testTokenGHO: import.meta.env.VITE_TEST_TOKEN_GHO || "",
};

export const PLACEHOLDER_ADDRESSES = Array.from({ length: 10 }, (_, i) =>
  ph(i + 1),
);

// ⚠️ BUG (fixed): all 3 places that scan ProposalCreated/SanctionProposed
// logs (loadProposals, loadSanctionProposals, _ensureProposalData) used
// to have a HARDCODED lookback of 20_000 blocks. On Arbitrum Sepolia
// (~0.25s/block) that's ~80-90 MINUTES of history. Because of this, a
// proposal whose voting had already ended (i.e. it was older than this
// window — which is almost always true, since voting on it means the
// user automatically "waited" for it to stop being Active) fell outside
// the scanned block range and disappeared entirely from the /proposals
// docket — even though it exists on the contract itself and its
// state()/hasVoted() can be read fine. In other words, "proposals that
// have already been voted on don't show up" wasn't a bug in the page's
// filter (FILTERS/"All" shows everything in dao.proposals), but a bug
// in the data SOURCE: they were simply never found via getLogs.
// If VITE_DAO_GOVERNOR_DEPLOY_BLOCK is set, we scan from it (seeing
// ABSOLUTELY all proposals for the entire deployment lifetime, the most
// reliable option). If not set, we fall back to a much wider window
// than before.
const DAO_GOVERNOR_DEPLOY_BLOCK = import.meta.env.VITE_DAO_GOVERNOR_DEPLOY_BLOCK
  ? Number(import.meta.env.VITE_DAO_GOVERNOR_DEPLOY_BLOCK)
  : null;
const PROPOSAL_LOOKBACK_FALLBACK_BLOCKS = 2_000_000; // ~a few days on Arbitrum Sepolia instead of ~1.5 hours

function _proposalsFromBlock(currentBlock) {
  return DAO_GOVERNOR_DEPLOY_BLOCK !== null
    ? DAO_GOVERNOR_DEPLOY_BLOCK
    : Math.max(0, currentBlock - PROPOSAL_LOOKBACK_FALLBACK_BLOCKS);
}

const GAS_OPTS = { gasLimit: 500_000n };
const GAS_OPTS_HEAVY = { gasLimit: 900_000n }; // propose/queue/execute/mint (governor logic is heavier)

// ⚠️ GAS_OPTS_HEAVY (900_000) turned out to be too low for
// ShieldSBT/CouncilSBT.mint() on the Lens testnet's zkSync stack due to
// pubdata cost (the same reason as for TipJar.tip() — a real estimate
// showed ~1.53M gas instead of 900k). So for mint() we estimate gas
// dynamically with headroom, keeping GAS_OPTS_HEAVY as a fallback if
// the estimate itself fails for some reason.
// Returns { gasLimit } for sending the transaction, or throws an Error
// if estimateGas returned a logical revert (there's error data → the
// transaction will definitely revert and there's no point sending it
// at all).
// The fallback is only used for technical errors in the estimate
// itself (network timeout, RPC doesn't support eth_estimateGas, etc.)
// — with no error data.
// ⚠️ FIXED: options used to contain ONLY gasLimit, and maxFeePerGas was
// entirely determined by the wallet (MetaMask). On Arbitrum L2 the base
// fee is recalculated every block — MetaMask sometimes caches a
// slightly stale value and proposes a maxFeePerGas LOWER than the
// actual baseFee by the time the transaction is actually included in a
// block → the RPC rejects it with "max fee per gas less than block
// base fee" (0x66eee Custom, eth_sendRawTransaction). Now we always
// pull FRESH fee data from our own RPC (readRef, not the wallet) and
// build in generous headroom, instead of relying on the wallet's estimate.
// ⚠️ Public Arbitrum RPCs (like https://sepolia-rollup.arbitrum.io/rpc)
// are officially documented as "shared infrastructure... uptime not
// guaranteed" — transient "-32000 internal server error" responses
// from overload DO HAPPEN and resolve on their own (this is exactly
// what happened with loadProposals: the error disappeared after simply
// reloading the page). Instead of requiring the user to manually
// reload, we retry the read call a few times with exponential backoff.
async function _withRetry(fn, { attempts = 3, baseDelayMs = 800 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
      }
    }
  }
  throw lastErr;
}

// ⚠️ Public RPCs (like any shared, free endpoint) often have an
// UNDOCUMENTED range-size limit for eth_getLogs — exceeding it usually
// comes back as a generic "-32000 internal server error", not a clear
// "range too large". Instead of guessing at one fixed chunk size, we
// try the requested range as a whole (with retry), and if that
// consistently fails, we split it in half and try each half separately
// (recursively, down to a minimum size) — this works regardless of
// what specific limit a given provider has.
async function _getLogsAdaptive(provider, filterBase, fromBlock, toBlock, minRange = 250) {
  try {
    return await _withRetry(
      () => provider.getLogs({ ...filterBase, fromBlock, toBlock }),
      { attempts: 2, baseDelayMs: 600 },
    );
  } catch (e) {
    const rangeSize = toBlock - fromBlock + 1;
    if (rangeSize <= minRange) {
      // No point splitting further — this is already the minimum
      // block size, so the error is actually something else (not the
      // range size). Rethrow.
      throw e;
    }
    const mid = fromBlock + Math.floor(rangeSize / 2) - 1;
    const [left, right] = await Promise.all([
      _getLogsAdaptive(provider, filterBase, fromBlock, mid, minRange),
      _getLogsAdaptive(provider, filterBase, mid + 1, toBlock, minRange),
    ]);
    return [...left, ...right];
  }
}

// ⚠️ FIXED (round 2): every call site used to pass readRef.current — a
// SEPARATE ethers.JsonRpcProvider pointed at a public RPC endpoint,
// independent of whatever RPC MetaMask itself is configured to use
// for Arbitrum Sepolia. Public RPC endpoints are exactly that —
// separate infrastructure — and there's no guarantee they agree on
// the CURRENT base fee at any given instant, especially on an L2
// where it's recalculated every block. So even after generously
// bumping the buffer to +300% above what THIS provider reported, the
// transaction could still be rejected with "max fee per gas less than
// block base fee" — because the number that actually matters is the
// base fee as seen by whichever node MetaMask hands the transaction
// to, not the number our own separate provider happened to report a
// moment earlier. Every call site now passes
// (signerRef.current?.provider || readRef.current) instead — the
// SAME BrowserProvider wrapping the connected wallet, so fee data is
// read from the exact endpoint that will actually process the
// transaction. The generous +300%/floor buffer below still absorbs
// the click-to-confirm delay; this fixes the cross-endpoint mismatch
// on top of that.
async function _estimateGasWithBuffer(contractMethod, args, fallbackGasOpts, feeProvider) {
  let feeOverrides = {};
  if (feeProvider) {
    try {
      const feeData = await feeProvider.getFeeData();
      if (feeData.maxFeePerGas != null && feeData.maxPriorityFeePerGas != null) {
        // FIXED: +50% headroom above the baseFee fetched HERE wasn't
        // enough — this fee data is fetched the instant the button is
        // clicked, but the actual transaction only gets broadcast
        // AFTER the user reviews and confirms the MetaMask popup,
        // which can easily take several seconds. Arbitrum Sepolia's
        // baseFee is small in absolute terms, so even a routine
        // block-to-block move can be a large percentage swing — a
        // fee that was +50% above baseFee at fetch time can end up
        // BELOW the (new) baseFee by the time the tx actually lands,
        // which is exactly the "max fee per gas less than block base
        // fee" error reported. Since this is testnet gas — genuinely
        // fractions of a cent even at many multiples — there's no
        // real cost to being generous: +300% (4x) instead of +50%
        // absorbs several consecutive fee-spiking blocks' worth of
        // margin, not just one. maxPriorityFeePerGas is also floored
        // to a small non-zero value: some RPCs report exactly 0n
        // (legal, but a 0-tip transaction can be the first thing
        // deprioritized under any load), and 0n obviously provides no
        // headroom of its own the way maxFeePerGas's multiplier does.
        const priorityFee =
          feeData.maxPriorityFeePerGas > 10_000_000n
            ? feeData.maxPriorityFeePerGas
            : 10_000_000n; // floor: 0.01 gwei
        feeOverrides = {
          maxFeePerGas: (feeData.maxFeePerGas * 400n) / 100n + priorityFee,
          maxPriorityFeePerGas: priorityFee,
        };
      } else if (feeData.gasPrice != null) {
        // Fallback for networks without EIP-1559 (shouldn't happen on
        // Arbitrum, but just in case). Same reasoning as above — a
        // generous multiplier since this is testnet gas.
        feeOverrides = { gasPrice: (feeData.gasPrice * 400n) / 100n };
      }
    } catch (e) {
      console.warn("[_estimateGasWithBuffer] getFeeData failed:", e);
    }
  }
  try {
    const estimatedGas = await contractMethod.estimateGas(...args);
    return { gasLimit: (estimatedGas * 130n) / 100n, ...feeOverrides }; // +30% headroom
  } catch (e) {
    // If there's error data, it's a LOGICAL revert from the contract,
    // not a technical estimation error. Rethrow so the caller can
    // decode the reason and NOT send the transaction (which will
    // definitely revert and waste gas). Example:
    // TimelockUnexpectedOperationState from execute() before the delay ends.
    const errData = e?.data || e?.info?.error?.data || e?.error?.data;
    if (errData && errData !== "0x") {
      throw e; // → caught by the caller, decoded there
    }
    // No error data — a technical estimation error (RPC, timeout, etc.).
    // Safe to retry with the fallback limit (using the same fee data).
    console.warn("[_estimateGasWithBuffer] estimateGas failed, fallback:", e);
    return { ...fallbackGasOpts, ...feeOverrides };
  }
}

// ─────────────────────────────────────────────────────────────
//  ABIs
// ─────────────────────────────────────────────────────────────

const RIGHTS_ABI = [
  "function currentInfluence(address account) external view returns (uint256)",
  "function votingPower(address account) external view returns (uint256)",
  "function lastActivityTimestamp(address account) external view returns (uint256)",
  "function projectStartTimestamp() external view returns (uint256)",
  "function applyDecay(address account) external",
  // ⚠️ Added for role-wiring diagnostics: InfluenceRegistry.touchActivity()
  // is protected by onlyRole(ACTIVITY_ROLE) — without this role on
  // DaoGovernor, EVERY vote with weight > 0 reverts (DaoGovernor._countVote
  // calls touchActivity).
  "function hasRole(bytes32 role, address account) external view returns (bool)",
  "function ACTIVITY_ROLE() external view returns (bytes32)",
  "event InfluenceAwarded(address indexed author, uint256 amount, uint256 effectiveAmount, uint256 newTotal, bytes32 postRef)",
];

const SHIELD_ABI = [
  "function balanceOf(address owner) external view returns (uint256)",
  "function accountToTokenId(address) external view returns (uint256)",
  "function totalSupply() external view returns (uint256)",
  "function isMember(address account) external view returns (bool)",
  "function memberSince(address) external view returns (uint256)",
  "function requiredCouncilDuration(address) external view returns (uint256)",
  "function locked(uint256 tokenId) external view returns (bool)",
  "function mint() external",
  // ⚠️ ShieldSBT inherits PolicyConsentGate — mint() requires
  // hasAcceptedCurrentPolicy(msg.sender)==true, otherwise it reverts with
  // "Shield: must accept Human Rights Policy". This step used to be missing
  // from the frontend.
  "function currentPolicyHash() external view returns (bytes32)",
  "function policyURI() external view returns (string)",
  "function policyVersion() external view returns (uint256)",
  "function hasAcceptedCurrentPolicy(address account) external view returns (bool)",
  "function isCompliant(address account) external view returns (bool)",
  "function reconsentTimeLeft(address account) external view returns (uint256)",
  "function acceptPolicy(bytes32 policyHash) external",
  // ⚠️ Missing from the previous ABI version - this is exactly what
  // caused "unknown fragment setPolicy" when encoding a proposal on the frontend.
  "function setPolicy(bytes32 newHash, string calldata newURI) external",
  // RIGHTS_THRESHOLD - a plain integer (200), same as currentRights().
  "function INFLUENCE_THRESHOLD() external view returns (uint256)",
  // Renamed: minPassportScore→minHumanityScore,
  // previewPassportScore→previewHumanityScore (the move to HumanityGate
  // — these functions are now just proxies to humanityGate.bestScore()/
  // verifyHuman() inside the contract; the call signature from the
  // frontend doesn't change).
  "function minHumanityScore() external view returns (uint256)",
  "function previewHumanityScore(address account) external view returns (uint256)",
  "event ShieldMinted(address indexed account, uint256 tokenId)",
  "event Slashed(address indexed account, uint256 tokenId, bytes32 violationPostRef)",
];

const COUNCIL_ABI = [
  "function balanceOf(address owner) external view returns (uint256)",
  "function accountToTokenId(address) external view returns (uint256)",
  "function totalSupply() external view returns (uint256)",
  "function isCouncilMember(address account) external view returns (bool)",
  "function memberSince(address) external view returns (uint256)",
  "function mint() external",
  "function INFLUENCE_THRESHOLD() external view returns (uint256)",
  "function minHumanityScore() external view returns (uint256)",
  "function previewHumanityScore(address account) external view returns (uint256)",
  "function locked(uint256 tokenId) external view returns (bool)",
  "event CouncilMinted(address indexed account, uint256 tokenId)",
  "event Slashed(address indexed account, uint256 tokenId, bytes32 violationPostRef)",
];

// A shared humanity provider registry (World ID / Human Passport /
// others) — ShieldSBT/CouncilSBT call into it via verifyHuman()/
// bestScore(), never calling a decoder directly themselves. For the
// frontend's basic UI, previewHumanityScore() on ShieldSBT/CouncilSBT
// itself (a proxy call) is usually enough, but this ABI is kept for
// direct integrations (admin panels, viewing active providers, etc.).

// ── LocationRegistry (geo reform STAGE 2): commitment + ZK-revealed ancestors ──
const LOCATION_ABI = [
  "function MAX_RESOLUTION() external view returns (uint8)",
  "function LEVEL_EARTH() external view returns (int8)",
  "function CHANGE_COOLDOWN() external view returns (uint256)",
  "function totalDeclaredLocations() external view returns (uint256)",
  "function hasDeclaredHex(address account) external view returns (bool)",
  "function getCommitment(address account) external view returns (uint256)",
  "function getRevealedAncestor(address account, int8 level) external view returns (uint64)",
  "function getDeepestRevealedLevel(address account) external view returns (int8)",
  "function timeUntilNextChangeAllowed(address account) external view returns (uint256)",
  "function setLocationCommitment(uint256 commitment) external",
  "function revealAncestor(int8 level, uint64 branchId, uint256[2] a, uint256[2][2] b, uint256[2] c) external",
  // PolicyConsentGate (inherited) — the same "Location Disclosure
  // Notice" that must be accepted BEFORE setLocationCommitment().
  "function currentPolicyHash() external view returns (bytes32)",
  "function policyURI() external view returns (string)",
  "function hasAcceptedCurrentPolicy(address account) external view returns (bool)",
  "function acceptPolicy(bytes32 policyHash) external",
  "event CommitmentSet(address indexed account, uint256 commitment, uint256 timestamp)",
  "event AncestorRevealed(address indexed account, int8 level, uint64 branchId)",
];

// ── CouncilRankingEpoch (geo reform STAGE 3): hexagon-density cascade ──
const RANKING_ABI = [
  "function LEVEL_EARTH() external view returns (int8)",
  "function EARTH_BRANCH() external view returns (uint64)",
  "function NODE_CAPACITY() external view returns (uint16)",
  "function quorumBps() external view returns (uint256)",
  "function minEpochDuration() external view returns (uint256)",
  "function currentEpoch() external view returns (uint256)",
  "function currentEpochStartedAt() external view returns (uint256)",
  "function totalActiveHexagons() external view returns (uint256)",
  "function nodeKeyOf(int8 level, uint64 branchId) external pure returns (bytes32)",
  "function nodeSeatCount(bytes32 key) external view returns (uint32)",
  "function nodeOverflowed(bytes32 key) external view returns (bool)",
  "function quorumFor(int8 level, uint64 branchId) external view returns (uint256)",
  "function activeLevelsForAccount(address account) external view returns (uint8)",
  "function effectiveHexFor(address account) external view returns (int8 level, uint64 branchId)",
  "event EpochStarted(uint256 indexed epoch, uint256 timestamp)",
  "event NodeStatusUpdated(bytes32 indexed nodeKey, int8 level, uint64 branchId, uint32 seatCount, bool overflowed)",
];

const HUMANITY_GATE_ABI = [  "function bestScore(address account) external view returns (uint256)",
  "function isHuman(address account, uint256 minScoreScaled) external view returns (bool)",
  "function verifiedVia(address account) external view returns (address)",
  "function needsReverification(address account) external view returns (bool)",
  "function getActiveProviders() external view returns (address[])",
  "function mode() external view returns (uint8)",
  "function governor() external view returns (address)",
  "function pendingGovernor() external view returns (address)",
];

// ── Treasury (geo reform STAGE 4): hex-based tax routing ───────────────
const TREASURY_ABI = [
  "function OPERATIONAL_BPS() external view returns (uint256)",
  "function nodeKeyOf(int8 level, uint64 branchId) external pure returns (bytes32)",
  "function hexBalance(address token, bytes32 key) external view returns (uint256)",
  "function operationalBalance(address token) external view returns (uint256)",
  "function totalEarmarked(address token) external view returns (uint256)",
  "function hexAvailableToWithdraw(address token, int8 level, uint64 branchId) external view returns (uint256)",
  "function availableToWithdraw(address token) external view returns (uint256)",
  "function hexController(bytes32 key) external view returns (address)",
  "event HexCredited(address indexed token, bytes32 indexed nodeKey, int8 level, uint64 branchId, uint256 amount)",
  "event TaxDeposited(address indexed token, address indexed from, uint256 amount, uint256 operationalCut)",
];

const DISCIPLINE_ABI = [
  "function isRestricted(address account) external view returns (bool)",
  "function blackMarks(address) external view returns (uint256)",
  "function proposalCount() external view returns (uint256)",
  "function violationPostUsed(bytes32) external view returns (bool)",
  "function restrictedUntil(address) external view returns (uint256)",
  // ⚠️ FIXED: the previous version of this ABI did NOT include
  // shieldAgainstVotes/shieldAbstainVotes — this shifted the decoding
  // of ALL subsequent fields (vetoWindowOpenedAt would be read as
  // shieldAgainstVotes, etc.). struct Proposal - the public getter for
  // mapping(uint256 => Proposal) only returns the NON-mapping fields
  // of the struct, in declaration order (shieldVoted/councilVoted are
  // internal mappings, the auto-generated getter skips them).
  "function proposals(uint256 id) external view returns (address target, bytes32 violationPostRef, uint8 sType, uint8 period, uint256 createdAt, uint256 shieldSupplySnapshot, uint256 shieldVoteDeadline, uint256 shieldForVotes, uint256 shieldAgainstVotes, uint256 shieldAbstainVotes, uint256 vetoWindowOpenedAt, uint256 councilSupplySnapshot, uint256 vetoDeadline, uint256 vetoForVotes, uint8 status)",
  "function proposeSanction(address target, bytes32 violationPostRef, uint8 sType, uint8 period) external returns (uint256 id)",
  // ⚠️ FIXED: voteShield() actually takes a SECOND parameter — choice
  // (0=For, 1=Against, 2=Abstain). The previous version called
  // voteShield(id) with ONE argument, which on the real contract would
  // either fail with a calldata encoding error, or (worse) substitute
  // the gasOpts object as the choice value.
  "function voteShield(uint256 id, uint8 choice) external",
  "function finalizeShieldVote(uint256 id) external",
  "function vetoSanction(uint256 id) external",
  "function execute(uint256 id) external",
  "event SanctionProposed(uint256 indexed id, address indexed target, uint8 sType, bytes32 violationPostRef)",
  "event ShieldVoted(uint256 indexed id, address indexed voter, uint8 choice)",
  "event VetoWindowOpened(uint256 indexed id, uint256 deadline)",
  "event CouncilVetoed(uint256 indexed id, address indexed voter)",
  "event SanctionExecuted(uint256 indexed id)",
  "event SanctionCancelled(uint256 indexed id)",
];

// Human-readable names for VoteChoice (DisciplineModule.sol: enum VoteChoice { For, Against, Abstain })
export const VOTE_CHOICES = ["For", "Against", "Abstain"];

// Human-readable names for DisciplineModule's enums (SanctionType/RestrictionPeriod/Status) —
// same order as in DisciplineModule.sol, so the indices line up.
export const SANCTION_TYPES = ["Warning", "PartialRestriction", "FullSlash"];
// ⚠️ "Permanent" is NOT part of the actual RestrictionPeriod enum
// (only 3 values) — a partial sanction is temporary by definition,
// there's a separate FullSlash type for "forever". The indices must
// match DisciplineModule.sol.
export const RESTRICTION_PERIODS = ["Quarter", "Year", "FiveYears"];
export const SANCTION_STATUSES = [
  "Pending",
  "VetoWindow",
  "Executed",
  "Cancelled",
];

const TIMELOCK_ABI = [
  "function hashOperationBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) view returns (bytes32)",
  "function isOperation(bytes32 id) view returns (bool)",
  "function isOperationPending(bytes32 id) view returns (bool)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
  "function getTimestamp(bytes32 id) view returns (uint256)",
];

// ⚠️ DaoGovernor now runs on CLOCK_MODE="mode=timestamp" (not
// "mode=blocknumber"). The quorum()/proposalSnapshot()/proposalDeadline()
// parameter below is still called "blockNumber" only for historical
// reasons in the ABI string — it's ACTUALLY a unix timestamp (seconds)
// now, not a block number. The signature (just uint256) doesn't change
// because of this, but all the logic below that used to count "the
// current block" now counts "the current time".
const GOV_ABI_BASE = [
  "function propose(address[] targets, uint256[] values, bytes[] calldatas, string description) returns (uint256)",
  // ⚠️ The real DaoGovernor ALWAYS requires submitting via
  // proposeScoped — _propose() checks councilSBT.isCouncilMember(proposer)
  // regardless of whether propose() or proposeScoped() was called, BUT
  // proposeScoped additionally validates the level/territory
  // (level/branchId) BEFORE reaching that check. The frontend always
  // uses -1/0 (LEVEL_EARTH/EARTH_BRANCH — the "entire network" level),
  // the same approach used by the DAO's own first genesis proposal.
  "function proposeScoped(address[] targets, uint256[] values, bytes[] calldatas, string description, int8 level, uint64 branchId, int8 seatLevel, uint64 seatBranchId, uint256 seatIndex, bytes32[] seatProof) returns (uint256)",
  "function hashProposal(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) view returns (uint256)",
  "function castVote(uint256 proposalId, uint8 support) returns (uint256)",
  "function state(uint256 proposalId) view returns (uint8)",
  "function proposalVotes(uint256 proposalId) view returns (uint256 againstVotes, uint256 forVotes, uint256 abstainVotes)",
  "function hasVoted(uint256 proposalId, address account) view returns (bool)",
  "function votingDelay() view returns (uint256)",
  "function votingPeriod() view returns (uint256)",
  "function proposalThreshold() view returns (uint256)",
  "function QUORUM_BPS() view returns (uint256)",
  "function quorum(uint256 timepoint) view returns (uint256)",
  "function proposalSnapshot(uint256 proposalId) view returns (uint256)",
  "function proposalDeadline(uint256 proposalId) view returns (uint256)",
  "function proposalNeedsQueuing(uint256 proposalId) view returns (bool)",
  "function queue(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) returns (uint256)",
  "function execute(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) payable returns (uint256)",
  "event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 voteStart, uint256 voteEnd, string description)",
  // ⚠️ A standard OZ v5 AccessControl error. DaoGovernor's _countVote()
  // calls influenceRegistry.touchActivity() (onlyRole(ACTIVITY_ROLE))
  // — if this role hasn't been granted to DaoGovernor, castVote() with
  // weight>0 reverts with exactly this error. Added to the ABI so
  // ethers can decode the revert data (by its 4-byte selector), even
  // if the error was thrown NOT by DaoGovernor itself, but by a
  // contract it calls internally (InfluenceRegistry).
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
];

// The "entire network" level for proposeScoped — corresponds to
// CouncilRankingEpoch.LEVEL_EARTH()/EARTH_BRANCH() (public constant,
// -1/0), hardcoded here to avoid pulling in a separate contract just
// for two constant values.
const LEVEL_EARTH = -1;
const EARTH_BRANCH = 0;

// The single DaoGovernor (after merging RightsGovernor + CouncilGovernor)
const DAO_GOV_ABI = [...GOV_ABI_BASE];

// ─────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────

export const PROPOSAL_STATES = [
  "Pending",
  "Active",
  "Canceled",
  "Defeated",
  "Succeeded",
  "Queued",
  "Expired",
  "Executed",
];

export const VOTE_SUPPORT = { FOR: 1, AGAINST: 0, ABSTAIN: 2 };

// ⚠️ ShieldSBT.sol: RIGHTS_THRESHOLD = 200 (currentRights() is a plain
// integer, 1 RIGHT = $1 of donation; NOT 18-decimal - confirmed
// directly on the contract: rightsPerUnit=1 for an 18-decimal token
// gives a currentRights() increase of exactly 1 per $1 donated, as
// documented by the author of TipJar.sol).
export const SHIELD_THRESHOLD = 200;

// ⚠️ CouncilSBT.sol: INFLUENCE_THRESHOLD = 500 (not 1000 — the
// 200(Shield)→1000(Council) gap was deemed too large and narrowed to
// 500 in the current deployment). Same principle - a plain integer,
// used as a fallback in case reading from the contract in _refreshAll
// fails for some reason.
export const COUNCIL_THRESHOLD = 500;

// Human-readable role names for known contracts (keyed by
// keccak256 hash, since AccessControlUnauthorizedAccount reverts only
// carry a bytes32).
const _ROLE_NAMES = {
  [ethers.id("ACTIVITY_ROLE")]: "ACTIVITY_ROLE (RightsRegistry)",
  [ethers.id("TIPJAR_ROLE")]: "TIPJAR_ROLE (RightsRegistry)",
  [ethers.id("DAO_ROLE")]: "DAO_ROLE",
  [ethers.id("DISCIPLINE_ROLE")]: "DISCIPLINE_ROLE (Shield/Council SBT)",
};

/**
 * Recognizes the custom error AccessControlUnauthorizedAccount(address,bytes32)
 * from OZ v5 AccessControl — by default ethers returns reason=null/
 * CALL_EXCEPTION for it if the contract's ABI doesn't include the
 * error's description.
 * Typical symptom: high gasUsed (the revert happened late — after
 * several SSTOREs), reason=null. The most common cause is a forgotten
 * grantRole() after redeploying/merging contracts (as happened with
 * DaoGovernor → ACTIVITY_ROLE).
 */
// OZ v5 Timelock: OperationState bitmasks (used in expectedStates)
// Unset=1, Waiting=2, Ready=4, Done=8 — encoded as 1<<state.
// Human-readable Timelock operation states for displaying in errors
function _timelockExpectedStateName(bitmask) {
  const n = Number(bitmask);
  if (n === 1) return "Unset";
  if (n === 2) return "Waiting (the delay hasn't elapsed yet)";
  if (n === 4) return "Ready (the delay has elapsed)";
  if (n === 8) return "Done (already executed)";
  return `bitmask=${n}`;
}

/**
 * Decodes known custom contract errors from error data.
 * Covers: AccessControlUnauthorizedAccount (OZ v5 AccessControl),
 *          TimelockUnexpectedOperationState and TimelockUnexecutedOperation
 *          (OZ v5 TimelockController).
 */
function _decodeContractError(err) {
  // 1) ethers v6 auto-decodes custom errors if they're in the contract's ABI.
  const autoDecoded = err?.revert;
  if (autoDecoded?.name === "AccessControlUnauthorizedAccount") {
    const [account, neededRole] = autoDecoded.args;
    const roleName = _ROLE_NAMES[neededRole] || neededRole;
    return `Contract ${account.slice(0, 6)}...${account.slice(-4)} is missing the ${roleName} role. This is a deployment issue (a missing grantRole) — notify the DAO administrator.`;
  }

  // 2) Manual decoding from the raw revert bytes.
  // This matters for errors from INTERNAL calls (e.g. DaoGovernor →
  // DaoTimelock → Timelock), where auto-decode doesn't work because
  // the error was thrown by a different contract than the one whose
  // ABI we passed to ethers.
  const errData = err?.data || err?.info?.error?.data || err?.error?.data;
  if (!errData || errData === "0x") return null;
  try {
    const iface = new ethers.Interface([
      "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
      // OZ v5 TimelockController (selector 0x5ead8eb5):
      // thrown by execute() when the delay hasn't elapsed yet (state Waiting, not Ready)
      "error TimelockUnexpectedOperationState(bytes32 id, bytes32 expectedStates)",
      // thrown if the operation doesn't exist in the Timelock at all (queue wasn't called)
      "error TimelockUnexecutedOperation(bytes32 id)",
    ]);
    const decoded = iface.parseError(errData);

    if (decoded?.name === "AccessControlUnauthorizedAccount") {
      const [account, neededRole] = decoded.args;
      const roleName = _ROLE_NAMES[neededRole] || neededRole;
      return `Contract ${account.slice(0, 6)}...${account.slice(-4)} is missing the ${roleName} role. This is a deployment issue (a missing grantRole) — notify the DAO administrator.`;
    }

    if (decoded?.name === "TimelockUnexpectedOperationState") {
      const [id, expectedStates] = decoded.args;
      // expectedStates=4 (1<<2=Ready): execute() requires the Ready
      // state, but the operation is still Waiting — the Timelock
      // delay hasn't elapsed yet.
      const expected = _timelockExpectedStateName(expectedStates);
      return `Timelock: the operation isn't ready to execute yet. Expected state: ${expected}. Wait for the Timelock delay to elapse after Queue, then try Execute again. (id: ${id.slice(0, 10)}...)`;
    }

    if (decoded?.name === "TimelockUnexecutedOperation") {
      const [id] = decoded.args;
      return `Timelock: operation not found — Queue may not have been called yet. (id: ${id.slice(0, 10)}...)`;
    }
  } catch {}
  return null;
}

// Backward compatibility for places that used to call _decodeAccessControlError
const _decodeAccessControlError = _decodeContractError;

function _friendlyMintError(err) {
  const raw = err?.reason || err?.info?.error?.message || err.message || "";

  // The Passport check lives in PassportGate._verifyHuman (a different
  // file, not provided here), so the exact revert text is unknown — we
  // match on the keyword "score" so the message works regardless of
  // the exact wording.
  if (/score/i.test(raw)) {
    return 'Insufficient Human Passport score. On testnet, MockHumanityProvider gives the SAME fixed score to ALL addresses — if it still isn\'t enough, only the deployment admin can raise the threshold: cast send <MOCK_HUMANITY_PROVIDER> "setFixedScore(uint256)" 10000.';
  }
  // CouncilSBT.sol: require(accountToTokenId[msg.sender] == 0, "Council: already member");
  if (raw.includes("Council: already member")) {
    return "A COUNCIL SBT has already been obtained for this wallet.";
  }
  // ShieldSBT.sol (by analogy with CouncilSBT — check the exact text in the file itself)
  if (raw.includes("Shield: already member")) {
    return "A SHIELD SBT has already been obtained for this wallet.";
  }
  // CouncilSBT.sol: "Council: need 500+ Influence" / ShieldSBT.sol: "Shield: need 200+ Influence"
  if (raw.includes("Council: need") || raw.includes("Shield: need")) {
    return "Not enough Influence to obtain this SBT.";
  }
  // CouncilSBT.sol: require(shieldSBT.isMember(msg.sender), "Council: Shield must be active");
  if (raw.includes("Council: Shield must be active")) {
    return "An active Shield SBT is required before you can get a Council SBT.";
  }
  // CouncilSBT.sol: require(block.timestamp - shieldSince >= required, "Council: membership duration not met");
  if (raw.includes("Council: membership duration not met")) {
    return "The required Shield membership duration hasn't elapsed yet.";
  }
  return raw;
}

// Module-level (NOT per-hook-instance) lock for network switching.
// useLensDAO() is called directly by many independent components
// (Navbar, CountryFeed, ReportModal-adjacent pages, useTipJar, etc.),
// each getting its own closure of _switchOrAddChain — without a
// SHARED lock, several of them calling connect() around the same time
// would each fire their own wallet_switchEthereumChain request, and
// MetaMask only tolerates one pending request at a time (the rest
// error out with "already pending, please wait", exactly what
// motivated this). Any concurrent caller now just awaits the same
// in-flight switch instead of starting a second one.
let _pendingChainSwitch = null;

// FIXED: "Logout requires two clicks — the first one sometimes hard-
// reloads the page instead, and afterwards the Nostr identity on
// Settings is gone." Root cause: connect()/silentConnect() below
// register provider.on("accountsChanged"/"chainChanged", () =>
// window.location.reload()) — needed for the NORMAL case (the user
// switches accounts/network in their wallet, so this app's read-only
// contract state must resync). But useLensDAO() is mounted globally
// (Navbar renders on every page, including Settings), and
// LensAuthContext.logout()'s own wagmi disconnect()/privyLogout()
// tear down the connected wallet — which the underlying provider
// reports as its OWN "accountsChanged" event (accounts -> []). That
// fires this same listener and hard-reloads the page mid-logout,
// interrupting handleLogout's async chain (in SettingsPage.jsx)
// before it gets to clear its localStorage flags / navigate away —
// so Privy/Lens can be left in a half-logged-out state, and the
// reload itself wipes the in-memory Nostr identity (NostrIdentityProvider
// state, sessionStorage-cached or not, needs a live wallet to
// re-derive from) before it has a chance to resolve again. The next
// "Logout" click then has nothing left to tear down that could fire
// another accountsChanged — no reload interrupts it — so it runs
// straight through and actually completes, which is why it only
// ever takes effect "on the second try".
//
// Fix: a module-level flag (same non-per-instance scoping as
// _pendingChainSwitch above, for the same reason — every useLensDAO()
// instance across every mounted component needs to see the SAME
// flag) that LensAuthContext.logout() sets before it starts tearing
// the wallet down, so THIS app's own intentional disconnect never
// triggers a self-inflicted reload — while a genuine external
// account/network switch (flag left false) still reloads exactly as
// before.
let _intentionalDisconnect = false;
export function markIntentionalDisconnect(value = true) {
  _intentionalDisconnect = value;
}
// Shared by both connect() and silentConnect() below — skips the
// reload while an intentional disconnect (see markIntentionalDisconnect
// above) is in progress; otherwise reloads exactly as before.
function _reloadOnWalletChange() {
  if (_intentionalDisconnect) return;
  window.location.reload();
}

// ─────────────────────────────────────────────────────────────
//  Hook
// ─────────────────────────────────────────────────────────────

export function useLensDAO() {
  // FIXED: this hook maintains its own, entirely separate wallet
  // connection flow (connect()/silentConnect() below), independent of
  // the wagmi-based connection used elsewhere in the app
  // (LensAuthContext.jsx). Both connect() and silentConnect() went
  // straight to window.ethereum, which doesn't exist for a wallet
  // connected via WalletConnect (mobile — see main.jsx). connector
  // (the active wagmi connector) is obtained here so this hook's own
  // connect flow can get an EIP-1193 provider that works for either
  // connection method, without changing this hook's external API.
  const { connector } = useAccount();
  // The ONLY entry point into a wallet connection now — see connect()
  // and _getProvider() below.
  const { login: privyLogin } = usePrivy();

  const [account, setAccount] = useState(null);
  const [rights, setRights] = useState(null);
  const [votingPower, setVotingPower] = useState(null);
  const [hasShield, setHasShield] = useState(false);
  const [hasCouncil, setHasCouncil] = useState(false);
  const [shieldInfo, setShieldInfo] = useState(null);
  const [councilInfo, setCouncilInfo] = useState(null);
  const [isRestricted, setIsRestricted] = useState(false);
  const [blackMarks, setBlackMarks] = useState(0);

  // ── Geo reform STAGE 2-4: location/ranking/hex treasury ──────
  const [locationInfo, setLocationInfo] = useState(null); // { hasDeclared, deepestRevealedLevel, revealedLevels: [{level,branchId}], cooldownSec, policyAccepted, policyHash, policyURI }
  const [myEffectiveHex, setMyEffectiveHex] = useState(null); // { level, branchId } from rankingEpoch.effectiveHexFor
  const [rankingOverview, setRankingOverview] = useState(null); // { epoch, epochStartedAt, minEpochDuration, quorumBps, nodeCapacity, totalActiveHexagons }
  const [loadingLocation, setLoadingLocation] = useState(false);
  // Role-wiring diagnostics: a list of human-readable warnings about
  // missing roles that would make certain actions (voting, sanctions)
  // non-functional.
  const [roleWarnings, setRoleWarnings] = useState([]);
  const [proposals, setProposals] = useState([]);
  // ADDED: a separate registry of sanction proposals (DisciplineModule)
  // — structurally and event-wise completely separate from
  // DaoGovernor.proposals above. loadProposals() only scans
  // ProposalCreated from DaoGovernor and never sees SanctionProposed
  // from DisciplineModule, so sanction proposals (complaints about
  // harmful posts, escalated from the ModerationQueue via
  // proposeSanction()) never showed up anywhere without this state —
  // they only existed on the blockchain and in the local useState of
  // the specific ModerationQueue.jsx card.
  const [sanctionProposals, setSanctionProposals] = useState([]);
  const [govParams, setGovParams] = useState(null); // { rights: {...}, council: {...} }
  const [connecting, setConnecting] = useState(false);
  const [loadingProposals, setLoadingProposals] = useState(false);
  const [loadingSanctionProposals, setLoadingSanctionProposals] =
    useState(false);
  const [error, setError] = useState(null);

  const signerRef = useRef(null);
  const readRef = useRef(null);

  const rightsReadRef = useRef(null);
  const shieldReadRef = useRef(null);
  const shieldWriteRef = useRef(null);
  const councilReadRef = useRef(null);
  const councilWriteRef = useRef(null);
  const disciplineReadRef = useRef(null);
  const disciplineWriteRef = useRef(null);

  const locationReadRef = useRef(null);
  const locationWriteRef = useRef(null);
  const rankingReadRef = useRef(null);
  const treasuryReadRef = useRef(null);

  // The single DaoGovernor (merged after redeployment)
  const daoGovReadRef = useRef(null);
  const daoGovWriteRef = useRef(null);
  const daoTimelockReadRef = useRef(null);

  const proposalDataRef = useRef({}); // key: id → { targets, values, calldatas, description }

  function _gov(write = false) {
    return write ? daoGovWriteRef.current : daoGovReadRef.current;
  }

  // ── Contract initialization ─────────────────────────────

  function _initContracts(signer) {
    const rp = new ethers.JsonRpcProvider(ACTIVE_CHAIN.rpcUrls[0]);
    readRef.current = rp;
    signerRef.current = signer;

    rightsReadRef.current = new ethers.Contract(
      CONTRACTS.rightsRegistry,
      RIGHTS_ABI,
      rp,
    );

    shieldReadRef.current = new ethers.Contract(
      CONTRACTS.shieldSBT,
      SHIELD_ABI,
      rp,
    );
    shieldWriteRef.current = new ethers.Contract(
      CONTRACTS.shieldSBT,
      SHIELD_ABI,
      signer,
    );

    councilReadRef.current = new ethers.Contract(
      CONTRACTS.councilSBT,
      COUNCIL_ABI,
      rp,
    );
    councilWriteRef.current = new ethers.Contract(
      CONTRACTS.councilSBT,
      COUNCIL_ABI,
      signer,
    );

    disciplineReadRef.current = new ethers.Contract(
      CONTRACTS.disciplineModule,
      DISCIPLINE_ABI,
      rp,
    );
    disciplineWriteRef.current = new ethers.Contract(
      CONTRACTS.disciplineModule,
      DISCIPLINE_ABI,
      signer,
    );

    locationReadRef.current = new ethers.Contract(
      CONTRACTS.locationRegistry,
      LOCATION_ABI,
      rp,
    );
    locationWriteRef.current = new ethers.Contract(
      CONTRACTS.locationRegistry,
      LOCATION_ABI,
      signer,
    );
    rankingReadRef.current = new ethers.Contract(
      CONTRACTS.councilRankingEpoch,
      RANKING_ABI,
      rp,
    );
    treasuryReadRef.current = new ethers.Contract(
      CONTRACTS.treasury,
      TREASURY_ABI,
      rp,
    );

    // The single DaoGovernor (after the merge)
    daoGovReadRef.current = new ethers.Contract(
      CONTRACTS.daoGovernor,
      DAO_GOV_ABI,
      rp,
    );
    daoGovWriteRef.current = new ethers.Contract(
      CONTRACTS.daoGovernor,
      DAO_GOV_ABI,
      signer,
    );
    daoTimelockReadRef.current = new ethers.Contract(
      CONTRACTS.daoTimelock,
      TIMELOCK_ABI,
      rp,
    );
  }

  // ── Role-wiring diagnostics ──────────────────────────────
  //
  // RightsRegistry.touchActivity() is protected by onlyRole(ACTIVITY_ROLE).
  // DaoGovernor._countVote() calls it for EVERY vote with weight>0 —
  // without this role, ALL voting with real weight is guaranteed to
  // revert. We check right away on connect, so the user isn't left
  // guessing from a raw CALL_EXCEPTION with an empty reason.
  async function _checkRoleWiring() {
    const warnings = [];
    try {
      const activityRole = await rightsReadRef.current.ACTIVITY_ROLE();
      const daoGovHasRole = await rightsReadRef.current.hasRole(
        activityRole,
        CONTRACTS.daoGovernor,
      );
      if (!daoGovHasRole) {
        warnings.push({
          id: "activity-role-dao-governor",
          text: "DaoGovernor doesn't have ACTIVITY_ROLE on RightsRegistry — any voting with real weight (weight>0) is guaranteed to revert. Needed: rightsRegistry.grantRole(ACTIVITY_ROLE, daoGovernor) from the DAO_ROLE holder.",
        });
      }
    } catch (e) {
      console.warn("_checkRoleWiring (RightsRegistry):", e.message);
    }
    setRoleWarnings(warnings);
  }

  // ── Wallet connection (via Privy — embedded wallet or a wallet
  //    linked through Privy, e.g. MetaMask) → Arbitrum Sepolia ──

  // ⚠️ FIXED (round 3 — architectural): _getProvider() used to fall
  // back to raw window.ethereum whenever wagmi's connector wasn't
  // populated yet. Combined with connect() below independently calling
  // eth_requestAccounts, this meant the app could open a SECOND,
  // entirely separate MetaMask connection alongside the one Privy
  // already manages (LensAuthContext.jsx's wallet-sync effect) —
  // two parallel, mutually unaware paths both talking to the same
  // extension, racing for the same one-request-at-a-time slot. That's
  // the actual root cause behind the repeated "already pending"
  // collisions, stuck wallet clients, and gas/fee inconsistencies
  // chased individually over the previous several fixes. There is now
  // exactly ONE way this app ever connects to a wallet: through Privy
  // (embedded wallet OR MetaMask/other wallets linked THROUGH Privy).
  // If wagmi doesn't have an active connector yet, there is no wallet
  // to fall back to — connect() below opens Privy's own login modal
  // instead of reaching for window.ethereum directly.
  async function _getProvider() {
    if (connector && typeof connector.getProvider === "function") {
      try {
        return await connector.getProvider();
      } catch {
        return null;
      }
    }
    return null;
  }

  async function _switchOrAddChain(provider) {
    const chainId = await provider.request({ method: "eth_chainId" });
    if (chainId === ACTIVE_CHAIN.chainId) return;
    // Reuse an in-flight switch from another useLensDAO() instance
    // instead of firing a second competing MetaMask prompt.
    if (_pendingChainSwitch) return _pendingChainSwitch;
    _pendingChainSwitch = (async () => {
      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: ACTIVE_CHAIN.chainId }],
        });
      } catch (e) {
        if (e.code === 4902 || e?.cause?.code === 4902) {
          const chainParams = { ...ACTIVE_CHAIN };
          if (!chainParams.blockExplorerUrls?.length)
            delete chainParams.blockExplorerUrls;
          await provider.request({
            method: "wallet_addEthereumChain",
            params: [chainParams],
          });
          await new Promise((r) => setTimeout(r, 1000));
          await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: ACTIVE_CHAIN.chainId }],
          });
        } else throw e;
      }
    })();
    try {
      await _pendingChainSwitch;
    } finally {
      _pendingChainSwitch = null;
    }
  }

  // ⚠️ FIXED (round 3): this used to call
  // provider.request({method:"eth_requestAccounts"}) itself — a
  // SECOND, independent "please connect" request straight to
  // window.ethereum, alongside whatever Privy's own connection flow
  // was doing. If a wallet is already connected (the normal case:
  // someone using the app has already gone through Privy's login
  // somewhere), that call was pure redundancy — the wallet is already
  // authorized, nothing to request. If NO wallet is connected yet
  // (e.g. landing directly on /governance in a fresh tab), this now
  // opens PRIVY's own login modal (same email/Google/passkey/wallet
  // choice used everywhere else in the app) instead of demanding
  // MetaMask specifically — once that resolves, LensAuthContext's
  // wallet-sync effect populates wagmi's connector, and the retry
  // effect watching dao.silentConnect (see GovernancePage.jsx) picks
  // the rest up automatically, same as any other login in this app.
  const connect = useCallback(async () => {
    let provider = await _getProvider();
    if (!provider) {
      setConnecting(true);
      setError(null);
      try {
        await privyLogin();
      } catch (err) {
        setConnecting(false);
        return { success: false, error: err?.message || "Login cancelled" };
      }
      // privyLogin() resolves once the modal closes, but the wallet
      // sync (Privy -> wagmi connector) can lag a beat behind that —
      // give it a moment, then check again.
      for (let i = 0; i < 10 && !provider; i++) {
        await new Promise((r) => setTimeout(r, 300));
        provider = await _getProvider();
      }
      if (!provider) {
        setConnecting(false);
        setError("Connect your wallet!");
        return { success: false };
      }
    } else {
      setConnecting(true);
      setError(null);
    }
    try {
      await _switchOrAddChain(provider);

      const bp = new ethers.BrowserProvider(provider);
      const signer = await bp.getSigner();
      const addr = await signer.getAddress();

      _initContracts(signer);
      setAccount(addr);

      provider.removeAllListeners?.("accountsChanged");
      provider.removeAllListeners?.("chainChanged");
      provider.on?.("accountsChanged", _reloadOnWalletChange);
      provider.on?.("chainChanged", _reloadOnWalletChange);

      await Promise.all([_refreshAll(addr), _checkRoleWiring()]);
      return { success: true, account: addr, signer };
    } catch (err) {
      const msg = err?.message || "Connection error";
      setError(msg);
      return { success: false, error: msg };
    } finally {
      setConnecting(false);
    }
  }, [connector, privyLogin]);

  // FIXED: this used to force _switchOrAddChain() (a real MetaMask
  // wallet_switchEthereumChain prompt) on EVERY silent auto-connect —
  // and since useLensDAO() is called directly (not through a shared
  // Context) by many independent components (Navbar, CountryFeed,
  // ReportModal-adjacent pages, useTipJar, etc.), a single page
  // render could easily mount 3+ separate hook instances, each firing
  // its own switch request the instant it mounted. Before this app
  // pointed at Arbitrum Sepolia, ACTIVE_CHAIN was the SAME chain the
  // wallet was normally already on for Lens actions, so
  // _switchOrAddChain's own `if (chainId === ACTIVE_CHAIN.chainId)
  // return;` early-exit silently absorbed all of this — no visible
  // popup, no problem. Now that ACTIVE_CHAIN is Arbitrum Sepolia
  // (different from the Lens Chain every Lens action needs), that
  // early-exit almost never fires, so every one of those mounts
  // produced a REAL "please switch network" prompt — competing
  // directly with LensAuthContext.getWalletClient()'s own attempts to
  // switch BACK to Lens Chain for a report/post/comment, hitting
  // MetaMask's one-pending-request-at-a-time limit from both sides at
  // once. That's the actual cause behind reports intermittently
  // failing with "Wallet not connected" and repeated/rejected prompts
  // in general — not a broken contract connection.
  //
  // The fix: silent auto-connect no longer switches the network at
  // all. It only needs the address and a signer to build read-only
  // state — _initContracts() below creates every *ReadRef from its
  // own always-on ethers.JsonRpcProvider(ACTIVE_CHAIN.rpcUrls[0]),
  // completely independent of whichever chain the wallet is actually
  // sitting on, so Shield/Council/RIGHTS badges and the sanction-case
  // list still populate correctly with zero prompts. Only the WRITE
  // path (*WriteRef, bound to the actual signer) can be affected by
  // the wrong chain — and that's fine, because every DAO write already
  // goes through connect() below instead (the explicit "Connect"
  // button on the Moderation/Governance page), which still switches
  // the network — deliberately, once, at the moment the user actually
  // asked to interact with the DAO, not on every unrelated page visit.
  const silentConnect = useCallback(async () => {
    const provider = await _getProvider();
    if (!provider) return { success: false };
    try {
      const accounts = await provider.request({
        method: "eth_accounts",
      });
      if (!accounts || accounts.length === 0) return { success: false };

      const bp = new ethers.BrowserProvider(provider);
      const signer = await bp.getSigner();
      const addr = await signer.getAddress();

      _initContracts(signer);
      setAccount(addr);

      provider.removeAllListeners?.("accountsChanged");
      provider.removeAllListeners?.("chainChanged");
      provider.on?.("accountsChanged", _reloadOnWalletChange);
      provider.on?.("chainChanged", _reloadOnWalletChange);

      await Promise.all([_refreshAll(addr), _checkRoleWiring()]);
      return { success: true, account: addr, signer };
    } catch {
      return { success: false };
    }
  }, [connector]);

  // ── A real disconnect ─────────────────────────────────────
  // Unlike window.location.reload() (which only resets React state,
  // not MetaMask's actual connection to the site) — this is a
  // deliberate sign-out: it resets this hook's own wallet/member
  // state, BUT leaves readRef (the read-only provider) alive, so
  // public data (proposals, treasury) keeps being read even without a
  // connected wallet.
  const disconnect = useCallback(() => {
    signerRef.current = null;
    setAccount(null);
    setRights(null);
    setVotingPower(null);
    setHasShield(false);
    setHasCouncil(false);
    setShieldInfo(null);
    setCouncilInfo(null);
    setIsRestricted(false);
    setBlackMarks(0);
    setLocationInfo(null);
    setMyEffectiveHex(null);
    setError(null);
    // Attempt to revoke the site's permission in MetaMask itself (EIP-2255,
    // not supported by all providers) — not critical if it fails.
    _getProvider()
      .then((provider) =>
        provider?.request?.({
          method: "wallet_revokePermissions",
          params: [{ eth_accounts: {} }],
        }),
      )
      .catch(() => {});
  }, []);

  // ── Auto-restoring the session on page load ──────────────
  // If the site is already authorized in MetaMask (eth_accounts
  // returns an account with no popup), connect silently, with no user
  // action. Without this, every reload looked like a disconnect.
  useEffect(() => {
    silentConnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Reading the state of all tokens ───────────────────────

  async function _refreshAll(addr) {
    if (!addr) return;

    try {
      const [r, vp] = await Promise.all([
        rightsReadRef.current.currentInfluence(addr),
        rightsReadRef.current.votingPower(addr),
      ]);
      // rights - a plain integer (1 RIGHT = $1 donated), safe as a
      // Number - values are in realistic ranges (thousands-millions, not 1e20+).
      setRights(Number(r));
      setVotingPower(Number(vp));
    } catch {
      setRights(0);
      setVotingPower(0);
    }

    try {
      const [
        bal,
        supply,
        rightsThreshold,
        minScore,
        userScore,
        policyHash,
        policyURI,
        policyVer,
        hasAcceptedPolicy,
      ] = await Promise.all([
        shieldReadRef.current.balanceOf(addr),
        shieldReadRef.current.totalSupply(),
        shieldReadRef.current.INFLUENCE_THRESHOLD(),
        shieldReadRef.current.minHumanityScore(),
        shieldReadRef.current.previewHumanityScore(addr),
        shieldReadRef.current.currentPolicyHash(),
        shieldReadRef.current.policyURI(),
        shieldReadRef.current.policyVersion(),
        shieldReadRef.current.hasAcceptedCurrentPolicy(addr),
      ]);
      const has = bal > 0n;
      setHasShield(has);
      const baseShieldInfo = {
        totalSupply: supply.toString(),
        rightsThreshold: Number(rightsThreshold),
        minHumanityScore: Number(minScore),
        humanityScore: Number(userScore),
        // Human Rights Policy (PolicyConsentGate) — a separate
        // condition for mint(), previously missing from the frontend:
        // ShieldSBT.mint() requires hasAcceptedCurrentPolicy(msg.sender)==true,
        // otherwise it reverts.
        policyHash,
        policyURI,
        policyVersion: Number(policyVer),
        hasAcceptedPolicy,
      };
      if (has) {
        const [tid, since, reqDuration] = await Promise.all([
          shieldReadRef.current.accountToTokenId(addr),
          shieldReadRef.current.memberSince(addr),
          shieldReadRef.current.requiredCouncilDuration(addr),
        ]);
        setShieldInfo({
          ...baseShieldInfo,
          tokenId: tid.toString(),
          memberSince: Number(since),
          // Exact seconds from the contract — not rounded to days: on
          // testnet this requirement may be a matter of minutes, and
          // Math.round(sec/86400) would zero it out, hiding the real
          // limit (the button would look available, but the tx would
          // revert on the contract). requiredCouncilDurationDays is
          // left as an untrimmed number — just for a convenient UI display.
          requiredCouncilDurationSeconds: Number(reqDuration),
          requiredCouncilDurationDays: Number(reqDuration) / 86400,
        });
      } else {
        setShieldInfo(baseShieldInfo);
      }
    } catch {
      setHasShield(false);
      setShieldInfo(null);
    }

    try {
      const [bal, supply, rightsThreshold, minScore, userScore] =
        await Promise.all([
          councilReadRef.current.balanceOf(addr),
          councilReadRef.current.totalSupply(),
          councilReadRef.current.INFLUENCE_THRESHOLD(),
          councilReadRef.current.minHumanityScore(),
          councilReadRef.current.previewHumanityScore(addr),
        ]);
      const has = bal > 0n;
      setHasCouncil(has);
      const baseCouncilInfo = {
        totalSupply: supply.toString(),
        rightsThreshold: Number(rightsThreshold),
        minHumanityScore: Number(minScore),
        humanityScore: Number(userScore),
      };
      if (has) {
        const [tid, since] = await Promise.all([
          councilReadRef.current.accountToTokenId(addr),
          councilReadRef.current.memberSince(addr),
        ]);
        setCouncilInfo({
          ...baseCouncilInfo,
          tokenId: tid.toString(),
          memberSince: Number(since),
        });
      } else {
        setCouncilInfo(baseCouncilInfo);
      }
    } catch {
      setHasCouncil(false);
      setCouncilInfo(null);
    }

    try {
      const [restricted, marks] = await Promise.all([
        disciplineReadRef.current.isRestricted(addr),
        disciplineReadRef.current.blackMarks(addr),
      ]);
      setIsRestricted(restricted);
      setBlackMarks(Number(marks));
    } catch {
      setIsRestricted(false);
      setBlackMarks(0);
    }

    // ── Geo reform STAGE 2-3: location + effective hexagon ───────
    try {
      const [
        declared,
        deepestLevel,
        cooldown,
        policyHash,
        policyURI,
        policyAccepted,
      ] = await Promise.all([
        locationReadRef.current.hasDeclaredHex(addr),
        locationReadRef.current.getDeepestRevealedLevel(addr),
        locationReadRef.current.timeUntilNextChangeAllowed(addr),
        locationReadRef.current.currentPolicyHash(),
        locationReadRef.current.policyURI(),
        locationReadRef.current.hasAcceptedCurrentPolicy(addr),
      ]);
      const deepest = Number(deepestLevel);
      // Revealed levels — from 0 to deepest inclusive (LEVEL_EARTH=-1
      // means "nothing revealed", in which case the list is empty).
      const revealedLevels = [];
      if (deepest >= 0) {
        const branchIds = await Promise.all(
          Array.from({ length: deepest + 1 }, (_, lvl) =>
            locationReadRef.current.getRevealedAncestor(addr, lvl),
          ),
        );
        branchIds.forEach((b, lvl) => {
          if (b !== 0n) revealedLevels.push({ level: lvl, branchId: b.toString() });
        });
      }
      setLocationInfo({
        hasDeclared: declared,
        deepestRevealedLevel: deepest,
        revealedLevels,
        cooldownSec: Number(cooldown),
        policyHash,
        policyURI,
        policyAccepted,
      });
    } catch (e) {
      console.warn("[_refreshAll] locationInfo failed:", e);
      setLocationInfo(null);
    }

    try {
      const [level, branchId] = await rankingReadRef.current.effectiveHexFor(addr);
      setMyEffectiveHex({ level: Number(level), branchId: branchId.toString() });
    } catch (e) {
      console.warn("[_refreshAll] myEffectiveHex failed:", e);
      setMyEffectiveHex({ level: -1, branchId: "0" }); // fallback: EARTH
    }
  }

  const refreshTokenStatus = useCallback(() => {
    if (account) _refreshAll(account);
  }, [account]);

  // ── Can a Shield holder get Council yet? ──────────────────

  const councilEligibility = useCallback(() => {
    if (!hasShield || !shieldInfo?.memberSince) {
      return { eligible: false, reason: "An active SHIELD token is required" };
    }
    const threshold = councilInfo?.rightsThreshold ?? COUNCIL_THRESHOLD;
    const currentRights = rights ?? 0;
    if (currentRights < threshold) {
      return {
        eligible: false,
        reason: `Requires ${threshold}+ Influence (currently: ${currentRights})`,
      };
    }
    const elapsedSeconds = Date.now() / 1000 - shieldInfo.memberSince;
    const requiredSeconds = shieldInfo.requiredCouncilDurationSeconds ?? 0;
    if (elapsedSeconds < requiredSeconds) {
      return {
        eligible: false,
        reason: `Requires ${fmtDuration(requiredSeconds - elapsedSeconds)} more of SHIELD membership`,
      };
    }
    // CouncilSBT.sol: mint() calls humanityGate.verifyHuman(msg.sender,
    // minHumanityScore) — this check used to be missing from the
    // frontend, so the button stayed active even for people with too
    // low a score, and the tx was guaranteed to revert, wasting gas.
    if (
      councilInfo &&
      councilInfo.humanityScore < councilInfo.minHumanityScore
    ) {
      return {
        eligible: false,
        reason: `Requires a Human Passport score ≥ ${(councilInfo.minHumanityScore / 100).toFixed(2)} (currently: ${(councilInfo.humanityScore / 100).toFixed(2)})`,
      };
    }
    return { eligible: true, reason: null };
  }, [hasShield, shieldInfo, rights, councilInfo]);

  // ── Can the user get SHIELD yet? ───────────────────────────

  const shieldEligibility = useCallback(() => {
    const threshold = shieldInfo?.rightsThreshold ?? SHIELD_THRESHOLD;
    const currentRights = rights ?? 0;
    if (currentRights < threshold) {
      return {
        eligible: false,
        reason: `Requires ${threshold}+ Influence (currently: ${currentRights})`,
      };
    }
    // ShieldSBT.sol: mint() calls humanityGate.verifyHuman(msg.sender,
    // minHumanityScore) — the same requirement that used to be skipped
    // on the frontend (same as for Council).
    if (shieldInfo && shieldInfo.humanityScore < shieldInfo.minHumanityScore) {
      return {
        eligible: false,
        reason: `Requires a Human Passport score ≥ ${(shieldInfo.minHumanityScore / 100).toFixed(2)} (currently: ${(shieldInfo.humanityScore / 100).toFixed(2)})`,
      };
    }
    // PolicyConsentGate: mint() requires hasAcceptedCurrentPolicy(msg.sender).
    // mintShield() below will automatically call acceptPolicy() BEFORE
    // mint() if it hasn't been accepted yet — so this doesn't block the
    // button, it just informs the UI.
    if (shieldInfo && shieldInfo.hasAcceptedPolicy === false) {
      return {
        eligible: true,
        reason: null,
        needsPolicyAccept: true,
      };
    }
    return { eligible: true, reason: null };
  }, [rights, shieldInfo]);

  // ── Mint SHIELD / COUNCIL (World ID proof — dummy on testnet) ────

  const mintShield = useCallback(
    async (onProgress) => {
      if (!shieldWriteRef.current)
        return { success: false, error: "not_connected" };
      const elig = shieldEligibility();
      if (!elig.eligible) return { success: false, error: elig.reason };
      try {
        // PolicyConsentGate: mint() requires hasAcceptedCurrentPolicy() —
        // if the current revision hasn't been accepted yet, accept IT
        // first as a separate transaction (a separate step, since these
        // are two different contract calls — acceptPolicy() and mint()
        // — that can't be combined into one tx without a special
        // batched method on the contract).
        if (shieldInfo && shieldInfo.hasAcceptedPolicy === false) {
          onProgress?.("Accepting the Human Rights Policy...");
          const policyGasOpts = await _estimateGasWithBuffer(
            shieldWriteRef.current.acceptPolicy,
            [shieldInfo.policyHash],
            GAS_OPTS,
            (signerRef.current?.provider || readRef.current),
          );
          const policyTx = await shieldWriteRef.current.acceptPolicy(
            shieldInfo.policyHash,
            policyGasOpts,
          );
          onProgress?.(
            `TX (Policy): ${policyTx.hash.slice(0, 20)}... waiting for block`,
          );
          const policyReceipt = await policyTx.wait();
          if (policyReceipt.status !== 1) {
            return { success: false, error: "policy_accept_reverted" };
          }
        }

        onProgress?.("Sending mint() for SHIELD SBT...");
        const gasOpts = await _estimateGasWithBuffer(
          shieldWriteRef.current.mint,
          [],
          GAS_OPTS_HEAVY,
          (signerRef.current?.provider || readRef.current),
        );
        const tx = await shieldWriteRef.current.mint(gasOpts);
        onProgress?.(`TX: ${tx.hash.slice(0, 20)}... waiting for block`);
        const receipt = await tx.wait();
        if (receipt.status === 1) {
          onProgress?.(`✓ SHIELD SBT received! Block: ${receipt.blockNumber}`);
          await _refreshAll(account);
          return { success: true, txHash: tx.hash };
        }
        return { success: false, error: "tx_reverted" };
      } catch (err) {
        return { success: false, error: _friendlyMintError(err) };
      }
    },
    [account, shieldEligibility, shieldInfo],
  );

  /// A separate, standalone call to acceptPolicy() — for EXISTING
  /// Shield holders, when the DAO updated the Human Rights Policy via
  /// governance (setPolicy). Unlike the automatic acceptance inside
  /// mintShield() (for those who don't YET have Shield), there's no
  /// subsequent mint() here - just acceptPolicy() itself.
  const reacceptPolicy = useCallback(
    async (onProgress) => {
      if (!shieldWriteRef.current)
        return { success: false, error: "not_connected" };
      if (!shieldInfo?.policyHash)
        return { success: false, error: "policy_hash_unknown" };
      try {
        onProgress?.("Accepting the updated Human Rights Policy...");
        const gasOpts = await _estimateGasWithBuffer(
          shieldWriteRef.current.acceptPolicy,
          [shieldInfo.policyHash],
          GAS_OPTS,
          (signerRef.current?.provider || readRef.current),
        );
        const tx = await shieldWriteRef.current.acceptPolicy(
          shieldInfo.policyHash,
          gasOpts,
        );
        onProgress?.(`TX: ${tx.hash.slice(0, 20)}... waiting for block`);
        const receipt = await tx.wait();
        if (receipt.status !== 1)
          return { success: false, error: "tx_reverted" };
        onProgress?.("✓ Policy accepted");
        await _refreshAll(account);
        return { success: true, txHash: tx.hash };
      } catch (err) {
        return { success: false, error: _friendlyMintError(err) };
      }
    },
    [account, shieldInfo],
  );

  const mintCouncil = useCallback(
    async (onProgress) => {
      if (!councilWriteRef.current)
        return { success: false, error: "not_connected" };
      const elig = councilEligibility();
      if (!elig.eligible) return { success: false, error: elig.reason };

      try {
        onProgress?.("Sending mint() for COUNCIL SBT...");
        const gasOpts = await _estimateGasWithBuffer(
          councilWriteRef.current.mint,
          [],
          GAS_OPTS_HEAVY,
          (signerRef.current?.provider || readRef.current),
        );
        const tx = await councilWriteRef.current.mint(gasOpts);
        onProgress?.(`TX: ${tx.hash.slice(0, 20)}... waiting for block`);
        const receipt = await tx.wait();
        if (receipt.status === 1) {
          onProgress?.(`✓ COUNCIL SBT received! Block: ${receipt.blockNumber}`);
          await _refreshAll(account);
          return { success: true, txHash: tx.hash };
        }
        return { success: false, error: "tx_reverted" };
      } catch (err) {
        return { success: false, error: _friendlyMintError(err) };
      }
    },
    [account, councilEligibility],
  );

  // ── DisciplineModule: complaints/sanctions for posts ─────────
  //
  // proposeSanction() is allowed for ANY Shield OR Council holder (not
  // just Council, unlike DaoGovernor.propose()!) — the contract checks
  // this itself (isMember || isCouncilMember), the frontend only
  // duplicates the check for quick UX feedback, without relying on it
  // as the only line of defense.

  const canProposeSanction = useCallback(() => {
    if (!hasShield && !hasCouncil) {
      return {
        eligible: false,
        reason: "An active SHIELD or COUNCIL token is required",
      };
    }
    if (isRestricted) {
      return {
        eligible: false,
        reason: "Voting power is suspended (an active sanction)",
      };
    }
    if (shieldInfo && !shieldInfo.hasAcceptedPolicy) {
      return {
        eligible: false,
        reason:
          "You must first accept the current Human Rights Policy (ShieldSBT.acceptPolicy)",
      };
    }
    return { eligible: true, reason: null };
  }, [hasShield, hasCouncil, isRestricted, shieldInfo]);

  /**
   * @param targetAddress    The address of the post's author (the offender)
   * @param lensPostId       The Lens post ID string - hashed internally
   * @param sanctionType     0=Warning, 1=PartialRestriction, 2=FullSlash
   * @param restrictionPeriod 0=Quarter,1=Year,2=FiveYears,3=Permanent (only for type=1)
   */
  const proposeSanction = useCallback(
    async (
      targetAddress,
      lensPostId,
      sanctionType,
      restrictionPeriod,
      onProgress,
    ) => {
      if (!disciplineWriteRef.current)
        return { success: false, error: "not_connected" };
      const elig = canProposeSanction();
      if (!elig.eligible) return { success: false, error: elig.reason };

      try {
        const violationPostRef = ethers.keccak256(
          ethers.toUtf8Bytes(String(lensPostId)),
        );
        const alreadyUsed =
          await disciplineReadRef.current.violationPostUsed(violationPostRef);
        if (alreadyUsed) {
          return {
            success: false,
            error:
              "This post has already been submitted for a sanction vote before (it can't be reused - a contract restriction)",
          };
        }

        onProgress?.("Sending proposeSanction()...");
        const gasOpts = await _estimateGasWithBuffer(
          disciplineWriteRef.current.proposeSanction,
          [targetAddress, violationPostRef, sanctionType, restrictionPeriod],
          GAS_OPTS_HEAVY,
          (signerRef.current?.provider || readRef.current),
        );
        const tx = await disciplineWriteRef.current.proposeSanction(
          targetAddress,
          violationPostRef,
          sanctionType,
          restrictionPeriod,
          gasOpts,
        );
        onProgress?.(`TX: ${tx.hash.slice(0, 20)}... waiting for block`);
        const receipt = await tx.wait();
        if (receipt.status !== 1)
          return { success: false, error: "tx_reverted" };

        // Extract the sanction proposal's id from the SanctionProposed event
        const iface = new ethers.Interface(DISCIPLINE_ABI);
        let proposalId = null;
        for (const log of receipt.logs) {
          try {
            const parsed = iface.parseLog(log);
            if (parsed?.name === "SanctionProposed") {
              proposalId = parsed.args.id.toString();
              break;
            }
          } catch {
            /* not our event - ignore */
          }
        }
        onProgress?.(`✓ Sanction proposal #${proposalId} created!`);
        return { success: true, txHash: tx.hash, proposalId, violationPostRef };
      } catch (err) {
        return { success: false, error: _friendlyMintError(err) };
      }
    },
    [canProposeSanction],
  );

  /**
   * @param id       The sanction proposal's ID
   * @param choice   0=For, 1=Against, 2=Abstain (VOTE_CHOICES) — ⚠️
   *                 This parameter used to be MISSING and the call
   *                 actually passed the gasOpts object instead of
   *                 choice, because voteShield() on the contract
   *                 requires TWO arguments (id, choice), not one.
   */
  const voteShieldSanction = useCallback(async (id, choice, onProgress) => {
    if (!disciplineWriteRef.current)
      return { success: false, error: "not_connected" };
    try {
      onProgress?.(`Voting (Shield): ${VOTE_CHOICES[choice] ?? choice}...`);
      const gasOpts = await _estimateGasWithBuffer(
        disciplineWriteRef.current.voteShield,
        [id, choice],
        GAS_OPTS_HEAVY,
        (signerRef.current?.provider || readRef.current),
      );
      const tx = await disciplineWriteRef.current.voteShield(
        id,
        choice,
        gasOpts,
      );
      onProgress?.(`TX: ${tx.hash.slice(0, 20)}...`);
      const receipt = await tx.wait();
      if (receipt.status !== 1) return { success: false, error: "tx_reverted" };
      onProgress?.("✓ Vote recorded");
      return { success: true, txHash: tx.hash };
    } catch (err) {
      return { success: false, error: _friendlyMintError(err) };
    }
  }, []);

  const vetoSanction = useCallback(async (id, onProgress) => {
    if (!disciplineWriteRef.current)
      return { success: false, error: "not_connected" };
    try {
      onProgress?.("Casting veto (Council)...");
      const gasOpts = await _estimateGasWithBuffer(
        disciplineWriteRef.current.vetoSanction,
        [id],
        GAS_OPTS_HEAVY,
        (signerRef.current?.provider || readRef.current),
      );
      const tx = await disciplineWriteRef.current.vetoSanction(id, gasOpts);
      onProgress?.(`TX: ${tx.hash.slice(0, 20)}...`);
      const receipt = await tx.wait();
      if (receipt.status !== 1) return { success: false, error: "tx_reverted" };
      onProgress?.("✓ Veto recorded");
      return { success: true, txHash: tx.hash };
    } catch (err) {
      return { success: false, error: _friendlyMintError(err) };
    }
  }, []);

  const finalizeSanctionShieldVote = useCallback(async (id, onProgress) => {
    if (!disciplineWriteRef.current)
      return { success: false, error: "not_connected" };
    try {
      onProgress?.("Finalizing Shield voting...");
      const gasOpts = await _estimateGasWithBuffer(
        disciplineWriteRef.current.finalizeShieldVote,
        [id],
        GAS_OPTS_HEAVY,
        (signerRef.current?.provider || readRef.current),
      );
      const tx = await disciplineWriteRef.current.finalizeShieldVote(
        id,
        gasOpts,
      );
      const receipt = await tx.wait();
      if (receipt.status !== 1) return { success: false, error: "tx_reverted" };
      onProgress?.("✓ Done");
      return { success: true, txHash: tx.hash };
    } catch (err) {
      return { success: false, error: _friendlyMintError(err) };
    }
  }, []);

  const executeSanction = useCallback(async (id, onProgress) => {
    if (!disciplineWriteRef.current)
      return { success: false, error: "not_connected" };
    try {
      onProgress?.("Executing sanction...");
      const gasOpts = await _estimateGasWithBuffer(
        disciplineWriteRef.current.execute,
        [id],
        GAS_OPTS_HEAVY,
        (signerRef.current?.provider || readRef.current),
      );
      const tx = await disciplineWriteRef.current.execute(id, gasOpts);
      const receipt = await tx.wait();
      if (receipt.status !== 1) return { success: false, error: "tx_reverted" };
      onProgress?.("✓ Sanction executed");
      return { success: true, txHash: tx.hash };
    } catch (err) {
      return { success: false, error: _friendlyMintError(err) };
    }
  }, []);

  /// Full read of a single sanction proposal + whether msg.sender has
  /// already voted.
  /// Checks whether the TARGET ADDRESS (not the caller itself) has a
  /// Shield OR Council SBT. DisciplineModule.proposeSanction() requires
  /// the target to have membership (a sanction acts on the SBT token
  /// itself — no token means nothing to restrict/burn).
  /// Use this BEFORE showing the "vote immediately" option in
  /// ReportModal — otherwise the tx is guaranteed to revert with
  /// "target has no membership to sanction".
  const checkTargetMembership = useCallback(async (targetAddress) => {
    if (!shieldReadRef.current || !councilReadRef.current) return false;
    try {
      const [isShield, isCouncil] = await Promise.all([
        shieldReadRef.current.isMember(targetAddress),
        councilReadRef.current.isCouncilMember(targetAddress),
      ]);
      return isShield || isCouncil;
    } catch {
      return false;
    }
  }, []);

  /// Posts store SEVERAL possible author addresses (a smart-contract
  /// account, the MetaMask EOA wallet, different sources in the DB) —
  /// and not all of them match the address that actually minted the
  /// Shield/Council SBT (mint() is called from msg.sender = usually
  /// the EOA). Instead of trusting ONE, predetermined address (risking
  /// a false "no membership" due to an account ≠ EOA mismatch), we
  /// check the ENTIRE list of candidates ONE BY ONE and return the
  /// first one that's actually a Shield/Council holder.
  const resolveSanctionTarget = useCallback(
    async (candidateAddresses) => {
      for (const addr of candidateAddresses.filter(Boolean)) {
        const isMember = await checkTargetMembership(addr);
        if (isMember) return addr;
      }
      return null;
    },
    [checkTargetMembership],
  );

  // Participation thresholds (% of shieldSupplySnapshot + a minimum
  // floor) and approval thresholds (% "For" among votes cast) — 1:1
  // with the constants in DisciplineModule.sol (WARNING/RESTRICTION/
  // SLASH_*_BPS).
  // ⚠️ This used to compute a simplified "shieldForVotes/totalSupply"
  // — that does NOT match the actual logic of finalizeShieldVote() on
  // the contract (there are TWO separate thresholds there: turnout
  // from the loyalty snapshot AND approval among the For+Against votes
  // cast, with Abstain not counted toward either).
  const _PARTICIPATION = [
    { pctBps: 1_500, floor: 5 }, // Warning: 15%, floor 5
    { pctBps: 2_500, floor: 8 }, // PartialRestriction: 25%, floor 8
    { pctBps: 4_000, floor: 12 }, // FullSlash: 40%, floor 12
  ];
  const _APPROVAL_BPS = [5_000, 5_500, 6_600]; // Warning 50%, Restriction 55%, Slash 66%
  const VETO_QUORUM_BPS = 5_000; // 50%+ (VETO_QUORUM_BPS in DisciplineModule.sol)

  const getSanctionProposal = useCallback(async (id) => {
    if (!disciplineReadRef.current) return null;
    const p = await disciplineReadRef.current.proposals(id);
    const now = Math.floor(Date.now() / 1000);

    const sType = Number(p.sType);
    const shieldSupply = Number(p.shieldSupplySnapshot);
    const forVotes = Number(p.shieldForVotes);
    const againstVotes = Number(p.shieldAgainstVotes);
    const abstainVotes = Number(p.shieldAbstainVotes);
    const totalVoted = forVotes + againstVotes + abstainVotes;
    const decided = forVotes + againstVotes; // excluding Abstain

    const { pctBps, floor } = _PARTICIPATION[sType] ?? _PARTICIPATION[0];
    const requiredParticipation = Math.max(
      Math.floor((shieldSupply * pctBps) / 10_000),
      floor,
    );
    const participationOk =
      shieldSupply > 0 && totalVoted >= requiredParticipation;
    const approvalBps = _APPROVAL_BPS[sType] ?? _APPROVAL_BPS[0];
    const approvalPct =
      decided > 0 ? Math.round((forVotes / decided) * 100) : 0;
    const approvalOk = decided > 0 && approvalPct >= approvalBps / 100;

    const councilSupply = Number(p.councilSupplySnapshot);
    const vetoForVotes = Number(p.vetoForVotes);
    const vetoQuorumPct =
      councilSupply > 0 ? Math.round((vetoForVotes / councilSupply) * 100) : 0;

    return {
      id,
      target: p.target,
      violationPostRef: p.violationPostRef,
      sType,
      sTypeName: SANCTION_TYPES[sType],
      period: Number(p.period),
      periodName: RESTRICTION_PERIODS[Number(p.period)],
      createdAt: Number(p.createdAt),
      shieldSupplySnapshot: shieldSupply,
      shieldVoteDeadline: Number(p.shieldVoteDeadline),
      shieldForVotes: forVotes,
      shieldAgainstVotes: againstVotes,
      shieldAbstainVotes: abstainVotes,
      // Turnout: what % has ALREADY voted (any way) out of the required turnout.
      participationPct:
        requiredParticipation > 0
          ? Math.round((totalVoted / requiredParticipation) * 100)
          : 100,
      participationOk,
      // Approval: the share of "For" among those who took a side (For+Against).
      approvalPct,
      approvalRequiredPct: approvalBps / 100,
      approvalOk,
      // ⚠️ Kept for backward compatibility with old UI code that read
      // shieldQuorumPct — this is now "whether BOTH thresholds are
      // met", not a simple metric. New UI should use
      // participationOk/approvalOk separately for a more accurate
      // progress display.
      shieldQuorumPct: participationOk && approvalOk ? 100 : approvalPct,
      vetoWindowOpenedAt: Number(p.vetoWindowOpenedAt),
      councilSupplySnapshot: councilSupply,
      vetoDeadline: Number(p.vetoDeadline),
      vetoForVotes,
      vetoQuorumPct,
      vetoQuorumRequiredPct: VETO_QUORUM_BPS / 100,
      status: Number(p.status),
      statusName: SANCTION_STATUSES[Number(p.status)],
      shieldVotingOpen:
        Number(p.status) === 0 && now <= Number(p.shieldVoteDeadline),
      vetoWindowOpen: Number(p.status) === 1 && now <= Number(p.vetoDeadline),
      canFinalizeShieldVote:
        Number(p.status) === 0 && now > Number(p.shieldVoteDeadline),
      canExecute: Number(p.status) === 1 && now > Number(p.vetoDeadline),
    };
  }, []);

  /// ADDED: scans ALL of DisciplineModule's SanctionProposed logs and
  /// builds a full list of sanction proposals — the same principle
  /// already implemented below in loadProposals() for DaoGovernor
  /// (chunked getLogs by topic hash, then loading details for each
  /// id), but now for a DIFFERENT contract and a DIFFERENT event.
  /// Without this function, proposals created via
  /// ReportModal.jsx/ModerationQueue.jsx (dao.proposeSanction()) only
  /// existed on the blockchain and never showed up as a list anywhere
  /// in the UI — loadProposals() fundamentally can't see them, since
  /// it listens to a different contract (CONTRACTS.daoGovernor) and a
  /// different event (ProposalCreated, not SanctionProposed).
  const loadSanctionProposals = useCallback(async () => {
    if (!readRef.current) {
      setError("Please connect your wallet first");
      return;
    }
    setLoadingSanctionProposals(true);
    setError(null);
    try {
      const currentBlock = await readRef.current.getBlockNumber();
      const fromBlock = _proposalsFromBlock(currentBlock);
      const disciplineIface = new ethers.Interface(DISCIPLINE_ABI);
      const topicHash = ethers.id(
        "SanctionProposed(uint256,address,uint8,bytes32)",
      );

      async function fetchAllSanctionLogs() {
        const address = CONTRACTS.disciplineModule;
        const allLogs = await _getLogsAdaptive(
          readRef.current,
          { address, topics: [topicHash] },
          fromBlock,
          currentBlock,
        );
        return allLogs;
      }

      const logs = await fetchAllSanctionLogs();

      // From the logs we only take id + blockNumber (for sorting, just
      // like in loadProposals) - all other fields (status, deadlines,
      // votes) are read through the already-built getSanctionProposal(),
      // to avoid duplicating the Proposal struct parsing logic in two places.
      const idsWithBlock = logs
        .map((log) => {
          try {
            const parsed = disciplineIface.parseLog(log);
            return {
              id: parsed.args.id.toString(),
              blockNumber: log.blockNumber,
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.blockNumber - a.blockNumber);

      const full = await Promise.all(
        idsWithBlock.map(async ({ id, blockNumber }) => {
          const p = await getSanctionProposal(id);
          return p ? { ...p, blockNumber } : null;
        }),
      );

      setSanctionProposals(full.filter(Boolean));
    } catch (err) {
      setError(`Sanction proposals error: ${err.message.slice(0, 120)}`);
    } finally {
      setLoadingSanctionProposals(false);
    }
  }, [getSanctionProposal]);

  const loadProposals = useCallback(async () => {
    if (!readRef.current) {
      setError("Please connect your wallet first");
      return;
    }
    setLoadingProposals(true);
    setError(null);
    try {
      const currentBlock = await readRef.current.getBlockNumber();
      const fromBlock = _proposalsFromBlock(currentBlock);
      const govIface = new ethers.Interface(GOV_ABI_BASE);
      const topicHash = ethers.id(
        "ProposalCreated(uint256,address,address[],uint256[],string[],bytes[],uint256,uint256,string)",
      );

      async function fetchAllProposals() {
        const address = CONTRACTS.daoGovernor;
        const allLogs = await _getLogsAdaptive(
          readRef.current,
          { address, topics: [topicHash] },
          fromBlock,
          currentBlock,
        );
        return allLogs
          .map((log) => {
            try {
              const p = govIface.parseLog(log);
              const {
                proposalId,
                proposer,
                targets,
                values,
                calldatas,
                description,
                voteStart,
                voteEnd,
              } = p.args;
              const len = targets.length;
              const _targets = [],
                _values = [],
                _calldatas = [];
              for (let i = 0; i < len; i++) {
                _targets.push(targets[i]);
                const v = values[i];
                _values.push(v === undefined || v === null ? 0n : BigInt(v));
                _calldatas.push(calldatas[i]);
              }
              const id = proposalId.toString();
              proposalDataRef.current[id] = {
                targets: _targets,
                values: _values,
                calldatas: _calldatas,
                description,
              };

              // If this proposal calls ShieldSBT.setPolicy(hash, uri) —
              // extract the hash/uri directly from the calldata, to
              // show a link to the draft with a "not yet accepted"
              // status (until execute() goes through). Works for ANY
              // such proposal, regardless of how it was actually
              // created (the UI form or manually via cast).
              let policyDraft = null;
              const shieldIface = new ethers.Interface(SHIELD_ABI);
              for (let i = 0; i < _targets.length; i++) {
                if (
                  _targets[i]?.toLowerCase() ===
                  CONTRACTS.shieldSBT?.toLowerCase()
                ) {
                  try {
                    const decoded = shieldIface.decodeFunctionData(
                      "setPolicy",
                      _calldatas[i],
                    );
                    policyDraft = {
                      hash: decoded[0],
                      uri: decoded[1],
                    };
                    break;
                  } catch {
                    // not a setPolicy call - ignore, this is a regular proposal
                  }
                }
              }

              return {
                id,
                proposer,
                description,
                title: description.split("\n")[0] || "Untitled",
                desc: description.split("\n").slice(1).join(" ") || "",
                voteStart: voteStart.toString(),
                voteEnd: voteEnd.toString(),
                blockNumber: log.blockNumber,
                stateNum: null,
                votes: null,
                userVoted: null,
                policyDraft,
              };
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      }

      const parsed = (await fetchAllProposals()).sort(
        (a, b) => b.blockNumber - a.blockNumber,
      );

      setProposals(parsed);
      await Promise.all(parsed.map((p) => _loadProposalState(p.id)));
    } catch (err) {
      setError(`Proposals error: ${err.message.slice(0, 120)}`);
    } finally {
      setLoadingProposals(false);
    }
  }, [account]);

  async function _loadProposalState(proposalId) {
    const gov = _gov();
    if (!gov) return;
    try {
      const [stateNum, votes] = await Promise.all([
        gov.state(proposalId),
        gov.proposalVotes(proposalId),
      ]);
      let userVoted = false;
      if (account) userVoted = await gov.hasVoted(proposalId, account);

      const { forVotes, againstVotes, abstainVotes } = votes;
      const total = forVotes + againstVotes + abstainVotes;

      setProposals((prev) =>
        prev.map((p) =>
          p.id === proposalId.toString()
            ? {
                ...p,
                stateNum: Number(stateNum),
                stateName: PROPOSAL_STATES[Number(stateNum)] || "Unknown",
                votes: {
                  for: Number(forVotes).toString(),
                  against: Number(againstVotes).toString(),
                  abstain: Number(abstainVotes).toString(),
                  pFor:
                    total > 0n ? Number((forVotes * 1000n) / total) / 10 : 0,
                  pAgainst:
                    total > 0n
                      ? Number((againstVotes * 1000n) / total) / 10
                      : 0,
                  pAbstain:
                    total > 0n
                      ? Number((abstainVotes * 1000n) / total) / 10
                      : 0,
                },
                userVoted,
              }
            : p,
        ),
      );
    } catch (err) {
      console.warn("_loadProposalState:", proposalId, err.message);
    }
  }

  const refreshProposalState = useCallback(
    (id) => _loadProposalState(id),
    [account],
  );

  // ── Voting ─────────────────────────────────────────────

  const castVote = useCallback(
    async (proposalId, support) => {
      const gov = _gov(true);
      if (!gov) return { success: false, error: "not_connected" };

      // Preflight: staticCall catches a revert BEFORE spending gas and
      // with more reliable data to decode than parsing an already-mined
      // (status=0) tx, where err.data is often missing from the
      // provider's response.
      try {
        await gov.castVote.staticCall(proposalId, support);
      } catch (err) {
        const decoded = _decodeAccessControlError(err);
        return {
          success: false,
          error:
            decoded ||
            err?.reason ||
            err?.shortMessage ||
            err?.info?.error?.message ||
            err.message,
        };
      }

      try {
        // ⚠️ This used to have a fixed GAS_OPTS={gasLimit:500_000n} — on
        // the zkSync stack (Lens testnet, pubdata gas cost), that
        // wasn't enough and castVote() failed with out-of-gas
        // (gasUsed right up against 500_000, but with no decoded
        // revert — a typical sign of OOG, not a logical error). The
        // same cause already fixed for mint() — now gas is estimated
        // dynamically with headroom here too.
        const gasOpts = await _estimateGasWithBuffer(
          gov.castVote,
          [proposalId, support],
          GAS_OPTS,
          (signerRef.current?.provider || readRef.current),
        );
        const tx = await gov.castVote(proposalId, support, gasOpts);
        await tx.wait();
        await _loadProposalState(proposalId);
        return { success: true, txHash: tx.hash };
      } catch (err) {
        const decoded = _decodeAccessControlError(err);
        return {
          success: false,
          error:
            decoded || err?.reason || err?.info?.error?.message || err.message,
        };
      }
    },
    [account],
  );

  // ── Creating a proposal (Council only) ───────────────────

  const submitProposal = useCallback(
    async ({ title, description, type, params, scopeChoice }, onProgress) => {
      const gov = _gov(true);
      if (!gov) return { success: false, error: "not_connected" };
      if (!hasCouncil) {
        return {
          success: false,
          error: "Only a COUNCIL SBT holder can propose.",
        };
      }

      // ── Choosing the hexagon level for proposeScoped() ────────────
      // "earth" (default) — the entire network, always available.
      // "territory" — one's own territory (rankingEpoch.effectiveHexFor),
      // available ONLY if the member has declared and revealed their
      // location, and the corresponding node is already active
      // (nodeOverflowed) — otherwise DaoGovernor._validateScopeChoice()
      // reverts. myEffectiveHex is guaranteed to be consistent with
      // this check (the same chain of logic runs on the contract).
      let scopeLevel = LEVEL_EARTH;
      let scopeBranch = EARTH_BRANCH;
      if (scopeChoice === "territory") {
        if (!myEffectiveHex || myEffectiveHex.level < 0) {
          return {
            success: false,
            error:
              "No active territory of your own — declare and reveal your location on the \"Location\" page, or choose \"Entire Network\".",
          };
        }
        scopeLevel = myEffectiveHex.level;
        scopeBranch = BigInt(myEffectiveHex.branchId);
      }

      const timelockAddr = CONTRACTS.daoTimelock;
      const fullDesc = title + (description ? "\n" + description : "");
      let targets = [],
        values = [],
        calldatas = [];

      if (type === "test") {
        // An empty no-op call to our own Timelock (accepts ETH with no revert).
        targets = [timelockAddr];
        values = [0n];
        calldatas = ["0x"];
      } else if (type === "custom") {
        if (!params?.target) return { success: false, error: "missing_target" };
        targets = [params.target];
        values = [BigInt(params.value || 0)];
        calldatas = [params.calldata || "0x"];
      } else if (type === "updatePolicy") {
        // A specialized type: updating the Human Rights Policy on
        // ShieldSBT (PolicyConsentGate.setPolicy(bytes32,string), DAO_ROLE-gated).
        if (!params?.policyHash || !ethers.isHexString(params.policyHash, 32)) {
          return {
            success: false,
            error: "A valid bytes32 hash is required (0x + 64 hex chars)",
          };
        }
        if (!params?.policyURI) {
          return {
            success: false,
            error: "A link to the policy text is required",
          };
        }
        const shieldIface = new ethers.Interface(SHIELD_ABI);
        const calldata = shieldIface.encodeFunctionData("setPolicy", [
          params.policyHash,
          params.policyURI,
        ]);
        targets = [CONTRACTS.shieldSBT];
        values = [0n];
        calldatas = [calldata];
      }

      try {
        onProgress?.("Sending proposeScoped()...");
        // The same OOG risk on the zkSync stack as castVote/mint —
        // estimating gas dynamically instead of a fixed limit.
        // ⚠️ We always go through proposeScoped (not the bare propose())
        // with LEVEL_EARTH/EARTH_BRANCH — the same approach as the
        // DAO's own first genesis proposal (setTipJarRole+acceptGovernor).
        // The real DaoGovernor._propose() checks Council status
        // REGARDLESS of which entry point was called, but proposeScoped
        // additionally records the proposal's scope (EARTH or one's
        // own territory — scopeLevel/scopeBranch, computed above from
        // scopeChoice).
        //
        // ⚠️ GEO REFORM v14 ("fair ranking"): DaoGovernor now
        // additionally requires a Merkle proof of seat, BUT only when a
        // specific level is ACTUALLY overflowed (nodeOverflowed) —
        // NODE_CAPACITY=244 candidates. At the network's current stage
        // (still very few Council members), no level is overflowed, so
        // these parameters are entirely IGNORED by the contract — a
        // safe placeholder. Once the community actually grows past 244
        // Council members, a separate UI function will be needed to
        // fetch one's own (seatIndex, seatProof) from the off-chain
        // published Merkle tree of seats
        // (rankingEpoch.submitSeatAssignments(), EPOCH_SUBMITTER_ROLE) —
        // for now, that tree may not even exist yet.
        const seatLevel = scopeLevel;
        const seatBranchId = scopeBranch;
        const seatIndex = 0;
        const seatProof = [];

        const gasOpts = await _estimateGasWithBuffer(
          gov.proposeScoped,
          [targets, values, calldatas, fullDesc, scopeLevel, scopeBranch, seatLevel, seatBranchId, seatIndex, seatProof],
          GAS_OPTS_HEAVY,
          (signerRef.current?.provider || readRef.current),
        );
        const tx = await gov.proposeScoped(
          targets,
          values,
          calldatas,
          fullDesc,
          scopeLevel,
          scopeBranch,
          seatLevel,
          seatBranchId,
          seatIndex,
          seatProof,
          gasOpts,
        );
        onProgress?.(`TX: ${tx.hash.slice(0, 20)}...`);
        const receipt = await tx.wait();

        const govIface = new ethers.Interface(GOV_ABI_BASE);
        let proposalId = null;
        for (const log of receipt.logs) {
          try {
            const p = govIface.parseLog(log);
            if (p.name === "ProposalCreated") {
              proposalId = p.args.proposalId.toString();
              proposalDataRef.current[proposalId] = {
                targets,
                values,
                calldatas,
                description: fullDesc,
              };
              break;
            }
          } catch {}
        }
        onProgress?.(`✓ Proposal ID: ${proposalId?.slice(0, 16)}...`);
        return {
          success: true,
          proposalId,
          txHash: tx.hash,
          block: receipt.blockNumber,
        };
      } catch (err) {
        const decoded = _decodeAccessControlError(err);
        if (decoded) return { success: false, error: decoded };
        const raw =
          err?.reason || err?.info?.error?.message || err.message || "";
        // DaoGovernor.sol: require(councilSBT.isCouncilMember(proposer), "DaoGovernor: only Council can propose");
        if (raw.includes("DaoGovernor: only Council can propose")) {
          return {
            success: false,
            error: "Only a COUNCIL SBT holder can propose.",
          };
        }
        return { success: false, error: raw };
      }
    },
    [hasCouncil, myEffectiveHex],
  );

  // ── Helper: recover proposal data from logs if the ref is empty ──

  async function _ensureProposalData(proposalId) {
    if (proposalDataRef.current[proposalId])
      return proposalDataRef.current[proposalId];
    if (!readRef.current) return null;

    const govIface = new ethers.Interface(GOV_ABI_BASE);
    const topicHash = ethers.id(
      "ProposalCreated(uint256,address,address[],uint256[],string[],bytes[],uint256,uint256,string)",
    );
    const address = CONTRACTS.daoGovernor;
    const currentBlock = await readRef.current.getBlockNumber();
    const fromBlock = _proposalsFromBlock(currentBlock);

    const allChunkLogs = await _getLogsAdaptive(
      readRef.current,
      { address, topics: [topicHash] },
      fromBlock,
      currentBlock,
    );
    {
      for (const log of allChunkLogs) {
        try {
          const p = govIface.parseLog(log);
          if (p.args.proposalId.toString() === proposalId) {
            const rawTargets = p.args.targets;
            const rawValues = p.args.values;
            const rawCalldatas = p.args.calldatas;
            const len = rawTargets.length;
            const targets = [],
              values = [],
              calldatas = [];
            for (let i = 0; i < len; i++) {
              targets.push(rawTargets[i]);
              const v = rawValues[i];
              values.push(v === undefined || v === null ? 0n : BigInt(v));
              calldatas.push(rawCalldatas[i]);
            }
            const data = {
              targets,
              values,
              calldatas,
              description: p.args.description,
            };
            proposalDataRef.current[proposalId] = data;
            return data;
          }
        } catch {}
      }
    }
    return null;
  }

  // ── Queue / Execute ────────────────────────────────────

  const queueProposal = useCallback(async (proposalId) => {
    const gov = _gov(true);
    const data = await _ensureProposalData(proposalId);
    if (!data)
      return { success: false, error: "Could not find proposal data" };

    const descHash = ethers.id(data.description);
    try {
      const computedId = await gov.hashProposal(
        data.targets,
        data.values,
        data.calldatas,
        descHash,
      );
      if (computedId.toString() !== proposalId) {
        return {
          success: false,
          error: `Mismatch proposalId: computed=${computedId.toString()} expected=${proposalId}`,
        };
      }
    } catch (e) {
      console.warn("[queueProposal] hashProposal check failed:", e);
    }

    try {
      // The same OOG cause as in castVote/propose — a dynamic estimate.
      const gasOpts = await _estimateGasWithBuffer(
        gov.queue,
        [data.targets, data.values, data.calldatas, descHash],
        GAS_OPTS_HEAVY,
        (signerRef.current?.provider || readRef.current),
      );
      const tx = await gov.queue(
        data.targets,
        data.values,
        data.calldatas,
        descHash,
        gasOpts,
      );
      await tx.wait();
      await _loadProposalState(proposalId);
      return { success: true };
    } catch (err) {
      const decoded = _decodeAccessControlError(err);
      return {
        success: false,
        error:
          decoded || err?.reason || err?.info?.error?.message || err.message,
      };
    }
  }, []);

  const executeProposal = useCallback(
    async (proposalId) => {
      const gov = _gov(true);
      const data = await _ensureProposalData(proposalId);
      if (!data)
        return { success: false, error: "Could not find proposal data" };

      const descHash = ethers.id(data.description);
      try {
        const stateNum = await gov.state(proposalId);
        if (Number(stateNum) === 7)
          return { success: false, error: "Proposal already executed." };
        if (Number(stateNum) !== 5) {
          return {
            success: false,
            error: `Proposal is not in the Queued state (state=${stateNum}).`,
          };
        }
      } catch (e) {
        console.warn("[executeProposal] state check failed:", e);
      }

      try {
        // ⚠️ _estimateGasWithBuffer now RETHROWS logical reverts (with
        // errData) instead of swallowing them and sending a doomed
        // transaction. Typical case: TimelockUnexpectedOperationState
        // — execute() before the Timelock delay ends.
        const gasOpts = await _estimateGasWithBuffer(
          gov.execute,
          [data.targets, data.values, data.calldatas, descHash],
          GAS_OPTS_HEAVY,
          (signerRef.current?.provider || readRef.current),
        );
        const tx = await gov.execute(
          data.targets,
          data.values,
          data.calldatas,
          descHash,
          gasOpts,
        );
        await tx.wait();
        await _loadProposalState(proposalId);
        await _refreshAll(account);
        return { success: true };
      } catch (err) {
        // _decodeContractError covers: AccessControl,
        // TimelockUnexpectedOperationState, TimelockUnexecutedOperation
        // — both from estimateGas (now rethrown) and from an actually
        // mined tx (if estimateGas somehow missed it).
        const decoded = _decodeContractError(err);
        return {
          success: false,
          error: decoded || err?.reason || err?.shortMessage || err.message,
        };
      }
    },
    [account],
  );

  // ── Geo reform STAGE 2-4: location, ranking, hex treasury ─────

  /**
   * Declare a location (Step 1+2 of the ZK flow): browser geolocation
   * permission → a local Poseidon commitment →
   * setLocationCommitment() on-chain. The raw hexId NEVER appears
   * on-chain — only the commitment.
   */
  const declareLocation = useCallback(
    async (resolution, onProgress, manualCoords) => {
      if (!locationWriteRef.current)
        return { success: false, error: "not_connected" };
      try {
        const { determineLocation, determineLocationFromCoords } =
          await import("../lib/locationZk");
        let commitment, usedRes;
        if (manualCoords) {
          ({ commitment, resolution: usedRes } =
            await determineLocationFromCoords(
              manualCoords.latitude,
              manualCoords.longitude,
              resolution ?? 10,
              onProgress,
            ));
        } else {
          onProgress?.("Requesting browser geolocation permission...");
          ({ commitment, resolution: usedRes } = await determineLocation(
            resolution ?? 10,
            onProgress,
          ));
        }

        // Human Rights Policy Consent for LocationRegistry (the
        // "Location Disclosure Notice") — separate from the ShieldSBT
        // policy, required BEFORE the first setLocationCommitment().
        const accepted =
          await locationReadRef.current.hasAcceptedCurrentPolicy(account);
        if (!accepted) {
          onProgress?.("Accepting the location disclosure notice...");
          const policyHash = await locationReadRef.current.currentPolicyHash();
          const policyGasOpts = await _estimateGasWithBuffer(
            locationWriteRef.current.acceptPolicy,
            [policyHash],
            GAS_OPTS,
            (signerRef.current?.provider || readRef.current),
          );
          const policyTx = await locationWriteRef.current.acceptPolicy(
            policyHash,
            policyGasOpts,
          );
          await policyTx.wait();
        }

        onProgress?.("Recording the location commitment on-chain...");
        const gasOpts = await _estimateGasWithBuffer(
          locationWriteRef.current.setLocationCommitment,
          [commitment],
          GAS_OPTS,
          (signerRef.current?.provider || readRef.current),
        );
        const tx = await locationWriteRef.current.setLocationCommitment(
          commitment,
          gasOpts,
        );
        onProgress?.(`TX: ${tx.hash.slice(0, 20)}... waiting for block`);
        const receipt = await tx.wait();
        if (receipt.status !== 1) return { success: false, error: "tx_reverted" };
        onProgress?.(`✓ Location declared (resolution ${usedRes})`);
        await _refreshAll(account);
        return { success: true, txHash: tx.hash };
      } catch (err) {
        console.error("declareLocation:", err);
        return {
          success: false,
          error: err?.message || "Failed to determine or record the location.",
        };
      }
    },
    [account],
  );

  /**
   * Compute which levels it MAKES SENSE to reveal right now — not just
   * "0..10, take your pick", but only the ones that actually change
   * something in routing/voting. Mirrors the cascading algorithm in
   * CouncilRankingEpoch.effectiveHexFor() (a level is active if ALL
   * levels 0..level-1 are already overflowed/nodeOverflowed) —
   * computed LOCALLY (no reveal, no ZK) via the user's own ancestor
   * chain + public (free) nodeOverflowed reads for each level.
   */
  const computeRevealableLevels = useCallback(async () => {
    if (!rankingReadRef.current) return { levels: [], earthOverflowed: false };
    const { getLocalAncestor } = await import("../lib/locationZk");

    const earthKey = await rankingReadRef.current.nodeKeyOf(
      LEVEL_EARTH,
      EARTH_BRANCH,
    );
    const earthOverflowed = await rankingReadRef.current.nodeOverflowed(earthKey);
    if (!earthOverflowed) return { levels: [], earthOverflowed: false };

    const levels = [];
    for (let lvl = 0; lvl <= 10; lvl++) {
      const branchId = getLocalAncestor(lvl);
      if (branchId === null) break; // deeper than the declared resolution
      levels.push(lvl);
      const key = await rankingReadRef.current.nodeKeyOf(lvl, branchId);
      const overflowed = await rankingReadRef.current.nodeOverflowed(key);
      if (!overflowed) break; // this node isn't overflowed yet — deeper levels aren't active yet
    }
    return { levels, earthOverflowed: true };
  }, []);

  /**
   * Reveal a specific ancestor level (a ZK proof, generated locally in
   * the browser) — Step 3 of the flow. Typically only called for the
   * level that's actually needed (e.g. the current active cascade in
   * one's own region).
   */
  const revealLocationLevel = useCallback(
    async (level, onProgress) => {
      if (!locationWriteRef.current)
        return { success: false, error: "not_connected" };
      try {
        const { generateRevealProof } = await import("../lib/locationZk");
        const { branchId, a, b, c } = await generateRevealProof(
          level,
          onProgress,
        );

        onProgress?.("Submitting the proof on-chain...");
        const gasOpts = await _estimateGasWithBuffer(
          locationWriteRef.current.revealAncestor,
          [level, branchId, a, b, c],
          GAS_OPTS_HEAVY,
          (signerRef.current?.provider || readRef.current),
        );
        const tx = await locationWriteRef.current.revealAncestor(
          level,
          branchId,
          a,
          b,
          c,
          gasOpts,
        );
        onProgress?.(`TX: ${tx.hash.slice(0, 20)}... waiting for block`);
        const receipt = await tx.wait();
        if (receipt.status !== 1) return { success: false, error: "tx_reverted" };
        onProgress?.(`✓ Level ${level} revealed`);
        await _refreshAll(account);
        return { success: true, txHash: tx.hash };
      } catch (err) {
        console.error("revealLocationLevel:", err);
        return {
          success: false,
          error: err?.message || "Failed to generate or submit the ZK proof.",
        };
      }
    },
    [account],
  );

  /** A general overview of the current ranking epoch — public data, no wallet required. */
  const loadRankingOverview = useCallback(async () => {
    if (!rankingReadRef.current) return;
    try {
      const [
        epoch,
        epochStartedAt,
        minDuration,
        qBps,
        capacity,
        activeHexagons,
        earthOverflowed,
      ] = await Promise.all([
        rankingReadRef.current.currentEpoch(),
        rankingReadRef.current.currentEpochStartedAt(),
        rankingReadRef.current.minEpochDuration(),
        rankingReadRef.current.quorumBps(),
        rankingReadRef.current.NODE_CAPACITY(),
        rankingReadRef.current.totalActiveHexagons(),
        rankingReadRef.current.nodeOverflowed(
          await rankingReadRef.current.nodeKeyOf(LEVEL_EARTH, EARTH_BRANCH),
        ),
      ]);
      setRankingOverview({
        epoch: epoch.toString(),
        epochStartedAt: Number(epochStartedAt),
        minEpochDurationDays: Number(minDuration) / 86400,
        minEpochDurationSeconds: Number(minDuration),
        quorumPct: (Number(qBps) / 100).toFixed(1),
        nodeCapacity: Number(capacity),
        totalActiveHexagons: Number(activeHexagons),
        earthOverflowed,
      });
    } catch (err) {
      console.error("loadRankingOverview:", err);
    }
  }, []);

  /**
   * Treasury hex balances across the entire ancestor "chain" (EARTH +
   * all of the member's revealed levels) for a specific token — data
   * for the Treasury page.
   */
  const loadHexTreasuryBalances = useCallback(
    async (tokenAddress) => {
      if (!treasuryReadRef.current) return [];
      const token = tokenAddress || CONTRACTS.testTokenUSD;
      try {
        const chain = [{ level: LEVEL_EARTH, branchId: EARTH_BRANCH, label: "EARTH" }];
        if (locationInfo?.revealedLevels?.length) {
          for (const { level, branchId } of locationInfo.revealedLevels) {
            chain.push({ level, branchId: BigInt(branchId), label: `Level ${level}` });
          }
        }
        const balances = await Promise.all(
          chain.map(async ({ level, branchId, label }) => {
            const key = await treasuryReadRef.current.nodeKeyOf(level, branchId);
            const bal = await treasuryReadRef.current.hexBalance(token, key);
            return { level, branchId: branchId.toString(), label, balance: bal.toString() };
          }),
        );
        const [operational, totalEarmarked, availableGeneral] = await Promise.all([
          treasuryReadRef.current.operationalBalance(token),
          treasuryReadRef.current.totalEarmarked(token),
          treasuryReadRef.current.availableToWithdraw(token),
        ]);
        return {
          token,
          hexBalances: balances,
          operationalBalance: operational.toString(),
          totalEarmarked: totalEarmarked.toString(),
          availableToWithdraw: availableGeneral.toString(),
        };
      } catch (err) {
        console.error("loadHexTreasuryBalances:", err);
        return null;
      }
    },
    [locationInfo],
  );

  // ── DaoGovernor parameters ────────────────────────────────

  const loadGovParams = useCallback(async () => {
    if (!readRef.current) return;
    try {
      // ⚠️ DaoGovernor now runs on CLOCK_MODE="mode=timestamp" - we take
      // the TIME of the latest block, not its NUMBER, and compute
      // quorum() from the time.
      const latestBlock = await readRef.current.getBlock("latest");
      const currentTimestamp = latestBlock.timestamp;
      const gov = _gov();
      const [delay, period, threshold, quorumBps, quorumNow] =
        await Promise.all([
          gov.votingDelay(),
          gov.votingPeriod(),
          gov.proposalThreshold(),
          gov.QUORUM_BPS(),
          gov.quorum(currentTimestamp - 1),
        ]);
      // votingDelay/votingPeriod here are in SECONDS (testnet: 60s / 600s)
      setGovParams({
        currentTimestamp,
        addresses: { ...CONTRACTS },
        votingDelaySeconds: delay.toString(),
        votingDelayMinutes: (Number(delay) / 60).toFixed(1),
        votingPeriodSeconds: period.toString(),
        votingPeriodMinutes: (Number(period) / 60).toFixed(1),
        proposalThreshold: threshold.toString(),
        quorumBps: quorumBps.toString(),
        quorumPct: (Number(quorumBps) / 100).toFixed(1),
        quorumNow: quorumNow.toString(),
      });
    } catch (err) {
      console.error("loadGovParams:", err);
    }
  }, []);

  // ── Public interface ──────────────────────────────────

  return {
    account,
    rights,
    votingPower,
    hasShield,
    hasCouncil,
    shieldInfo,
    councilInfo,
    isRestricted,
    blackMarks,
    locationInfo,
    myEffectiveHex,
    rankingOverview,
    loadingLocation,
    roleWarnings,
    proposals,
    sanctionProposals,
    govParams,
    connecting,
    loadingProposals,
    loadingSanctionProposals,
    error,
    isConnected: !!account,
    // Actions
    connect,
    silentConnect,
    disconnect,
    mintShield,
    mintCouncil,
    reacceptPolicy,
    shieldEligibility,
    councilEligibility,
    loadProposals,
    loadSanctionProposals,
    refreshProposalState,
    castVote,
    submitProposal,
    queueProposal,
    executeProposal,
    loadGovParams,
    refreshTokenStatus,
    // Geo reform STAGE 2-4
    declareLocation,
    revealLocationLevel,
    computeRevealableLevels,
    loadRankingOverview,
    loadHexTreasuryBalances,
    // DisciplineModule (complaints/sanctions for posts)
    canProposeSanction,
    checkTargetMembership,
    resolveSanctionTarget,
    proposeSanction,
    voteShieldSanction,
    vetoSanction,
    finalizeSanctionShieldVote,
    executeSanction,
    getSanctionProposal,
  };
}
