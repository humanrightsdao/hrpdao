# Dossier — перехід на Lens Mainnet

Цей архів містить ЛИШЕ файли, змінені для міграції з Lens Testnet
(Sepolia, chainId 37111) на Lens Mainnet (chainId 232). Розпакуйте
поверх існуючого проєкту, замінивши відповідні файли.

## Змінені файли (9)

| Файл | Що змінено |
|---|---|
| `src/lib/lens.js` | `environment: testnet` → `mainnet` (головний Lens SDK клієнт) |
| `src/lib/grove.js` | `GROVE_CHAIN_ID = chains.testnet.id` → `chains.mainnet.id` |
| `src/main.jsx` | `defaultChain: lensTestnet` → `lensChain` у конфігу Privy |
| `src/context/LensAuthContext.jsx` | `ensureCorrectNetwork()`: chainId 37111/0x90F7 → 232/0xE8, RPC та explorer URL на mainnet |
| `src/hooks/useLensPosts.js` | `chains.testnet` → `chains.mainnet` у `getViemWalletClient` |
| `src/hooks/useLensViolations.js` | те саме |
| `src/hooks/useLensHelpRequests.js` | те саме |
| `.env` | `VITE_LENS_APP_ADDRESS` → `0x40524A13927c95646D2E86bC1A4FA14bE74AfaB5` |
| `.env.local` | те саме |

## Обов'язкові кроки ПЕРЕД деплоєм

✅ **Виконано в цьому архіві:** `VITE_LENS_APP_ADDRESS` у `.env` та
`.env.local` оновлено на новий mainnet App —
`0x40524A13927c95646D2E86bC1A4FA14bE74AfaB5`. Усі місця, що читають
цю змінну (useLensPosts.js, useLensViolations.js, useLensHelpRequests.js,
useUserStats.js, SearchPage.jsx, ModerationQueue.jsx, postReports.js,
moderationActions.js, exportUserData.js, postRateLimit.js,
CreateLensAccount.jsx, LensAuthContext.jsx) підхоплять нове значення
автоматично — коду там міняти не потрібно.

Залишилось зробити вручну:

1. Якщо у вас окремі `.env.production`/CI-секрети (не файли `.env`/
   `.env.local` з репо) — продублюйте туди те саме значення
   `VITE_LENS_APP_ADDRESS`.
2. Тримати testnet- і mainnet-конфіги в окремих `.env`-файлах — не
   перезаписувати один одним.

## Що НЕ чіпалось (свідомо)

- **DAO-контракти** (`useLensDAO.js`, `useTipJar.js`) — вони на
  Arbitrum Sepolia, окрема мережа від Lens Chain, це інша міграція.
  `LENS_CHAIN` у `useLensDAO.js` — мертва константа, ніде більше не
  імпортується.
- **TipTestPage.jsx** — показує лише CLI-приклади для
  `lens_testnet`, самого коду публікації не змінює; варто прибрати
  з mainnet-збірки окремим рішенням (не суто технічна правка).
- **`@lens-protocol/client` версія в package.json** (canary від
  30.04.2025) — не оновлював пакет, лише конфіг. Рекомендую
  окремо перевірити `npm view @lens-protocol/client versions` на
  свіжішу стабільну збірку.

## Профілі users

Testnet- і mainnet-акаунти Lens — окремі сутності. Наявні
testnet-профілі/пости/SBT НЕ переносяться автоматично; користувачам
доведеться створити акаунт на mainnet заново через
`CreateLensAccount.jsx`.
