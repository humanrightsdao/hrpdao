# HR DAO — Yellow Paper

*Rigorous protocol specification: formulas, thresholds, and state machines, for developers and auditors. Prose explanations live in the Whitepaper; usage instructions live in the Docs; wire formats live in the Spec.*

Target environment: Solidity `^0.8.24`, `evm_version = cancun`, OpenZeppelin Contracts `v5.7.0`, deployed on Arbitrum (Sepolia for staging, Arbitrum One for production). All monetary constants below are the intended production values; the same contract bytecode is used for both testnet and mainnet, differing only by constructor-supplied timing parameters (see §9).

## 1. Global notation

- `bps` — basis points, denominator 10,000 (`BPS_DENOMINATOR`).
- All timestamps are `block.timestamp` (seconds); the DAO's clock mode is `mode=timestamp`, not block number.
- `Checkpoints.Trace208` (OpenZeppelin) is used throughout for snapshot/history lookups: `upperLookupRecent(key)` returns the most recent value recorded at or before `key`.

## 2. Membership thresholds

| Parameter | Contract | Value | Notes |
|---|---|---|---|
| `INFLUENCE_THRESHOLD` (Shield) | `ShieldSBT` | 200 | Raw Influence units ($ = points, not 18-decimal) |
| `INFLUENCE_THRESHOLD` (Council) | `CouncilSBT` | 500 | |
| `minHumanityScore` (Shield) | `ShieldSBT` | DAO-configurable, deploy default 2000 (×100 scale ⇒ score 20.00) | |
| `minHumanityScore` (Council) | `CouncilSBT` | DAO-configurable, deploy default 5000 (⇒ score 50.00) | Strictly ≥ Shield's |
| `YEAR1_GRACE_DURATION` | `ShieldSBT` | 180 days | Applies if `block.timestamp − projectStartTimestamp < 365 days` at mint time |
| `YEAR2_GRACE_DURATION` | `ShieldSBT` | 365 days | Applies if age is in `[365, 730)` days |
| `STANDARD_DURATION` | `ShieldSBT` | 730 days | Applies thereafter (permanent standard) |

`requiredCouncilDuration[account]` is fixed **once**, at the moment `account` mints Shield, using `_currentGraceDuration()` evaluated at that instant — it never changes retroactively, even as the project ages past a grace boundary.

Council mint additionally requires:

```
block.timestamp − ShieldSBT.memberSince(msg.sender) >= ShieldSBT.requiredCouncilDuration(msg.sender)
```

## 3. Influence: accrual, decay, voting weight

### 3.1 Accrual

On `InfluenceRegistry.award(author, amount, postRef)` (callable only by `TIPJAR_ROLE`):

```
effectiveAmount = amount × currentStageMultiplierBps() / BPS_DENOMINATOR
influence[author] += effectiveAmount
```

`amount` is the raw $-equivalent value passed by TipJar (the full, pre-split tip amount); `effectiveAmount` is what is actually credited, after the network-stage multiplier (§3.4).

### 3.2 Decay

Decay is lazy — applied at read time and at the next `award()`/`touchActivity()` — compounding annually (not quarterly), 10% per elapsed year:

```
numYears = floor((block.timestamp − lastActivityTimestamp[account]) / 365 days)
decayed  = influence[account] × (1 − DECAY_BPS/BPS_DENOMINATOR)^numYears
         = influence[account] × 0.9^numYears        (DECAY_BPS = 1000)
```

No decay is applied if `numYears == 0`. `touchActivity()` (callable by `ACTIVITY_ROLE`: `DaoGovernor` on every counted vote, `DisciplineModule` on every proposal/vote/veto) resets the decay clock **without** crediting Influence — voting is treated as a stronger activity signal than the underlying reputation amount.

### 3.3 Voting weight

```
votingPower(account) = ⌊⌊decayed(account)^(1/2)⌋^(1/2)⌋   (two integer Babylonian sqrt passes)
```

i.e. `influence^(1/4)`. A 10,000× increase in Influence yields only a 10× increase in voting weight.

