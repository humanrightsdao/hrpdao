# HR DAO — Whitepaper

*The project's core document, for a broad audience — members, donors, and partners. For rigorous formulas and thresholds, see the Yellow Paper. For step-by-step usage and integration, see the Docs.*

## 1. Vision

HR DAO exists to fund, coordinate, and govern human-rights work through a transparent, member-owned organization, without relying on a company, a foundation board, or any off-chain authority that can be pressured, captured, or quietly changed. Every rule that matters — who can vote, how much their vote counts, how funds move, how misconduct is judged — is enforced by smart contracts that only the DAO's own membership can amend, through its own governance process.

## 2. The problem

Traditional human-rights organizations face two structural weaknesses: a small set of people (executives, boards, major donors) can end up disproportionately controlling decisions, and funding flows are often opaque or slow to reach the people actually doing the work. Token-based DAOs have their own failure mode — plutocracy, where the largest holder simply buys the outcome.

HR DAO's answer is a *reputation* system, not a *currency* system: contribution is measured in a non-transferable, decaying reputation score, and voting weight grows far slower than reputation itself, so no single contributor — however generous — can dominate governance.

## 3. Architecture overview

The protocol is composed of a set of independent smart contracts, each responsible for one concern, wired together through role-based access control. At a high level:

| Layer | Contracts | Responsibility |
|---|---|---|
| Identity & humanity | `HumanityGate`, `PassportAdapter` (+ future provider adapters) | Proof-of-personhood, provider-agnostic |
| Membership | `ShieldSBT`, `CouncilSBT`, `PolicyConsentGate` | Non-transferable status tokens; policy acceptance |
| Reputation | `InfluenceRegistry` | Reputation accrual, decay, voting-weight formula |
| Governance | `DaoGovernor`, `DaoTimelock` | Proposals, voting, timelocked execution |
| Discipline | `DisciplineModule` | Sanctions for policy violations |
| Geography | `LocationRegistry`, `HexAncestryVerifier`, `CouncilRankingEpoch`, `OptimisticEpochSubmission` | Private location disclosure, regional ranking, epoch data |
| Funding | `TipJar`, `Treasury` | Tipping, reputation issuance, treasury custody and limits |

No single contract can unilaterally move funds, mint status, or change a threshold — each capability is gated to a specific role, and every DAO-controlled role ultimately traces back to `DaoTimelock`, which only executes what `DaoGovernor` and a passed vote authorize.

## 4. Membership and identity

### 4.1 Proof of personhood

`HumanityGate` is a DAO-governed registry of proof-of-personhood providers (initially Human Passport, with World ID and others addable by vote, without redeploying any other contract). It supports three aggregation modes — accept any one active provider, require all of them, or average their scores against a threshold — so the DAO can tighten or loosen its humanity bar over time without disrupting the rest of the system.

### 4.2 Shield and Council status

Both are ERC-5192 soulbound (permanently non-transferable) tokens, one per address:

- **Shield** requires 200+ Influence and a passing humanity score. It is the base credential for participating in governance.
- **Council** requires 500+ Influence, a passing (higher) humanity score, and a minimum tenure holding Shield — fixed for each member the moment they first mint Shield, based on the project's age at that time: 6 months in year one, 12 months in year two, 24 months (the permanent standard) afterward. This lets the DAO bootstrap an initial Council quickly without permanently lowering the bar.

Only Council members can submit governance proposals. Both statuses vote identically, weighted by the same Influence-derived formula — Council does not carry extra voting power, it carries eligibility to propose and to sit on the Council veto in discipline cases.

### 4.3 Policy consent

Membership requires accepting the DAO's Human Rights Policy — a living document whose *content*, not its URL, is pinned on-chain as a hash. When the policy changes, existing members have a grace period (30 days by default) to re-accept before losing eligibility to vote or propose; nothing is revoked retroactively, and re-acceptance is entirely self-service, with no vote or intervention required.

## 5. Influence: the reputation layer

Influence is earned automatically when a member's contribution receives a tip (see §7), denominated in a $-equivalent value, at a rate the DAO calibrates by network stage. It is **not** a transferable token, cannot be bought directly, and decays — 10% per year, compounded — if the holder stops engaging with the DAO in any way (tipping, voting, proposing).

Voting weight is the fourth root of (decayed) Influence. This means a member with 10,000× the Influence of another has only about 10× the voting weight — a deliberate, steep anti-plutocracy curve. All quorum and vote-weight calculations use a *snapshot* of Influence taken at the moment a proposal starts, so no one can rush in new donations mid-vote to inflate their weight on a specific outcome.

## 6. Governance

A single Governor contract (`DaoGovernor`) handles every kind of decision — treasury spending, parameter changes, policy updates, adding a new humanity provider, everything. There is no separate policy-only track: changing the Human Rights Policy is a normal proposal, subject to the normal quorum and approval rules.

