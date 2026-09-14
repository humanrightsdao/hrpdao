# Rights DAO — Standalone Frontend

The third, independent application of the governance registry. Does not depend on lens/nostr,
but looks at the same smart contracts (so data is shared automatically,
without any backend hub).

## Installation

1. Place this folder as `hrpdaoall/apps/dao`
2. `npm install`
3. `cp .env.example .env.local` and fill in the contract addresses —
   **the same ones** that are already in `.env.local` of your lens/nostr applications
4. `npm run dev` — will start on `http://localhost:5175`

If `anvil` is already running and contracts are deployed locally
(`VITE_USE_LOCAL_CHAIN=true`) — the page will immediately see the same proposals
and votes as in the lens/nostr applications, with the same wallet.

## What's included

- `/` — overview: registry statistics, recent cases
- `/proposals` — full proposal registry with status filters
- `/proposals/:id` — case card: description, vote summary, voting
  buttons (For / Against / Abstain), queue/execute when available
- `/treasury` — treasury balance (read directly from RPC)
- `/membership` — SHIELD / COUNCIL status, RIGHTS threshold, mint buttons

## What's not yet included (next iteration)

- UI for DisciplineModule (complaints/sanctions for posts) — the hook (`useDao.js`)
  already has all the needed methods (`proposeSanction`, `voteShieldSanction`,
  `executeSanction`, etc.), just not yet connected to pages
- Form for creating a new proposal (`submitProposal` in the hook is already ready)

## Shared code

`src/hooks/useDao.js` — an exact copy of `hrpdaolens/src/hooks/useLensDAO.js`
(only the function itself has been renamed). This is already generic, Lens-independent DAO engine.
When you consolidate — this is the file that should be extracted into a shared
workspace package for all three applications.