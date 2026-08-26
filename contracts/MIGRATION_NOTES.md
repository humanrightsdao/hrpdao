# Lens → Arbitrum Migration: What Has Changed in This Repository Snapshot

See the full analytical plan: `HR_DAO_Migration_Lens_to_Arbitrum.md` (provided separately in the chat).
This file is a short changelog specifically for the changes made to code/config.

## Updated

- **`foundry.toml`**
  - `evm_version`: `paris` → `cancun` (Arbitrum One/Sepolia support Cancun opcodes since the ArbOS 20 "Atlas" upgrade, March 2024).
  - Removed the `lens_testnet` RPC endpoint, added `arbitrum_sepolia` (chain id 421614) and `arbitrum_one` (chain id 42161).
  - Added `[etherscan]` config for verification via Arbiscan API.
- **`foundry.lock`** — `@openzeppelin/contracts` pinned `v5.1.0` → `v5.7.0` (latest stable release at the time of migration; compatible with Cancun, no need for MCOPY workarounds). `forge-std` remains `v1.16.2` (same reference — the version was already suitable).
- **`lib/openzeppelin-contracts`, `lib/forge-std`** — reinstalled to the pinned tags above (instead of empty git submodule stubs in the original archive).
- **`lib/README.md`** — installation instructions updated for new versions/networks.
- **`script/Deploy.s.sol`** — updated docblock: run instructions now target `arbitrum_sepolia`/`arbitrum_one`, added reminders about `PASSPORT_DECODER` (Human Passport on Arbitrum One) and that `GUARDIAN_MULTISIG` needs to be deployed on Arbitrum, not migrated from Lens.
- **`script/DeployOptEpoch.s.sol`** — same `--rpc-url` update.

## Removed (no longer relevant for Arbitrum)

- **`src/GenesisDeployerStage1.sol` … `Stage5.sol`** — an alternative 5-stage **on-chain** deployer. It was never imported or used by either `script/Deploy.s.sol` or tests — it existed as a workaround for bytecode/init-code size limits specific to the Lens configuration (`paris` without Cancun MCOPY optimizations). The working deployment path (`script/Deploy.s.sol`, each contract as a separate fork-script transaction) no longer requires staging on any standard EVM network, including Arbitrum. **If you have a separate reason to keep an on-chain staged deployment (e.g., a requirement for deterministic/verifiable on-chain deployment without trusting a specific EOA script) — let me know, and I'll restore these files and adapt them for Arbitrum instead of deleting them.**
- **`hr_dao_contracts_v4.zip`** — was a duplicate of the same `src/`/`script/`/`test/` files, packed inside the repository. Removed as an unnecessary artifact.
- **`out/`, `cache/`** — outdated compilation artifacts from the old `evm_version`/OZ; they will be regenerated automatically upon `forge build`.
- **`broadcast/*/37111/...`** — deployment logs specifically on Lens Testnet (chain id 37111). Removed as historical records of the network the DAO is leaving; local Anvil logs (`broadcast/*/31337/...`) are left unchanged.
- **`.git/`, `.gitmodules`** — removed from this snapshot, because after replacing the contents of `lib/` they would point to an inconsistent state (old submodule references to Lens configuration). Initialize a new git repository on your side (`git init && git add -A && git commit`).

## Not changed (intentionally)

- All business logic of the contracts (`Treasury`, `DaoGovernor`, `RightsRegistry`, `CouncilRankingEpoch`, `OptimisticEpochSubmission`, SBT contracts, etc.) — **without any modifications**. Verified by full compilation (`solc` 0.8.24, `viaIR`, `cancun`, OZ v5.7.0) — compiles cleanly, without errors.
- References to `keccak256(lensPostId)` in `DisciplineModule.sol`/`RightsRegistry.sol`/`TipJar.sol` — these are off-chain hash pointers to evidence (posts), not calls to the Lens protocol. This is an organizational decision (where the DAO documents violations), not a technical dependency on the Lens network — therefore left as is. Let me know if you want to change the source of evidence.
- `MockHumanityProvider.sol`, `MockERC20.sol` — test contracts, still needed for deployment/tests on Arbitrum Sepolia.

## What you will still need to fill in yourself before deployment

These are not technical code fixes, but specific addresses/decisions that I cannot fill in for you (they are not auto-generated, and hardcoding "from memory" is risky):

1. The actual address of the **Human Passport Decoder** on Arbitrum One (verify via `docs.passport.xyz` or Arbiscan directly before mainnet deployment).
2. The actual **ERC-20** address for `TipJar.acceptedToken` on Arbitrum (e.g., native USDC — get the address from an official source, not from memory).
3. The address of the **guardian multisig** (Safe), deployed on Arbitrum.
4. Verification (not performed by me — requires `forge test` with a real Foundry toolchain, not available in this environment): full run of `test/FullCycle.t.sol` under the new `evm_version`/OZ. Compilation passed cleanly, but tests with `forge-std` cheatcodes (`vm.warp`, etc.) should be run locally/in CI before fully trusting them.