### 3.4 Network stage (dynamic $→Influence rate)

```
networkStage() = 0                                  if councilSBT.totalSupply() < STAGE_THRESHOLD (244)
                = 1                                  if councilSBT.totalSupply() >= 244
currentStageMultiplierBps() = BPS_DENOMINATOR >> networkStage()   // 10000 at stage 0, 5000 at stage 1
```

Stage is a global, non-regional signal — deliberately limited to `{0, 1}`. Stage 2+ is intentionally unspecified in this snapshot: level-0 has 122 distinct hexagon branches, and no formula over the single global `councilSBT.totalSupply()` value can correctly infer "is any one specific branch actually saturated" (a densely populated branch could inflate the global count while every individual branch remains under capacity). Three DAO-votable extension paths are documented in-contract (explicit per-epoch stage submission by the epoch submitter; permanently freezing at stage 1; or a per-hexagon rate) but none is implemented pending a governance decision.

### 3.5 Snapshotting for votes

Both eligibility *and* weight are read from history, not live state, to close a manipulation window (a member could otherwise receive a large tip mid-vote specifically to inflate their weight on a live proposal):

```
getPastInfluence(account, timepoint)     — Influence "frozen" as of timepoint, decay-adjusted relative to timepoint
getPastVotingPower(account, timepoint)   = sqrt(sqrt(getPastInfluence(account, timepoint)))
```

`DaoVotesAdapter._weightAt()` uses `getPastVotingPower`, never the live `votingPower()`, for actual vote counting.

## 4. Governance (`DaoGovernor`)

### 4.1 Quorum

```
quorum(timepoint) = shieldSBT.getPastActiveSupply(timepoint) × QUORUM_BPS / BPS_DENOMINATOR
QUORUM_BPS = 2000   (20%, provisional pending pre-mainnet confirmation)
```

The denominator is **active** Shield supply (members who touched the DAO within `inactivityWindow`, default 180 days — donation, vote, proposal, or veto), not total supply, and **not** Shield+Council summed (Council is a strict subset of Shield by construction: every Council mint requires an active Shield at that moment, so summing would double-count — the one documented exception is a Shield burned independently of Council via `FullSlash`, an accepted, narrow edge case).

### 4.2 Eligibility and weight (`DaoVotesAdapter`)

```
eligible(account, timepoint) =
    (shieldSBT.isMember(account) AND shieldSBT.memberSince(account) <= timepoint)
    OR (councilSBT.isCouncilMember(account) AND councilSBT.memberSince(account) <= timepoint)
weight(account, timepoint) = eligible ? getPastVotingPower(account, timepoint) : 0
    (further gated: 0 if !shieldSBT.isCompliant(account), 0 if discipline.isRestricted(account))
```

### 4.3 Proposing

`propose()` reverts unless `councilSBT.isCouncilMember(proposer)`. There is no separate "policy proposal" type — `ShieldSBT.setPolicy()`/`setReacceptGracePeriod()` go through the identical `propose()`/vote/quorum/timelock path as any other call.

### 4.4 Geo-scoped proposals

`proposeScoped(targets, values, calldatas, description, level, branchId, seatLevel, seatBranchId, seatIndex, seatProof)`:

- `level = LEVEL_EARTH (−1)` with `branchId = EARTH_BRANCH (0)` is the unscoped, global case (equivalent to ordinary `propose()`, still requires a valid seat proof only if EARTH is overflowed).
- For `level >= 0`, the proposer's own declared territory must contain `(level, branchId)` (`_isWithinTerritory`), the target node must be `nodeOverflowed[key] == true` (i.e., real, active, and ranked), and — once EARTH itself has overflowed (top-244 seats meaningfully assigned) — the proposer must supply a valid Merkle seat proof for a seat at or above the proposed level, in their own branch.

Vote counting for scoped proposals additionally reverts (not silently zero-weights) any vote from an account outside the proposal's territory:

```
_isWithinTerritory(account, level, branchId) =
    true                                                              if level < 0 (EARTH)
    locationRegistry.getRevealedAncestorAt(account, level, currentEpochStartedAt) == branchId   otherwise
```

