# HR DAO — Spec / Technical Specifications

*Formal specifications of specific network standards and data formats — for indexers, wallets, and integrators. Protocol math and thresholds live in the Yellow Paper; usage guides live in the Docs.*

## 1. Soulbound token compliance (ERC-5192)

`ShieldSBT` and `CouncilSBT` are ERC-721 tokens that additionally implement ERC-5192 ("Minimal Soulbound NFTs"):

```solidity
function locked(uint256 tokenId) external view returns (bool);   // always returns true
event Locked(uint256 tokenId);                                    // emitted once, at mint
```

Interface ID: `0xb45a3c0e`, reported via `supportsInterface()`. Both contracts revert on any `_update()` call where `from != address(0) && to != address(0)` — i.e. transfers between two live addresses are unconditionally blocked; only minting (`from == 0`) and the discipline-triggered burn (`to == 0`) are permitted.

## 2. EIP-712 typed data: policy consent

Domain (per `PolicyConsentGate`, distinct per deploying contract — `ShieldSBT` and `LocationRegistry` each instantiate their own domain):

```
name:    "HR DAO Policy Consent"
version: "1"
chainId: <deployment chain id>
verifyingContract: <the specific contract address, e.g. ShieldSBT or LocationRegistry>
```

Typed struct:

```
PolicyConsent(address account, bytes32 policyHash, uint256 nonce, uint256 deadline)
```

`nonce` is read from `consentNonce(account)` *before* signing, and increments by exactly 1 on each successful signature-based consent (`_consentBySignature`). `policyHash` must equal `currentPolicyHash` at execution time, or the call reverts with `"PolicyConsent: stale policy version"` — protecting against a policy update landing between signing and submission. `deadline` is a Unix timestamp; the call reverts if `block.timestamp > deadline`.

Consumers: `ShieldSBT.mintWithPolicyConsent()`, `PolicyConsentGate.acceptPolicyFor()` (any policy-gated contract), `LocationRegistry.setLocationCommitmentWithConsent()`.

## 3. Merkle seat assignment leaf format

Library: `SeatMerkleLib`. Used identically by `CouncilRankingEpoch.submitSeatAssignments()` and `OptimisticEpochSubmission.submitEpochResult()`, guaranteeing root compatibility between the trusted and permissionless submission paths.

**Leaf hash:**

```solidity
keccak256(abi.encode(index, account, hasSeat, level, branchId))
```

- `index: uint256` — the leaf's position in the submitted array; makes every leaf unique even if all other fields coincide, and is required to prove a duplicate-account fraud case (same `account`, two different `index` values).
- `account: address`
- `hasSeat: bool`
- `level: int8` — `-1` (EARTH) or `0..10`
- `branchId: uint64` — `0` only when `level == -1`

**Tree construction:** bottom-up binary tree, pairwise `Hashes.commutativeKeccak256` (sorted-pair keccak, OpenZeppelin `MerkleProof`-compatible), odd trailing node promoted unpaired to the next level. Root of a single-leaf set is the leaf itself.

**Proof verification:** standard OpenZeppelin `MerkleProof.verifyCalldata(proof, root, leaf)`.

## 4. Zero-knowledge circuit interface (`HexAncestry.circom`)

```
Public inputs:  commitment (field element), level (0–10), branchId (uint64, as field element)
Private inputs: hexId (uint64, as field element), salt (field element)

Constraint 1: Poseidon(hexId, salt) == commitment
Constraint 2: ancestorAtResolution(hexId, level) == branchId
```

Proof system: Groth16 (bn128 curve). On-chain verifier interface:

```solidity
function verifyProof(
    uint256[2] calldata _pA,
    uint256[2][2] calldata _pB,
    uint256[2] calldata _pC,
    uint256[3] calldata _pubSignals    // [commitment, level, branchId], in that order
) external view returns (bool);
```

Two implementations share this interface: `Groth16Verifier` (`src/HexAncestryVerifier.sol`, snarkjs-generated, production) and `MockHexAncestryVerifier` (test-only, always returns `true` — Foundry tests cannot generate real Groth16 proofs). Deployment selects between them based on `testMode`.

Off-chain artifacts required by a proving client: `HexAncestry.wasm` (witness generator) and `HexAncestry_final.zkey` (proving key), both published as static assets. Recommended libraries: `snarkjs` (proof generation, `groth16.fullProve()`), `circomlibjs` (Poseidon hashing), `h3-js` (H3 index computation).

## 5. H3 index bit layout

64-bit unsigned integer, LSB-numbered, H3 v1 format:

| Bits | Field |
|---|---|
| 59–62 | Mode (`1` = H3 Cell) |
| 52–55 | Resolution (0–15) |
| 45–51 | Base cell (0–121) |
| 42–44, 39–41, … (3 bits × 15) | Digit per resolution level 1–15; `0b111` = unused |

