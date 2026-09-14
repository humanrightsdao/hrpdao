# Чек-лист параметрів для фінальної звірки перед mainnet-деплоєм

Три категорії параметрів у цьому документі:
- 🔒 **Hardcoded** — `constant`, змінити можна лише новим деплоєм контракту
- ⚙️ **Deploy-time** — задається через `.env` при запуску `Deploy.s.sol`, після деплою стає або hardcoded (якщо `immutable`), або default-значенням для DAO-керованого поля
- 🗳️ **DAO-changeable** — mutable state, змінюється лише голосуванням через `DaoGovernor` → `DaoTimelock` після деплою

Для кожного параметра: поточне значення в коді, і місце для позначки
✅/❌ команди при фінальній звірці.

---

## 1. DaoTimelock (governance-затримка)

| Параметр | Тип | Значення (mainnet) | Джерело | ✅/❌ |
|---|---|---|---|---|
| `timelockMinDelay` | ⚙️ Deploy-time | **72 години** | `Deploy.s.sol: cfg.timelockMinDelay = testMode ? ... : 72 hours` (hardcoded в скрипті, не через env) | ☐ |
| `guardians[]` | ⚙️ Deploy-time | `[GUARDIAN_MULTISIG]` | `.env: GUARDIAN_MULTISIG` | ☐ |
| `proposers[]` | ⚙️ Deploy-time | `[]` (порожньо на деплої, потім `DaoGovernor` через `grantRole`) | `Deploy.s.sol` | ☐ |
| `executors[]` | ⚙️ Deploy-time | `[address(0)]` (будь-хто може виконати queued-транзакцію) | `Deploy.s.sol` | ☐ |

---

## 2. HumanityGate (людяність)

| Параметр | Тип | Значення | Джерело | ✅/❌ |
|---|---|---|---|---|
| Шкала score | 🔒 Hardcoded (конвенція) | 0–10000 (×100) | Коментар `HumanityGate.sol:12` | ☐ |
| `providerList` на mainnet | ⚙️ Deploy-time | `[PassportAdapter]` (реальний Human Passport Decoder) | `.env: PASSPORT_DECODER` | ☐ |
| `governor` (pending) | ⚙️ Deploy-time | `DaoTimelock` (через `proposeGovernor`, потребує `acceptGovernor()` окремою пропозицією) | `Deploy.s.sol._deploySBTs` | ☐ |

---

## 3. PassportAdapter

| Параметр | Тип | Значення | Джерело | ✅/❌ |
|---|---|---|---|---|
| `passportDecoder` | ⚙️ Deploy-time, `immutable` | Human Passport Decoder на Arbitrum One | `.env: PASSPORT_DECODER` = `0x2050256A91cbABD7C42465aA0d5325115C1dEB43` (звірити самостійно на arbiscan.io перед деплоєм — могло змінитись) | ☐ |

---

## 4. LocationRegistry (ZK-приватність геолокації)

| Параметр | Тип | Значення | Джерело | ✅/❌ |
|---|---|---|---|---|
| `verifier` | ⚙️ Deploy-time, `immutable` | **РЕАЛЬНИЙ** `PlonkVerifier`, згенерований з публічного ptau (НЕ тестовий) | `src/HexAncestryVerifier.sol` — **ОБОВ'ЯЗКОВО перевірити, що це фінальна, не тестова версія** | ☐ |
| `CHANGE_COOLDOWN` | 🔒 Hardcoded | 1 година | `LocationRegistry.sol:92` | ☐ |
| `MAX_RESOLUTION` | 🔒 Hardcoded | 10 (макс. рівень гексагону) | `LocationRegistry.sol:96` | ☐ |
| `LEVEL_EARTH` | 🔒 Hardcoded | -1 (спеціальний "глобальний" рівень) | `LocationRegistry.sol:101` | ☐ |
| Notice hash/URI | ⚙️ Deploy-time | `keccak256("HR DAO Location Disclosure Notice v1")`, `ipfs://location-notice-placeholder` | `Deploy.s.sol` — **⚠️ placeholder IPFS-URI, замінити на реальний перед деплоєм** | ☐ |

---

## 5. InfluenceRegistry (нарахування впливу)

| Параметр | Тип | Значення | Джерело | ✅/❌ |
|---|---|---|---|---|
| `DECAY_BPS` | 🔒 Hardcoded | 1000 (10% річних, compound) | `InfluenceRegistry.sol:95` | ☐ |
| `STAGE_THRESHOLD` | 🔒 Hardcoded | 244 Консули (поріг переходу на стадію 1) | `InfluenceRegistry.sol:106` | ☐ |
| Курс $→Influence, стадія 0 | 🔒 Hardcoded (формула) | 100% (1 Influence = $1) | `currentStageMultiplierBps()` | ☐ |
| Курс $→Influence, стадія 1 | 🔒 Hardcoded (формула) | 50% (1 Influence = $2) | `currentStageMultiplierBps()`, стадій більше 1 НЕМАЄ (навмисно обмежено) | ☐ |
| `projectStartTimestamp` | Обчислюється | Момент першого `award()` (НЕ момент деплою) | `InfluenceRegistry.sol` | ☐ |

