# HRP DAO

**Human Rights Policy DAO** — a decentralized, censorship-resistant infrastructure for documenting human rights violations, coordinating community governance, and verifying humanity/location claims with zero-knowledge proofs.

This repository is a monorepo containing every piece of the HRP DAO ecosystem: the on-chain governance contracts, two React frontends, and an AI assistant backend.

## Repository structure

```
hrpdao/
├── apps/
│   ├── dao/         # Governance & identity frontend
│   ├── dossier/     # Social / documentation frontend
│   └── atticus/     # AI assistant backend
└── contracts/       # Solidity smart contracts + ZK circuits (Foundry)
```

## Components

### `apps/dao` — Governance & Identity App

A React + Vite single-page app, deployed on Cloudflare Workers, that serves as the main entry point to the DAO.

- Proposal creation, voting, and treasury management UI
- Council ranking and reputation views
- Community forum
- Zero-knowledge location/humanity verification ("HexAncestry") using a circom circuit
- Wallet connection via Privy, decentralized identity via Nostr, and Lens profile lookups
- Tip jar for supporting contributors
- Embedded chat with the "Atticus" AI assistant
- Localized into 11 languages (ar, de, en, es, fr, hi, ja, pt, ru, uk, zh)

### `apps/dossier` — Documentation & Social App

A React + Vite single-page app for reporting and browsing human-rights-violation records, built on top of decentralized social protocols.

- Country-level violation feeds and an interactive world map
- Lens Protocol and Nostr integration for posts, comments, follows, and direct messages
- Help-request board and moderation queue
- AI assistant for drafting/summarizing reports
- Same multi-language support as the `dao` app

### `apps/atticus` — AI Assistant Backend

A lightweight Node.js/Express service that proxies chat requests to Google's Gemini API. It powers the "Atticus" assistant embedded in both frontends.

### `contracts` — Smart Contracts & ZK Circuits

A Foundry (Solidity) project deployed on Arbitrum Sepolia testnet, including:

- `DaoGovernor` / `DaoTimelock` — on-chain proposal and execution logic
- `Treasury`, `TipJar` — fund management
- `CouncilSBT`, `CouncilRankingEpoch`, `InfluenceRegistry` — reputation and council mechanics
- `LocationRegistry`, `HexAncestryVerifier`, `HumanityGate` — zero-knowledge identity/location verification
- `MigrationRootRegistry`, `MigrationClaim` — cross-chain/version migration support
- A circom circuit (`zk/circuits/HexAncestry.circom`) with its compiled artifacts and verification key
- External dependencies pinned as git submodules: [forge-std](https://github.com/foundry-rs/forge-std), [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts), [ds-test](https://github.com/dapphub/ds-test)

## Getting started

### 1. Clone with submodules

The `contracts` package depends on git submodules for its Solidity libraries — clone with `--recurse-submodules`, or initialize them afterward:

```bash
git clone --recurse-submodules https://github.com/humanrightsdao/hrpdao.git
# or, if already cloned:
git submodule update --init --recursive
```

### 2. Frontend apps (`apps/dao`, `apps/dossier`)

```bash
cd apps/dao   # or apps/dossier
npm install
cp .env.example .env   # fill in the required values
npm run dev
```

Both apps are configured for Cloudflare Workers deployment via `wrangler`:

```bash
npm run build
npx wrangler deploy
```

### 3. AI backend (`apps/atticus`)

```bash
cd apps/atticus
npm install
cp .env.example .env   # add your GEMINI_API_KEY
npm start
```

### 4. Smart contracts (`contracts`)

Requires [Foundry](https://book.getfoundry.sh/getting-started/installation).

```bash
cd contracts
cp .env.example .env   # add an RPC URL, deployer key, and Etherscan API key
forge install
forge build
forge test
```

Deployment scripts live under `contracts/script/`; deployment records for Arbitrum Sepolia are kept under `contracts/broadcast/` for provenance.

## Environment variables

Every package ships a `.env.example` describing the variables it needs. **Never commit a real `.env`** — each package's `.gitignore` excludes it by default. Copy the example file, fill in real values locally, and keep them out of version control.

## Security notes

- The `HexAncestry_final.zkey` and `verification_key*.json` files are public artifacts required to generate and verify zero-knowledge proofs — they are not secrets.
- `powersOfTau28_hez_final_12.ptau` (the trusted-setup file) and other intermediate proving artifacts (`witness.wtns`, `proof.json`, `public.json`, `input.json`) are excluded from version control since they're regenerable from the circuit source.
- Found a security issue? Please report it privately rather than opening a public issue.

## License

See individual package directories for license information.