Territory checks use the disclosure state **as of the start of the current epoch**, not the live value — disclosing a new territory mid-epoch cannot immediately grant voting rights there ("territorial jump" prevention).

### 4.5 Scoped quorum

```
required(proposalId) = max(scopedQuorumFloor, rankingEpoch.quorumFor(level, branchId))
scopedQuorumFloor = 3       (DAO-configurable absolute floor)
quorumFor(level, branchId) = nodeSeatCount[key] × quorumBps / BPS_DENOMINATOR    (quorumBps default 2000, 20%)
```

Quorum is reached when the number of distinct addresses that voted (`_voterCount`) meets or exceeds `required`. This `max(floor, %)` guards both extremes: a fixed floor alone lets a proposer cherry-pick a newly opened, sparsely populated hexagon to pass a proposal with as few as 3 votes; a percentage alone can round to zero on a very small node.

### 4.6 Vote counting side effects

Every counted vote (`totalWeight > 0`) increments `_voterCount[proposalId]` and calls `influenceRegistry.touchActivity(account)`.

## 5. Discipline (`DisciplineModule`)

### 5.1 State machine

```
Pending --[finalizeShieldVote: quorum met]--> VetoWindow --[execute: window closed, not vetoed]--> Executed
Pending --[finalizeShieldVote: quorum not met]--> Cancelled
VetoWindow --[vetoSanction: >50% active Council]--> Cancelled
```

### 5.2 Timing constants

| Constant | Value |
|---|---|
| `SHIELD_VOTING_PERIOD` | 7 days |
| `VETO_WINDOW` | 10 days |
| `REPROPOSAL_COOLDOWN` | 14 days (only applies after a `Cancelled` outcome, on the same `violationPostRef`) |

### 5.3 Severity-tiered thresholds

Participation is `max(floor, pct% of shieldSupplySnapshot)`; approval is the share of "For" among *decided* votes (For+Against, excluding Abstain), required strictly greater than the listed bps (a tie no longer passes, post-fix):

| Sanction | Participation floor | Participation % | Approval (strict >) |
|---|---|---|---|
| `Warning` | 5 | 15% (`WARNING_PARTICIPATION_BPS`) | 50% (`WARNING_APPROVAL_BPS`) |
| `PartialRestriction` | 8 | 25% (`RESTRICTION_PARTICIPATION_BPS`) | 55% (`RESTRICTION_APPROVAL_BPS`) |
| `FullSlash` | 12 | 40% (`SLASH_PARTICIPATION_BPS`) | 66% (`SLASH_APPROVAL_BPS`, qualified majority) |

`shieldSupplySnapshot` is `shieldSBT.activeSupply()` captured at `proposeSanction()` time, not a live value. Voting eligibility for `voteShield()` requires `shieldSBT.memberSince(msg.sender) <= p.createdAt` (must have been a member before the proposal existed).

Veto (`vetoSanction`) passes (cancels the sanction) when:

```
vetoForVotes × BPS_DENOMINATOR / councilSupplySnapshot > VETO_QUORUM_BPS   (VETO_QUORUM_BPS = 5000, strict >)
```

`councilSupplySnapshot = councilSBT.activeSupply()` captured at the moment the veto window opens; eligibility requires `councilSBT.memberSince(msg.sender) <= p.vetoWindowOpenedAt`.

### 5.4 Restriction periods

`RestrictionPeriod` is a fixed enum — `Quarter` (90 days), `Year` (365 days), `FiveYears` (1825 days). There is no "permanent" partial restriction; a permanent consequence is only available via `FullSlash`, which burns the relevant SBT(s) outright.

### 5.5 Evidence reuse

`violationPostUsed[violationPostRef]` is set **only on `Executed`**, not on proposal creation — a failed (`Cancelled`) proposal does not permanently burn the evidence; a fresh proposal (typically with a different, usually lighter, sanction type) may reference the same evidence after `REPROPOSAL_COOLDOWN`.

