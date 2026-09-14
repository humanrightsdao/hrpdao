# HR DAO — Litepaper

*A condensed introduction to the Human Rights DAO. For technical depth, see the Yellow Paper; for a broader narrative, see the Whitepaper; for integration details, see the Docs.*

## What is HR DAO

HR DAO is an on-chain organization that documents and rewards contribution to human-rights work, and governs itself entirely through smart contracts on Arbitrum. There is no company, no board, and no off-chain admin key: every parameter — from voting thresholds to treasury limits — is either a fixed, audited constant or something only the DAO's own governance process can change.

Membership is proof-of-personhood gated (one human, one seat) and reputation-weighted: the more verified value a member has contributed, the more their vote counts — but never in direct proportion, so large contributors cannot buy outsized control.

## Membership: Shield and Council

There are two on-chain statuses, both non-transferable (soulbound) tokens:

- **Shield** — the base level of participation. Minted once an account has accumulated 200+ Influence points (see below) and has passed a proof-of-humanity check.
- **Council** — the senior level. Requires 500+ Influence, a minimum tenure as a Shield holder (2 years standard, shortened to 6 or 12 months during the DAO's first two years to bootstrap participation), and a higher humanity score. Only Council members may submit governance proposals; both Shield and Council vote with equal rules.

Both statuses require accepting the DAO's Human Rights Policy (an off-chain document, content-hash-pinned on-chain) and re-accepting it whenever the DAO updates it.

## Influence: reputation, not currency

Influence points are earned when a member receives a tip (donation) for their work through the built-in TipJar, at a base rate of $1 = 1 Influence. Two anti-plutocracy mechanisms keep this reputation from turning into raw financial power:

1. **Voting weight is the fourth root of Influence.** 10,000× more Influence only buys about 10× more voting weight.
2. **Influence decays 10% per year (compounded)** if a member stops being active — donating, voting, or proposing resets the clock.

As the Council grows past 244 members, the $-to-Influence exchange rate is halved DAO-wide, making later entry proportionally "more expensive" — the same mechanic for everyone, with no per-region distinction.

## Governance

A single unified Governor contract handles all proposals — there is no separate "policy track": updating the Human Rights Policy goes through the same vote as any other decision. Council members propose; both Shield and Council vote, weighted by their (snapshotted) Influence. Passed proposals queue in a timelock (72+ hours on mainnet) before execution, giving the community time to react to anything malicious.

Proposals can also be **geographically scoped** — bound to a specific region — so that only members who have opted into that territory can vote on, say, spending that region's share of treasury inflows. Participation in this system is opt-in and privacy-preserving (see below).

## Discipline

Violations of the Human Rights Policy are handled by a two-chamber process, separate from ordinary governance:

1. Any Shield member proposes a sanction against a violator, citing evidence.
2. Shield members vote for seven days (one member, one vote — not Influence-weighted, since this is a judicial, not a resource-allocation, decision).
3. If it passes, a 10-day Council veto window opens; a Council majority can strike the sanction down.
4. If not vetoed, the sanction executes automatically — a warning, a temporary voting restriction, or a permanent loss of Shield/Council status, depending on severity.

Thresholds scale with severity: the harsher the consequence, the wider the required support.

## Geography, privately

Members can optionally reveal which region they belong to, at whichever resolution they choose (down to city-block level), using a zero-knowledge proof — the raw location never touches the chain, only the specific ancestor level a member decides to disclose. This powers two things:

- **Regional voting** on locally-scoped proposals.
- **Regional treasury routing** — 95% of every tax deposit and tip is automatically split across a payer's active regional layers, so local communities accumulate their own spendable balance, controlled by whoever wins a locally-scoped governance vote (or a delegated regional controller).

## Treasury

All DAO funds live in one Treasury contract with five independent layers of protection: a hard per-transaction cap, a rolling 30-day cap, a $ ceiling per token, a withdrawal allowlist with a cooldown before new addresses become active, and an independent guardian multisig that can freeze withdrawals instantly (but cannot move funds or unpause itself). Even a fully compromised Governor cannot drain the treasury in one shot.

## Network stages

HR DAO launches with a straightforward $1 = 1 Influence exchange rate. Once the Council reaches 244 members, the rate halves — the DAO's built-in signal that participation has matured past its bootstrap phase.

## Status

The contracts in this snapshot target Arbitrum (Sepolia for testing, Arbitrum One for production) and are feature-complete pending a production zero-knowledge trusted setup and final constant review before mainnet deployment. Testnet and mainnet share identical logic — only timing and threshold constants differ.