`H3Utils.resolutionOf(h3Index)`, `H3Utils.isValidCellIndex(h3Index)` (mode-bit signature check, not full H3 validation), `H3Utils.parentOf(h3Index)` (decrements resolution, marks the vacated digit slot unused; reverts at resolution 0), `H3Utils.ancestorOf(h3Index, levels)` (iterates `parentOf` `levels` times).

**Node key encoding** (used consistently by `CouncilRankingEpoch`, `Treasury`, `OptimisticEpochSubmission`):

```solidity
nodeKey(level, branchId) = keccak256(abi.encodePacked(level, branchId))   // level: int8, branchId: uint64
```

## 6. Evidence reference convention

`violationPostRef` (`DisciplineModule`) and `postRef` (`TipJar.tip()`, `InfluenceRegistry.award()`) are both `bytes32` values computed off-chain as `keccak256(lensPostId)` (or the equivalent identifier of whatever content platform the DAO's evidence/content lives on at the time). These are **off-chain hash pointers for indexing and evidence linkage only** — the contracts do not call out to, verify against, or otherwise depend on any specific external protocol; the naming reflects the platform used when the reference documentation was originally written, and any content-addressable identifier hashed the same way is equally valid.

## 7. Price feed interface (`IPriceFeed`)

Minimal Chainlink-`AggregatorV3Interface`-compatible subset, used by `TipJar` for `TokenKind.ORACLE` currencies:

```solidity
function decimals() external view returns (uint8);
function latestRoundData() external view returns (
    uint80  roundId,
    int256  answer,
    uint256 startedAt,
    uint256 updatedAt,
    uint80  answeredInRound
);
```

Any feed implementing these two functions with these exact signatures is compatible without code changes — Chainlink itself, and most Chainlink-compatible feeds on Arbitrum (API3, Pyth adapters, etc.). The feed pair **must** be denominated in USD (e.g. `ETH/USD`); `TipJar` does not perform any further currency conversion. Registration (`setOraclePricedToken`) sanity-checks that `latestRoundData()` currently returns a positive `answer`, so a misconfigured or dead feed cannot be voted in accidentally.

## 8. Key on-chain events (indexer reference)

| Event | Contract | Fields |
|---|---|---|
| `ShieldMinted` / `CouncilMinted` | `ShieldSBT` / `CouncilSBT` | `account`, `tokenId` |
| `Slashed` | `ShieldSBT` / `CouncilSBT` | `account`, `tokenId`, `violationPostRef` |
| `InfluenceAwarded` | `InfluenceRegistry` | `author`, `amount` (raw), `effectiveAmount` (post network-stage), `newTotal`, `postRef` |
| `TipSent` | `TipJar` | `from`, `author`, `token`, `receivedAmount`, `authorAmount`, `poolAmount`, `influenceAwarded`, `postRef` |
| `SanctionProposed` / `SanctionExecuted` / `SanctionCancelled` | `DisciplineModule` | `id`, `target`, `sType`, `violationPostRef` (proposed only) |
| `ShieldVoted` / `CouncilVetoed` | `DisciplineModule` | `id`, `voter`, `choice` (Shield only) |
| `CommitmentSet` | `LocationRegistry` | `account`, `commitment`, `timestamp` |
| `AncestorRevealed` | `LocationRegistry` | `account`, `level`, `branchId` |
| `EpochStarted` / `SeatRootSubmitted` / `NodeStatusUpdated` | `CouncilRankingEpoch` | see contract for full field list |
| `TaxDeposited` / `TipCredited` / `HexCredited` / `HexWithdrawn` / `Withdrawn` | `Treasury` | token, amounts, and node/recipient identifiers per event |
| `PolicyUpdated` / `PolicyConsented` | `PolicyConsentGate` (per implementing contract) | `version`, `policyHash`, `policyURI` / `account`, `version`, `policyHash`, `timestamp` |
| `EpochSubmitted` / `EpochChallenged` / `EpochFinalized` / `EpochRejected` | `OptimisticEpochSubmission` | `epoch`, `proposer`/`challenger`, `seatRoot`, `leafCount`, `bond`/`reason` |

Full field types and indexing (`indexed` parameters) are authoritative in each contract's source; this table is a discovery index, not a substitute for the ABI.

## 9. Network deployment identifiers

| Network | Chain ID | RPC alias (`foundry.toml`) |
|---|---|---|
| Arbitrum Sepolia (testnet) | 421614 | `arbitrum_sepolia` |
| Arbitrum One (mainnet) | 42161 | `arbitrum_one` |

Contract verification: Arbiscan API, configured under `[etherscan]` in `foundry.toml`. Compiler: `solc 0.8.24`, `viaIR = true`, `evm_version = cancun`.