## 6. Geography

### 6.1 H3 index bit layout (`H3Utils`)

64-bit H3 v1 index, LSB-numbered: mode at bits 59–62 (`1` = Cell), resolution at bits 52–55 (0–15), base cell at bits 45–51, then 3 bits per resolution level 1–15 (`7` = unused digit). `parentOf()` clears the resolution field, decrements it by one, and marks the vacated digit slot as unused (`0b111`) — verified against `h3-js` reference output across three continents. **Not used on-chain for user-supplied locations post-v12** (see §6.3) — retained for any future need to derive ancestry from a raw, already-public H3 index.

### 6.2 Cascade capacity and epochs

```
NODE_CAPACITY   = 244    (per node, any level, including EARTH)
MAX_RESOLUTION  = 10     (finest H3 resolution a ZK proof can attest to)
minEpochDuration = 90 days   (DAO-configurable; epochs cannot start more frequently)
LEVEL_EARTH = −1, EARTH_BRANCH = 0   (sentinel; real H3 indices at res 0–10 never encode branchId = 0)
```

A node is `nodeOverflowed[nodeKey(level, branchId)] = true` once the off-chain epoch submitter reports it has reached capacity; this flag — not the raw seat count — is what gates whether the next-finer resolution is considered "active" beneath it.

### 6.3 Zero-knowledge location disclosure

Circuit: `zk/circuits/HexAncestry.circom`, Circom 2.1.9, Groth16, 398 non-linear constraints, 3 public inputs (`commitment`, `level`, `branchId`), 2 private inputs (`hexId`, `salt`).

**Statement proved:** "I know `hexId` and `salt` such that `Poseidon(hexId, salt) == commitment` AND the ancestor of `hexId` at resolution `level` equals `branchId`" — without revealing `hexId`. The ancestor is reconstructed directly by field truncation (same mode/base-cell bits, target resolution, digit groups above `level` marked unused), not by iterative parent-hopping, keeping the constraint count low.

**On-chain effect of `LocationRegistry.revealAncestor(level, branchId, a, b, c)`:** on successful `verifier.verifyProof()`, sets `revealedAncestorOf[account][level] = branchId`, appends a `Checkpoints.Trace208` entry (for epoch-aware historical lookups), and updates `deepestRevealedLevel[account]` if `level` is a new maximum. The raw `hexId` and `salt` never appear in calldata or storage at any point.

**⚠️ Trusted setup status:** the verification key and Solidity verifier currently in this repository were generated by a single-party, non-production Powers-of-Tau ceremony run locally for testing. Production deployment requires either joining an existing public multi-party ceremony (e.g. Hermez/PSE) and regenerating `HexAncestry_final.zkey` from it, or migrating to a setup-free scheme (PLONK/Halo2). Either path requires regenerating and redeploying `src/HexAncestryVerifier.sol`.

### 6.4 Effective territory resolution

```
effectiveHexFor(account) → (level, branchId)
```

Starting from EARTH, walks the chain of the account's **already-revealed, epoch-frozen** ancestors (`getRevealedAncestorAt(account, r, currentEpochStartedAt)`) for `r = 0 .. deepestRevealedLevel(account)`, stopping at the first level whose node is not yet `nodeOverflowed`, or at the account's deepest disclosed level, whichever comes first. `activeLevelsForAccount(account)` returns the count of levels in this same walk (1, for EARTH alone, up to `2 + MAX_RESOLUTION`). Both functions are guaranteed consistent because they traverse the identical chain.

Because downstream consumers (Treasury, DaoGovernor) read `getRevealedAncestorAt`, not a live on-the-fly computation, **a payer's tax/vote participation is capped by what they have chosen to disclose** — an undisclosed-but-densely-populated real-world region contributes nothing to that member's effective territory until they reveal it.

### 6.5 Seat assignment (Merkle, gas-bounded)

Per-account seat data is **not** stored on-chain (a prior design that did so became gas-prohibitive past a few hundred candidates). Instead:

```
leafHash(index, account, hasSeat, level, branchId) = keccak256(abi.encode(index, account, hasSeat, level, branchId))
```

`submitSeatAssignments()`/`OptimisticEpochSubmission.submitEpochResult()` take the full candidate arrays as **calldata only**, build a Merkle tree on-chain (`SeatMerkleLib.buildRoot`, sorted-pair `commutativeKeccak256`, OpenZeppelin-compatible), and persist only `epochSeatRoot[epoch]` (32 bytes) and `epochLeafCount[epoch]` — O(1) storage regardless of candidate count. Membership proofs (`verifySeatLeaf`) are standard `MerkleProof.verifyCalldata`, O(log n).

### 6.6 Optimistic epoch submission (permissionless path)

An Optimistic-Rollup-style bond-and-challenge mechanism (`OptimisticEpochSubmission`) offers a permissionless alternative to a trusted `EPOCH_SUBMITTER_ROLE` multisig:

| Parameter | Default |
|---|---|
| `requiredBond` | 1 ether |
| `challengeBond` | 0.1 ether |
| `challengePeriod` | 3 days |
| `epochStaleTimeout` | 14 days |

Seven fraud-proof functions allow any challenger (posting `challengeBond`) to reject a fraudulent submission and claim the proposer's full bond plus their own challenge bond back:

1. `challengeNodeOverflow` — a node exceeds `NODE_CAPACITY` (>244 seated proofs supplied).
2. `challengeRankingOrder` — an excluded account has strictly higher `votingPower()` than a seated account on the same node.
3. `challengeNotCouncilMember` — a listed account is not actually a Council holder.
4. `challengeDuplicateAccount` — the same account appears at two distinct leaf indices.
5. `challengeLocationMismatch` — a leaf's claimed `(level, branchId)` does not match the account's on-chain revealed ancestor.
6. `challengeCountMismatch` — total leaf count ≠ `councilSBT.getPastTotalSupply(snapshotAt)`.
7. `challengeNodeSeatCountMismatch` — a node's claimed seat count does not match a challenger-supplied, individually verified set of proofs for that node.

Completeness (no account silently omitted) is guaranteed by the *combination* of #3, #4, and #6: if leaf count exactly equals the real total Council supply, every leaf is a distinct real Council member, and none repeats, then no member can be missing — the set is provably exhaustive without a separate non-membership proof (which would require a sorted-tree construction).

## 7. Treasury

### 7.1 Withdrawal limits (general pool)

```
freeBalance(token)   = rawBalance(token) − totalEarmarked[token]
perTxCap             = min(freeBalance × perTxCapBps / BPS_DENOMINATOR, absoluteCapPerTx[token] if set)
rollingCap           = freeBalance × rollingCapBps / BPS_DENOMINATOR
withdraw(amount) requires: amount <= perTxCap AND rollingWindowUsed(token) + amount <= rollingCap
```

| Parameter | Default | Configurable range |
|---|---|---|
| `perTxCapBps` | 1000 (10%) | (0, `rollingCapBps`] |
| `rollingCapBps` | 2500 (25% / `rollingWindow`) | [`perTxCapBps`, 10000] |
| `rollingWindow` | 30 days (mainnet) | (0, `MAX_ROLLING_WINDOW` = 365 days] |
| `recipientCooldown` | 14 days (mainnet) | [0, `MAX_RECIPIENT_COOLDOWN` = 365 days] |

Withdrawals are further restricted to `allowedRecipient[to] == true`, and only usable `recipientCooldown` seconds after that address was allowlisted.

### 7.2 Tax routing (regional distribution)

```
operational  = amount × OPERATIONAL_BPS / BPS_DENOMINATOR      (OPERATIONAL_BPS = 500, 5%, hard-coded, no governance path)
remaining    = amount − operational
activeLevels = rankingEpoch.activeLevelsForAccount(payer)
share        = remaining / activeLevels
dust         = remaining − share × activeLevels                 (rounding remainder, credited to the deepest active level)
```

