# HR DAO — Docs

*A knowledge base for developers and members: how to use each part of the protocol. Exact formulas and thresholds are documented once, in the Yellow Paper — this document links to them rather than repeating them. Wire-level data formats (event schemas, EIP-712 types, Merkle leaf encoding) live in the Spec.*

## Contents

1. [Contract map](#1-contract-map)
2. [Becoming a member: Shield and Council](#2-becoming-a-member-shield-and-council)
3. [Verification guide: proof of humanity](#3-verification-guide-proof-of-humanity)
4. [Human Rights Policy consent](#4-human-rights-policy-consent)
5. [Tipping and earning Influence](#5-tipping-and-earning-influence)
6. [Governance guide: DaoGovernor](#6-governance-guide-daogovernor)
7. [Discipline guide: proposing and judging sanctions](#7-discipline-guide-proposing-and-judging-sanctions)
8. [Location disclosure (zero-knowledge)](#8-location-disclosure-zero-knowledge)
9. [Treasury: depositing and withdrawing](#9-treasury-depositing-and-withdrawing)
10. [Roles and deployment wiring](#10-roles-and-deployment-wiring)
11. [Node operator guide: epoch submission](#11-node-operator-guide-epoch-submission)

---

## 1. Contract map

| Contract | Purpose |
|---|---|
| `HumanityGate` | DAO-governed registry of proof-of-personhood providers |
| `PassportAdapter` / `WorldIDAdapter` | Provider-specific adapters implementing `IHumanityVerifier` |
| `PolicyConsentGate` | Reusable base: content-hash-pinned policy acceptance (EIP-712) |
| `ShieldSBT` | Base membership status (ERC-5192 soulbound) |
| `CouncilSBT` | Senior membership status (ERC-5192 soulbound) |
| `InfluenceRegistry` | Reputation accrual, decay, voting weight |
| `DaoGovernor` / `DaoVotesAdapter` | Proposals and voting |
| `DaoTimelock` | Timelocked execution of passed proposals |
| `DisciplineModule` | Two-chamber sanction process |
| `LocationRegistry` | Zero-knowledge location commitment and disclosure |
| `HexAncestryVerifier` (`Groth16Verifier`) / `MockHexAncestryVerifier` | ZK proof verifier (production / test) |
| `CouncilRankingEpoch` | Regional seat ranking, epoch state |
| `OptimisticEpochSubmission` | Permissionless, bonded alternative epoch submitter |
| `SeatMerkleLib` | Shared Merkle leaf/tree formula |
| `TipJar` | Tipping, splits, Influence issuance |
| `Treasury` | Fund custody, withdrawal limits, regional tax routing |
| `MockERC20`, `MockFeeOnTransferERC20`, `MockHumanityProvider`, `MockPriceFeed`, `MockHexAncestryVerifier` | Test-only fixtures |

## 2. Becoming a member: Shield and Council

**To mint Shield:**

1. Accumulate 200+ Influence (see §5) and pass a humanity check via any active `HumanityGate` provider at the Shield threshold.
2. Accept the current Human Rights Policy (see §4) — either as a separate transaction (`acceptPolicy`) or bundled with the mint itself.
3. Call `ShieldSBT.mint()` (two-step: `acceptPolicy()` then `mint()`) or `ShieldSBT.mintWithPolicyConsent(policyHash, deadline, signature)` (one transaction, using an EIP-712 signature obtained from your wallet).

**To mint Council**, once you already hold Shield:

1. Accumulate 500+ Influence and pass the (higher) Council humanity threshold.
2. Have held Shield for at least your locked-in `requiredCouncilDuration` — check `ShieldSBT.requiredCouncilDuration(yourAddress)` and `ShieldSBT.memberSince(yourAddress)` to see how long you have left.
3. Call `CouncilSBT.mint()`.

Both tokens are permanently non-transferable (ERC-5192 `locked() == true` always) — one per address, burned only through the discipline process (§7).

For the exact numeric thresholds and grace-period schedule, see Yellow Paper §2.

## 3. Verification guide: proof of humanity

HR DAO does not run its own identity check — it delegates to one or more external proof-of-personhood providers, registered in `HumanityGate`.

**Step by step:**

1. Check which providers are currently active: `HumanityGate.getActiveProviders()`.
2. Complete verification with your chosen provider through their own app/site (e.g. Human Passport at `passport.xyz`). This happens off-chain, entirely outside HR DAO's contracts.
3. Once verified, your on-chain score becomes readable through the provider's adapter contract — check it any time via `ShieldSBT.previewHumanityScore(yourAddress)` or `CouncilSBT.previewHumanityScore(yourAddress)` (both proxy to `HumanityGate.bestScore`), without spending gas.
4. If your score meets the relevant threshold, `mint()` (§2) will succeed; `HumanityGate.verifyHuman()` is called automatically inside the mint flow and reverts with `"HumanityGate: score below threshold"` if not.

**Aggregation modes** (set by DAO governance, `HumanityGate.mode()`):

- `ANY_ONE` — pass any single active provider.
- `ALL_REQUIRED` — must pass every currently active provider.
- `THRESHOLD_SCORE` — the *average* score across active providers must clear the threshold.

**If your verification later needs refreshing** (a provider you used was removed, or the aggregation mode changed since you last verified): `HumanityGate.needsReverification(yourAddress)` tells you whether your on-chain record is stale relative to the current configuration. This is informational only — nothing is automatically revoked; it is up to the consuming contract (or a future maintenance action) to decide what to do about it.

**Adding a new provider** (e.g. World ID) requires: deploying an adapter contract implementing `IHumanityVerifier` (score scaled 0–10,000, ×100 of a 0–100 score; binary providers map verified→10,000, not-verified→0), then a DAO vote calling `HumanityGate.addProvider(adapterAddress)`.

## 4. Human Rights Policy consent

The policy text itself lives off-chain (IPFS or a decentralized domain); the contract only pins its `keccak256` hash and a retrieval URI.

**To accept the current policy:**

- **Two-transaction flow:** fetch the current hash from `currentPolicyHash`, review the document at `policyURI`, then call `acceptPolicy(currentPolicyHash)`.
- **One-transaction flow (e.g. bundled with mint):** sign an EIP-712 `PolicyConsent` message in your wallet (see Spec §2 for the exact typed-data schema) and pass the signature to `mintWithPolicyConsent()` or `acceptPolicyFor()`.

**After a policy update:** existing members have `reacceptGracePeriod` (30 days by default) to re-accept before `isCompliant()` starts returning `false` for them — which blocks voting, proposing, and discipline actions until they re-accept. Nothing about their existing Shield/Council token is affected; only *new* gated actions require compliance. Check `reconsentTimeLeft(yourAddress)` to see your remaining grace window.

## 5. Tipping and earning Influence

**To tip an author:**

```
TipJar.tip(author, token, amount, postRef)
```

- `token` must be an accepted currency (`TipJar.acceptedTokens(token) == true`) — a registered stablecoin or oracle-priced asset.
- `amount` must meet `TipJar.minTipAmount(token)`.
- `postRef` is `keccak256(lensPostId)` — an off-chain evidence pointer to the specific post/contribution being tipped; it does not call out to any external protocol, it is simply a hash the indexer can match against.
- Preview the split and expected Influence before sending: `previewSplit(author)` and `previewInfluence(token, amount)`.

The tip splits between the author and the DAO's shared Support Pool (Treasury) per the current author-share bps for the author's tier (Council/Shield/no-status) — see Yellow Paper §8.1 for exact defaults and bounds. Influence is credited to the author automatically, at the network's current $→Influence rate (Yellow Paper §3.1, §3.4).

**Adding a new tippable currency** is a DAO decision: `setStablecoin()` for a $-pegged asset with a manual rate, or `setOraclePricedToken()` for anything priced via a Chainlink-compatible feed.

## 6. Governance guide: DaoGovernor

**To propose** (Council members only):

```
DaoGovernor.propose(targets, values, calldatas, description)
```

or, for a region-scoped proposal:

```
DaoGovernor.proposeScoped(targets, values, calldatas, description, level, branchId, seatLevel, seatBranchId, seatIndex, seatProof)
```

`level`/`branchId` identify the target region (see §8 for how regions are determined); `seatLevel`/`seatBranchId`/`seatIndex`/`seatProof` prove your own standing in the ranking, required only once the relevant region has become competitive (see Yellow Paper §4.4). Use `LEVEL_EARTH`/`EARTH_BRANCH` (via `rankingEpoch.LEVEL_EARTH()`/`rankingEpoch.EARTH_BRANCH()`) for an unscoped, DAO-wide proposal.

**To vote:** standard OpenZeppelin `Governor.castVote(proposalId, support)` (0 = Against, 1 = For, 2 = Abstain), available to Shield and Council members whose weight and eligibility are non-zero at the proposal's snapshot (Yellow Paper §4.2). Voting on a scoped proposal from outside its territory reverts explicitly, rather than silently counting as zero weight.

**Lifecycle:** `Pending → Active → (Defeated | Succeeded) → Queued (via DaoTimelock) → Executed`, standard OpenZeppelin Governor state machine, with quorum computed per Yellow Paper §4.1/§4.5. Once queued, execution is possible only after `DaoTimelock`'s minimum delay elapses (2 days on testnet, 72+ hours recommended on mainnet) — anyone may call `execute()` once eligible.

**Governor specification summary:** single unified Governor for all proposal types (no separate policy track); Council-gated proposing; Shield+Council equal-formula voting; snapshot-based eligibility and weight; active-supply-based quorum; optional geographic scoping with its own quorum floor/percentage; standard OpenZeppelin timelock-controlled execution. Full formulas: Yellow Paper §4.

## 7. Discipline guide: proposing and judging sanctions

**To propose a sanction** (any Shield or Council member, in policy compliance):

```
DisciplineModule.proposeSanction(target, violationPostRef, sanctionType, restrictionPeriod)
```

- `violationPostRef` — mandatory evidence pointer (`keccak256(lensPostId)`), must not already be locked by a prior *executed* sanction, and if a prior *cancelled* attempt exists for it, `REPROPOSAL_COOLDOWN` (14 days) must have elapsed.
- `sanctionType` — `Warning`, `PartialRestriction`, or `FullSlash`. Choose the type you are proposing; voting is not a multi-choice ballot across severities.
- `restrictionPeriod` — only meaningful for `PartialRestriction`: `Quarter`, `Year`, or `FiveYears`.

**To vote as Shield** (must have been a member before the proposal was created):

```
DisciplineModule.voteShield(id, choice)   // choice: For / Against / Abstain
```

Voting closes after 7 days; anyone can then call `finalizeShieldVote(id)` to tally the result against the severity-tiered participation and approval thresholds (Yellow Paper §5.3).

**To veto as Council** (must have been a Council member before the veto window opened), during the 10-day window after a Shield vote passes:

```
DisciplineModule.vetoSanction(id)
```

If vetoes exceed the qualified threshold (Yellow Paper §5.3), the sanction is cancelled. If the window closes without enough vetoes, anyone can call `execute(id)` to apply it.

**What each sanction does on execution:**

- `Warning` — increments `blackMarks[target]`, a visible, permanent on-chain record; no loss of tokens or voting power.
- `PartialRestriction` — sets `restrictedUntil[target]`; while active, `DaoGovernor` treats the account's voting weight as zero (it can still hold Shield/Council, just cannot vote).
- `FullSlash` — burns the target's Shield and/or Council SBT(s) outright (`burnByDiscipline`), whichever they currently hold. Permanent; this is the only sanction with a "forever" consequence.

Note what this module deliberately does **not** decide: what conduct counts as a violation is a policy/procedural question, resolved off-chain (see §4) — the contract only executes the voting and enforcement procedure once a violation is alleged and evidenced.

Full participation/approval formulas and constants: Yellow Paper §5.

## 8. Location disclosure (zero-knowledge)

Disclosing your region is entirely optional and gives you access to regionally-scoped voting and treasury participation (§9). Nothing about base membership requires it.

**Step by step (see also `zk/frontend-example/locationFlow.js` for a working reference implementation):**

1. **Locally**, in your browser/wallet — never submitted to any server — compute your precise H3 index (recommended library: `h3-js`) from your coordinates.
2. Generate a random `salt`, and compute `commitment = Poseidon(hexId, salt)` (recommended library: `circomlibjs`).
3. **Save `hexId` and `salt` locally** (e.g. in your wallet's own storage) — you will need them for every future disclosure. If lost, you must re-declare from scratch (subject to the 1-hour `CHANGE_COOLDOWN`).
4. Submit only the commitment on-chain: `LocationRegistry.setLocationCommitment(commitment)`.
5. When (and only when) you want a specific ancestor level to become visible to governance/treasury routing, generate a zero-knowledge proof locally (`snarkjs.groth16.fullProve()`, using the published `HexAncestry.wasm`/`HexAncestry_final.zkey`) and call `LocationRegistry.revealAncestor(level, branchId, proof)`.

You control exactly how much precision to reveal — typically only up to whatever resolution is currently "active" for your region (see below); revealing deeper than that changes nothing until your region's ranking catches up, and reveals more precision than necessary.

**How regions activate:** every roughly-quarterly epoch, an authorized submitter reports which hexagons have reached 244 Council members (`CouncilRankingEpoch.nodeOverflowed`). A region only becomes eligible for its own scoped proposals and its own treasury bucket once it is marked overflowed at that level. `CouncilRankingEpoch.effectiveHexFor(yourAddress)` tells you your current effective (most-specific-available) region.

Full circuit specification and trust assumptions: Yellow Paper §6.3; wire-level public/private signal layout: Spec §4.

## 9. Treasury: depositing and withdrawing

**Depositing:**

- General funds (no regional routing): `Treasury.depositERC20(token, amount)`, or send ETH directly to the contract.
- Regionally-routed "tax" deposits: `Treasury.depositTax(token, amount)` or `depositTaxNative()` — 5% goes to the DAO's operational balance, the remainder splits automatically across your own active regional layers (§8). If you haven't disclosed a location, 100% of the remainder falls back to the global (EARTH) bucket.

**Withdrawing** always goes through a DAO-passed, timelock-executed proposal calling one of:

- `withdraw(token, to, amount)` — from the general (non-earmarked) balance.
- `withdrawFromHex(level, branchId, token, to, amount)` — from a specific region's earmarked balance; callable by that region's assigned controller, or by the DAO timelock directly (in practice reached via a region-scoped proposal that only that region's residents could vote on).
- `withdrawOperational(token, to, amount)` — from the 5% operational bucket.

Every path enforces the same shape of independent limits (per-transaction cap, rolling-window cap, absolute cap, recipient allowlist + cooldown) — see Yellow Paper §7.1/§7.3 for exact formulas. `availableToWithdraw(token)` / `hexAvailableToWithdraw(token, level, branchId)` let you preview the current ceiling before submitting a proposal.

**In an emergency:** any `GUARDIAN_ROLE` address can call `guardianPause()` to instantly freeze all withdrawals (deposits still work). Only a normal DAO vote (through the timelock) can `unpause()` — the guardian cannot lift its own freeze, and cannot move funds under any circumstance.

## 10. Roles and deployment wiring

All DAO-facing roles are ultimately controlled by `DaoTimelock`, itself only executable by passed `DaoGovernor` proposals. No `DEFAULT_ADMIN_ROLE` is granted to anyone post-deployment; each contract's admin role is configured to be self-administering.

**`HumanityGate` deployment order matters** — later steps reference addresses from earlier ones:

1. Deploy `HumanityGate(governor = DaoTimelock)`.
2. Deploy `PassportAdapter(existingPassportDecoderAddress)`.
3. `humanityGate.addProvider(address(passportAdapter))` — governor call.
4. Deploy `ShieldSBT(..., humanityGate: address(humanityGate), ...)`.
5. Deploy `CouncilSBT(..., humanityGate: address(humanityGate), ...)` — **must** reuse the exact same `humanityGate` address as step 4, or Shield/Council thresholds and providers silently diverge.
6. `humanityGate.setAuthorizedCaller(address(shieldSBT), true)` — governor call.
7. `humanityGate.setAuthorizedCaller(address(councilSBT), true)` — governor call.

Skipping steps 6–7 causes every `mint()` call on both SBTs to revert with `"HumanityGate: caller not authorized"` — a common deployment mistake, called out here explicitly.

**Key role map:**

| Role | Granted to | Governs |
|---|---|---|
| `DAO_ROLE` (per-contract) | `DaoTimelock` | Parameter changes, module wiring |
| `DISCIPLINE_ROLE` | `DisciplineModule` | `burnByDiscipline()` on Shield/Council |
| `ACTIVITY_ROLE` | `DaoGovernor`, `DisciplineModule` | `touchActivity()` on `InfluenceRegistry` |
| `TIPJAR_ROLE` (InfluenceRegistry) | `TipJar` | `award()` |
| `TIPJAR_ROLE` (Treasury) | `TipJar` | `creditFromTip()` |
| `TREASURER_ROLE` | `DaoTimelock` | Treasury withdrawals and limit changes |
| `GUARDIAN_ROLE` | Independent multisig | Emergency pause only |
| `EPOCH_SUBMITTER_ROLE` | Multisig/relayer, or `OptimisticEpochSubmission` | Regional ranking epoch data |
| `POLICY_ADMIN_ROLE` | `DaoTimelock` | Human Rights Policy updates |

## 11. Node operator guide: epoch submission

Someone must periodically compute, off-chain, which regions have reached capacity and which accounts hold seats, then submit the result on-chain. Two paths exist:

**Trusted submitter** (`EPOCH_SUBMITTER_ROLE`, typically a DAO-controlled multisig):

1. `CouncilRankingEpoch.beginNewEpoch()` — no more often than `minEpochDuration` (90 days) since the last epoch start.
2. `submitSeatAssignments(accounts, hasSeatFlags, levels, branchIds)` — the full candidate set for this epoch, passed as calldata; the contract builds and stores only the Merkle root.
3. `submitNodeStatus(levels, branchIds, seatCounts, overflowedFlags)` — per-node population and overflow flags (a much smaller array — one entry per *active node*, not per candidate).

**Permissionless submitter** (`OptimisticEpochSubmission`, bond + challenge window): post `requiredBond`, call `submitEpochResult(...)` with the same data shape; if unchallenged for `challengePeriod` (3 days), anyone can call `finalizeEpoch()`, which forwards the result into `CouncilRankingEpoch` and returns the bond. See §6.6 of the Yellow Paper for the full fraud-proof catalog available to challengers, and the emergency `forceOpenEpoch()` fallback if no one submits before `epochStaleTimeout`.