---

## 6. ShieldSBT (перший рівень членства)

| Параметр | Тип | Значення | Джерело | ✅/❌ |
|---|---|---|---|---|
| `INFLUENCE_THRESHOLD` | 🔒 Hardcoded | 200 Influence | `ShieldSBT.sol:124` | ☐ |
| `shieldMinHumanityScore` | ⚙️ Deploy-time | **2000** (20.00%) | `.env: SHIELD_MIN_SCORE`, default у `Deploy.s.sol` | ☐ |
| `YEAR1_GRACE_DURATION` | 🔒 Hardcoded | 180 днів (≈6 міс, якщо вік проєкту < 1 року) | `ShieldSBT.sol:133` | ☐ |
| `YEAR2_GRACE_DURATION` | 🔒 Hardcoded | 365 днів (≈12 міс, вік проєкту 1-2 роки) | `ShieldSBT.sol:134` | ☐ |
| `STANDARD_DURATION` | 🔒 Hardcoded | 730 днів (2 роки, вік проєкту > 2 років) | `ShieldSBT.sol:135` | ☐ |
| `inactivityWindow` | 🗳️ DAO-changeable | **180 днів** (default, ⚠️ позначено в коді "орієнтовно, до підтвердження перед mainnet" — **ОБОВ'ЯЗКОВО ОБГОВОРИТИ В КОМАНДІ**) | `ShieldSBT.sol:91`, змінюється через `setInactivityWindow()` | ☐ ⚠️ |
| Політика (policy hash/URI) | ⚙️ Deploy-time | `keccak256("HR DAO Human Rights Policy v1")`, `ipfs://policy-placeholder` | `Deploy.s.sol` — **⚠️ placeholder, замінити на реальний текст політики** | ☐ |
| `testMode` | ⚙️ Deploy-time, `immutable` | **false** на mainnet (критично — вимикає test-only функції) | `.env: TESTNET=false` | ☐ |

---

## 7. CouncilSBT (другий рівень членства)

| Параметр | Тип | Значення | Джерело | ✅/❌ |
|---|---|---|---|---|
| `INFLUENCE_THRESHOLD` | 🔒 Hardcoded | 500 Influence | `CouncilSBT.sol:66` | ☐ |
| `councilMinHumanityScore` | ⚙️ Deploy-time | **5000** (50.00%) | `.env: COUNCIL_MIN_SCORE`, default у `Deploy.s.sol` | ☐ |
| Grace-період до Консула | Похідне | Той самий `_currentGraceDuration()` формула, що й ShieldSBT (180/365/730 днів залежно від віку проєкту), зафіксовується на момент mint Shield | `ShieldSBT.sol._currentGraceDuration()`, читається через `shieldSBT.requiredCouncilDuration(account)` | ☐ |

---

## 8. CouncilRankingEpoch (епохи, гексагони)

| Параметр | Тип | Значення | Джерело | ✅/❌ |
|---|---|---|---|---|
| `minEpochDuration` | 🗳️ DAO-changeable | **90 днів** (default = "квартал") | `CouncilRankingEpoch.sol:91`, `setMinEpochDuration()` | ☐ |
| `NODE_CAPACITY` | 🔒 Hardcoded | 244 (місткість одного гексагону-вузла) | `CouncilRankingEpoch.sol:78` | ☐ |
| `EARTH_BRANCH`/`LEVEL_EARTH` | 🔒 Hardcoded | 0 / -1 | `CouncilRankingEpoch.sol:101-102` | ☐ |
| `EPOCH_SUBMITTER_ROLE` | ⚙️ Deploy-time | `EPOCH_SUBMITTER` = `0x8036F16C31f1d428E1a4AA616cDcb2996B81e40B` (Safe 2-з-3) | `.env: EPOCH_SUBMITTER` | ☐ |

---

## 9. Treasury (казна)

| Параметр | Тип | Значення | Джерело | ✅/❌ |
|---|---|---|---|---|
| `OPERATIONAL_BPS` | 🔒 Hardcoded | 500 (5% — частка на операційні витрати) | `Treasury.sol:410` | ☐ |
| `MAX_ROLLING_WINDOW` | 🔒 Hardcoded | 365 днів (верхня межа, не сам параметр) | `Treasury.sol:124` | ☐ |
| `MAX_RECIPIENT_COOLDOWN` | 🔒 Hardcoded | 365 днів (верхня межа) | `Treasury.sol:125` | ☐ |
| `rollingWindow` | ⚙️ Deploy-time (потім 🗳️) | **30 днів** | `Deploy.s.sol: cfg.rollingWindow` (hardcoded в скрипті на mainnet-гілці) | ☐ |
| `recipientCooldown` | ⚙️ Deploy-time (потім 🗳️) | **14 днів** | `Deploy.s.sol: cfg.recipientCooldown` (hardcoded в скрипті на mainnet-гілці) | ☐ |
| `perTxCapBps` | 🗳️ DAO-changeable | **1000** (10% — default за пропозицією команди) | `Treasury.sol:128` | ☐ |
| `rollingCapBps` | 🗳️ DAO-changeable | **2500** (25% за 30 днів — default) | `Treasury.sol:131` | ☐ |
| `guardians[]` | ⚙️ Deploy-time | `[GUARDIAN_MULTISIG]` | `.env: GUARDIAN_MULTISIG` | ☐ |

---

## 10. DisciplineModule (санкції)

| Параметр | Тип | Значення | Джерело | ✅/❌ |
|---|---|---|---|---|
| `SHIELD_VOTING_PERIOD` | 🔒 Hardcoded | 7 днів | `DisciplineModule.sol:169` | ☐ |
| `VETO_WINDOW` | 🔒 Hardcoded | 10 днів | `DisciplineModule.sol:170` | ☐ |
| `VETO_QUORUM_BPS` | 🔒 Hardcoded | 5000 (>50%, суворо) | `DisciplineModule.sol:171` | ☐ |
| `REPROPOSAL_COOLDOWN` | 🔒 Hardcoded | 14 днів | `DisciplineModule.sol:177` | ☐ |
| **Warning (попередження)** — участь | 🔒 Hardcoded | 15% (`WARNING_PARTICIPATION_BPS`), мінімум 5 голосів (`WARNING_PARTICIPATION_FLOOR`) | `DisciplineModule.sol:184-185` | ☐ |
| **Warning** — схвалення | 🔒 Hardcoded | >50% (`WARNING_APPROVAL_BPS`, суворо) | `DisciplineModule.sol:186` | ☐ |
| **Restriction (обмеження)** — участь | 🔒 Hardcoded | 25% (`RESTRICTION_PARTICIPATION_BPS`), мінімум 8 голосів | `DisciplineModule.sol:188-189` | ☐ |
| **Restriction** — схвалення | 🔒 Hardcoded | >55% (`RESTRICTION_APPROVAL_BPS`) | `DisciplineModule.sol:190` | ☐ |
| **Slash (повне виключення)** — участь | 🔒 Hardcoded | 40% (`SLASH_PARTICIPATION_BPS`), мінімум 12 голосів | `DisciplineModule.sol:192-193` | ☐ |
| **Slash** — схвалення | 🔒 Hardcoded | >66% (`SLASH_APPROVAL_BPS`, кваліфікована більшість) | `DisciplineModule.sol:194` | ☐ |

---

## 11. TipJar (прийом донатів)

| Параметр | Тип | Значення | Джерело | ✅/❌ |
|---|---|---|---|---|
| `councilAuthorBps` | 🗳️ DAO-changeable | **5000** (50% автору-Консулу, 50% в пул) | `TipJar.sol:119` | ☐ |
| `shieldAuthorBps` | 🗳️ DAO-changeable | **5000** (50% автору-Захиснику) | `TipJar.sol:120` | ☐ |
| `noneAuthorBps` | 🗳️ DAO-changeable | **5000** (50% автору без статусу) | `TipJar.sol:121` | ☐ |
| `MIN_TAX_BPS` / `MAX_TAX_BPS` | 🔒 Hardcoded | 5000 / 9500 (межі частки пулу/ДАО для `setSplits()`; частка автора відповідно обмежена [5%;50%]) | `TipJar.sol:114-115` | ☐ |
| `maxOracleStaleness` | 🗳️ DAO-changeable | **1 година** | `TipJar.sol:169` | ☐ |
| Початкові стейблкоїни | ⚙️ Deploy-time | USDC/USDT/DAI на Arbitrum One (адреси нижче в розділі 14) | `.env: USDC_ADDRESS/USDT_ADDRESS/DAI_ADDRESS` | ☐ |
| Мінімум для USDC/USDT | ⚙️ Deploy-time (hardcoded в скрипті) | 1e6 (1 токен, 6 decimals) | `Deploy.s.sol._buildInitialStablecoins` | ☐ |
| Мінімум для DAI | ⚙️ Deploy-time (hardcoded в скрипті) | 1e18 (1 DAI, 18 decimals) | `Deploy.s.sol._buildInitialStablecoins` | ☐ |
| Курс USDC/USDT/DAI → Influence | ⚙️ Deploy-time (hardcoded в скрипті) | 1:1 ($1 = 1 Influence) | `Deploy.s.sol._buildInitialStablecoins` | ☐ |

---

## 12. DaoGovernor (голосування)

| Параметр | Тип | Значення | Джерело | ✅/❌ |
|---|---|---|---|---|
| `votingDelay` | ⚙️ Deploy-time (hardcoded в скрипті) | **2 дні** | `Deploy.s.sol: cfg.votingDelay` | ☐ |
| `votingPeriod` | ⚙️ Deploy-time (hardcoded в скрипті) | **7 днів** | `Deploy.s.sol: cfg.votingPeriod` | ☐ |
| `proposalThreshold` | ⚙️ Deploy-time (hardcoded в скрипті) | **0** (гейтинг через "лише Council може пропонувати", не через мінімальний Influence) | `Deploy.s.sol` | ☐ |
| `QUORUM_BPS` | 🔒 Hardcoded | 2000 (20% від `activeSupply` Shield) | `DaoGovernor.sol:178` | ☐ |
| `scopedQuorumFloor` | 🗳️ DAO-changeable | **3** (мінімальний кворум для геоскоупованих пропозицій) | `DaoGovernor.sol:205` | ☐ |
| `maxRootStaleness` | 🗳️ DAO-changeable | **30 днів** (ГЕО-РЕФОРМА v15 — dead man's switch: якщо сабмітер не публікує seat root довше цього часу, гейтинг `propose()`/`proposeScoped(EARTH,...)` через `claimGlobalSeat()` автоматично тимчасово знімається) | `DaoGovernor.sol` | ☐ |

---

## 13. OptimisticEpochSubmission (permissionless-альтернатива, окремий деплой)

⚠️ **Не входить в основний `Deploy.s.sol`** — деплоїться пізніше через
`script/DeployOptEpoch.s.sol`, коли ДАО вирішить децентралізувати подачу
епох. Параметри нижче — для довідки на майбутнє, не для першого деплою.

| Параметр | Тип | Значення | Джерело | ✅/❌ |
|---|---|---|---|---|
| `requiredBond` | 🗳️ DAO-changeable | 1 ETH | `OptimisticEpochSubmission.sol:90` | — |
| `challengeBond` | 🗳️ DAO-changeable | 0.1 ETH | `OptimisticEpochSubmission.sol:91` | — |
| `challengePeriod` | 🗳️ DAO-changeable | 3 дні | `OptimisticEpochSubmission.sol:92` | — |
| `epochStaleTimeout` | 🗳️ DAO-changeable | 14 днів | `OptimisticEpochSubmission.sol:93` | — |

---

## 14. Реальні адреси mainnet (Arbitrum One, chain id 42161)

⚠️ **Звірити самостійно на arbiscan.io перед деплоєм** — адреси нижче
знайдені й перевірені на момент попередньої розмови, могли змінитись.

| Змінна `.env` | Адреса | Примітка |
|---|---|---|
| `USDC_ADDRESS` | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | Native USDC (Circle) |
| `USDT_ADDRESS` | `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9` | Технічно "USDT0" після проксі-апгрейду Tether (лют. 2025), функціонально звичайний USDT |
| `DAI_ADDRESS` | `0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1` | Офіційний L2 DAI |
| `PASSPORT_DECODER` | `0x2050256A91cbABD7C42465aA0d5325115C1dEB43` | Human Passport Decoder |
| `GUARDIAN_MULTISIG` | `0xEbbe8cEE75B136d976B782C5D655D1804451dbC7` | Safe 2-з-3, вже створено |
| `EPOCH_SUBMITTER` | `0x8036F16C31f1d428E1a4AA616cDcb2996B81e40B` | Safe 2-з-3, вже створено |

---

## 15. Особливо звернути увагу перед деплоєм (⚠️-позначені вище)

1. **`ShieldSBT.inactivityWindow` (180 днів)** — прямо позначено в коді
   як "орієнтовно, до підтвердження перед mainnet". Обговорити в
   команді, чи це остаточне значення.
2. **`src/HexAncestryVerifier.sol`** — переконатись, що це фінальна
   версія з реального публічного ptau, а не тестова (перевірено раніше
   в розмові — фінальна версія вже застосована, але звірте ще раз перед
   самим деплоєм).
3. **IPFS placeholder-и** — `LocationRegistry` notice URI та `ShieldSBT`
   policy URI зараз `"ipfs://location-notice-placeholder"` і
   `"ipfs://policy-placeholder"` — замінити на реальний завантажений
   контент перед деплоєм (ці значення `immutable`, змінити після
   деплою не можна).
4. **`TESTNET=false`** в `.env` — без цього скрипт піде тестовим шляхом
   навіть на mainnet RPC.