- **Who can propose:** Council members only.
- **Who can vote:** Shield and Council members, weighted equally by the same Influence-derived formula, provided they are in policy compliance and not under an active discipline restriction.
- **Quorum:** a percentage of *active* Shield supply (members who have engaged with the DAO within a rolling window) — not total supply — so that years of dormant accounts cannot make quorum permanently unreachable.
- **Execution:** every passed proposal queues in `DaoTimelock` for a minimum delay (72+ hours recommended on mainnet) before it can execute, giving the community a window to notice and respond to anything malicious, even if the vote itself were somehow compromised.

Proposals can additionally be scoped to a specific geographic region (see §8), restricting who may vote on them to residents of that region, with its own quorum calibrated to that region's population.

## 7. Funding: TipJar and reputation issuance

`TipJar` lets anyone tip an author's contribution in an accepted ERC-20 token (stablecoins by default; other assets can be added via a Chainlink-compatible price oracle). Each tip splits between the author and a shared Support Pool — 50/50 by default, adjustable by governance within a 50–95% author-share band. The full tip amount (before the split) determines how much Influence the author earns, at the network's current exchange rate.

The system is designed to be fee-on-transfer-safe: it measures what actually arrives at each step, rather than trusting the nominal amount, so deflationary or rebasing tokens cannot desynchronize accounting.

## 8. Geography: regional participation without surveillance

Members may optionally disclose which geographic region (H3 hexagonal cell, at a resolution they choose) they belong to, using a zero-knowledge proof: the raw location commitment goes on-chain, but the actual coordinates never do. A member reveals exactly the ancestor level they need — city, district, country, or nothing at all — and no more.

This unlocks two features, both entirely opt-in:

- **Locally-scoped governance proposals**, votable only by residents of the relevant region.
- **Regional treasury routing** — a portion of every tax deposit and community tip is automatically split across the active regional layers a payer belongs to, giving local communities their own accumulating balance that only their own regional vote (or a DAO-delegated regional controller) can spend.

Regions "activate" through a periodic (roughly quarterly) ranking epoch: once a region's Council population exceeds a 244-member capacity, the next-finer resolution opens up beneath it. This keeps the system's granularity proportional to actual, real participation rather than an arbitrary map.

## 9. Discipline and enforcement

Policy violations are handled by a purpose-built, two-chamber process, kept structurally separate from ordinary treasury/parameter governance:

1. Any Shield member proposes a sanction, with mandatory evidence and an explicit severity (a warning, a temporary voting restriction, or permanent loss of status).
2. Shield members vote for a fixed period, one member = one vote (not Influence-weighted — this is a judicial function, and weighting it by reputation would let the wealthiest reputation-holders control who gets sanctioned).
3. If the vote passes both a participation and an approval threshold (both scaling with severity), a Council veto window opens.
4. A Council supermajority can strike the sanction; silence lets it execute automatically once the window closes.

This design deliberately avoids letting a small, well-resourced minority either weaponize sanctions against critics or shield bad actors from consequences.

## 10. Treasury security

All DAO funds are held in a single `Treasury` contract, whose withdrawal limits apply independently of what the Governor "approved" — so even a compromised Governor cannot empty the treasury in one transaction. Protections stack: a per-transaction percentage cap, a rolling 30-day percentage cap, an absolute dollar ceiling, a recipient allowlist with a cooldown before new addresses become spendable, and an independent guardian multisig that can freeze withdrawals instantly but can neither move funds nor lift its own freeze.

## 11. Roadmap and network maturity

The protocol advances through Council-size-triggered "network stages" rather than a fixed calendar: at launch, $1 buys 1 Influence point; once the Council reaches 244 members, the rate halves DAO-wide, signaling the organization has matured past its bootstrap phase. Later stages (further rate reductions as regional layers fill) are an open design question the DAO can resolve by vote once the relevant data becomes meaningful — no arbitrary numbers have been hard-coded ahead of time.

Contracts were originally scoped for the Lens Testnet and have since been migrated to Arbitrum (Sepolia for testing, Arbitrum One for production); business logic is unchanged by that migration.

## 12. Status and disclaimers

This document describes a **test/staging deployment configuration**. The core parameters described here — membership thresholds, voting formulas, discipline tiers, treasury limits — are the same ones intended for production; only network-specific timing constants (timelock delay, voting period, grace periods) differ between testnet and mainnet, by design, so both share identical audited bytecode. Before any mainnet deployment, the project requires a production-grade zero-knowledge trusted setup (or a migration to a setup-free proof system) and a final community review of every DAO-configurable constant. Nothing in this document is financial advice, and Influence points have no guaranteed monetary value.