`operational` credits `operationalBalance[token]`; `remaining` is split into `activeLevels` equal shares, one per level in the payer's active chain (EARTH plus each revealed, overflowed ancestor), with `dust` folded into the deepest share. `hexBalance[token][nodeKey]` accumulates each level's earmarked share; `totalEarmarked` tracks the aggregate across all earmarked buckets, and is subtracted from the raw token balance before computing §7.1's general-pool limits.

`depositTax`/`depositTaxNative` route by `msg.sender`'s own disclosed location; `creditFromTip` (callable only by `TIPJAR_ROLE`) routes by the tipped **author's** location, since the tipper is anonymous by design and the TipJar contract itself has no location.

### 7.3 Per-node withdrawal

Identical `perTxCapBps`/`rollingCapBps`/`absoluteCapPerTx` limit shape as §7.1, but scaled from `hexBalance[token][nodeKey]` instead of the free treasury balance, with an independent per-node recipient allowlist and cooldown. Authorized callers: an explicitly assigned `hexController[nodeKey]`, or `TREASURER_ROLE` (the DAO timelock) as a universal fallback — the latter is gated in practice by `DaoGovernor.proposeScoped()`, which restricts *voting* on a node-spending proposal to that node's own residents.

## 8. Tokenomics interfaces

### 8.1 TipJar split

```
authorAmount = receivedAmount × authorBps(author) / BPS_DENOMINATOR
poolAmount   = receivedAmount − authorAmount
```

`authorBps` defaults to 5000 (50%) uniformly for Council/Shield/no-status tiers, each independently DAO-adjustable within `[MIN_TAX_BPS, MAX_TAX_BPS] = [500, 5000]` bps of *tax* (i.e. author share must remain in `[5000, 9500]` bps). All three accounting points — TipJar's received amount, the author's received amount, and the pool's received amount — are measured via before/after `balanceOf` diffs, not the nominal parameter, making the flow fee-on-transfer-safe end to end.

### 8.2 Influence conversion (`_valueInInfluence`)

```
STABLE:  influence = receivedAmount × influencePerUnit[token] / 1e18
ORACLE:  influence = receivedAmount × price / 10^(priceDecimals + tokenDecimals)
```

`ORACLE` reverts if `price <= 0` or `block.timestamp − updatedAt > maxOracleStaleness` (default 1 hour). Influence is computed on `received` (post fee-on-transfer, pre-split), never on the nominal `amount` parameter passed to `tip()`.

### 8.3 Genesis bootstrap (escrow)

If `Treasury` has not yet been granted `TIPJAR_ROLE` on `InfluenceRegistry`'s counterpart role (typical immediately after genesis, before the first DAO proposal), `TipJar.tip()`'s pool-share transfer to Treasury is attempted via `try/catch`; on failure the pool share is held in `escrowedPool[token]` inside TipJar itself, and the author's share and Influence award proceed unconditionally. `sweepEscrowToTreasury(token)` is permissionless and moves the full accumulated escrow to Treasury in one call once the role exists.

## 9. Deployment configuration (testnet vs. mainnet)

Both environments share identical bytecode; only constructor-supplied values differ:

| Parameter | Testnet default | Mainnet target |
|---|---|---|
| `timelockMinDelay` | 60s (env-overridable) | 72 hours |
| `shieldMinHumanityScore` | 2000 | 2000 (env-overridable) |
| `councilMinHumanityScore` | 5000 | 5000 (env-overridable) |
| `shieldGraceDuration` (test override) | 120s | n/a (real 180/365/730-day schedule applies) |
| `rollingWindow` (Treasury) | 600s | 30 days |
| `recipientCooldown` (Treasury) | 60s | 14 days |
| `votingDelay` | 60s | 2 days |
| `votingPeriod` | 300s | 7 days |
| `testMode` (ShieldSBT) | `true` | `true` — must be explicitly `false` |

`evm_version = cancun` (Arbitrum One/Sepolia support Cancun opcodes since the ArbOS 20 "Atlas" upgrade, March 2024). `@openzeppelin/contracts` pinned to `v5.7.0`, `forge-std` to `v1.16.2`.
