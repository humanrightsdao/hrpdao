# HR DAO

Децентралізована організація, що об'єднує людей навколо захисту прав
людини: трирівневе членство (Захисник → Консул → голосування DAO),
вплив прив'язаний до реальних грошових донатів (Influence = $), і
територіальний вимір — геолокація через zero-knowledge докази, без
розкриття точної адреси.

Stack: Solidity 0.8.24, Foundry, Arbitrum One (EVM `cancun`), OpenZeppelin
Contracts v5.7.0, `via_ir=true`.

Це — довідка про поточний стан проєкту. Хронологію того, як і чому
код дійшов до цього стану, дивись у `HR_DAO_Change_History.md`.

---

## 1. Фаза проєкту: v1 (централізовано) → v2 (гео-каскад)

Код уже реалізує дворівневу модель — переходу з коду в код не буде,
є лише одна операційна дія, що вмикає другу фазу.

**v1 (зараз, до 244 учасників):** `TipJar`, `Treasury`, `ShieldSBT`,
`CouncilSBT`, `DisciplineModule`, `DaoGovernor`/`DaoTimelock` (лише
звичайні `propose()`), `HumanityGate`+`PassportAdapter`,
`PolicyConsentGate`, `InfluenceRegistry`. `OptimisticEpochSubmission`
свідомо **не** деплоїться.

**v2 (після 244, активується окремо):** `LocationRegistry`, `H3Utils`,
`HexAncestryVerifier`, каскадне ранжування `CouncilRankingEpoch`,
`DaoGovernor.proposeScoped()`. Контракти вже задеплоєні разом з рештою
стека (потрібні як адреси-залежності), просто не використовуються, поки
`EPOCH_SUBMITTER` не викличе `CouncilRankingEpoch.submitNodeStatus(...)`
для EARTH з реальною кількістю ≥ 244 верифікованих учасників.

| Версія | Що це технічно |
|---|---|
| `v1.0.0-genesis` | `Deploy.s.sol --broadcast` на Arbitrum One. `OptimisticEpochSubmission` не деплоїться |
| `v1.x.x` | Параметричні релізи через DAO-голосування, без редеплою |
| `v2.0.0-geo-activation` | Той самий деплой; `submitNodeStatus(EARTH, ≥244, …)` вмикає каскад для всіх |
| `v2.1.0-permissionless-epochs` | Окремий деплой `OptimisticEpochSubmission` + DAO-пропозиція на роль |

Детальний план і ризики — `V1_MAINNET_LITE_PLAN.md`.

---

## 2. Архітектура контрактів

### Шар довіри й ідентичності
- **`HumanityGate.sol`** — реєстр "провайдерів людяності" (Human
  Passport, WorldID, мок для тестів), скор 0–10000 через `bestScore()`.
- **`PassportAdapter.sol`** — адаптер до Human Passport Decoder на
  mainnet.
- **`PolicyConsentGate.sol`** — EIP-712 згода з політикою прав людини;
  успадковується `ShieldSBT` і `LocationRegistry` (кожен зі своїм
  текстом/хешем).

### Шар членства (SBT, soulbound)
- **`ShieldSBT.sol`** — "Захисник". Мінт: `Influence ≥ 200` +
  прохідний `humanityGate`-скор. ERC-5192 (locked), `activeSupply`
  через `Checkpoints.Trace208`.
- **`CouncilSBT.sol`** — "Консул". Мінт: уже є Shield + `Influence ≥
  500` + минув grace-період з моменту mint-у Shield.
  `CouncilSBT.totalSupply()` визначає `networkStage()` (поріг 244).
- **`DisciplineModule.sol`** — санкції (попередження → обмеження →
  slash), голосує Council, з вікном вето.

### Шар впливу й грошей
- **`InfluenceRegistry.sol`** — центральний реєстр Influence (= $,
  ціле число). Курс $→Influence падає вдвічі на кожній мережевій
  стадії. Щорічний decay 10% (compound) на неактивний Influence.
- **`TipJar.sol`** — єдина точка входу коштів. Спліт автор/пул 50/50
  за замовчуванням для всіх трьох рівнів членства (голосуванням ДАО
  частку пулу можна збільшити в межах 50%–95% — тобто частка автора
  може лише зменшуватись, від 50% максимум до 5% мінімум).
  Стейблкоїни — курс 1:1 вручну; інші токени — через Chainlink-сумісний
  оракул. Fee-on-transfer токени рахуються за фактично отриманою сумою.
- **`Treasury.sol`** — сховище коштів. Виплати лише на
  `allowedRecipient` (allowlist + cooldown + ліміти per-tx/rolling-
  window). Територіальний розподіл податку — за гексагонами.

### Геолокаційний/приватність шар
- **`LocationRegistry.sol`** — Poseidon-комітмент локації замість
  сирого H3-hexId; розкриття рівнів-предків через ZK-доказ
  (`revealAncestor`, зараз PLONK-верифікатор `HexAncestryVerifier.sol`
  — див. розділ 6 нижче щодо статусу).
- **`CouncilRankingEpoch.sol`** — епохальний знімок складу Council і
  населеності гексагонів через Merkle root, подає `EPOCH_SUBMITTER_ROLE`.
  `minEpochDuration` — 90 днів за замовчуванням.
- **`OptimisticEpochSubmission.sol`** — permissionless альтернатива
  подання епох (застава + вікно оскарження), окремий деплой.

### Шар голосування
- **`DaoGovernor.sol`** — голосування, зважене за Influence, право
  пропонувати лише в Council. Кворум 20% від `activeSupply` Shield.
  Геоскоуповані пропозиції — з динамічним `scopedQuorumFloor`.
- **`DaoTimelock.sol`** — виконує рішення з затримкою (72 год на
  mainnet), `GUARDIAN_ROLE` для екстреної паузи/скасування.

### Міграційний шар (опційний, dormant)
- **`src/migration/`** (`MigrationClaim.sol`, `MigrationRootRegistry.sol`,
  `MigrationSnapshotLib.sol`) — крос-чейн перенесення Influence/Shield/
  Council-статусу через Merkle-доказ. Вимкнено за замовчуванням
  (`MIGRATION_ROLE` нікому не видана на генезисі). Повний runbook —
  `CROSS_CHAIN_MIGRATION_DESIGN.md`.

---

## 3. Життєвий цикл: від донату до впливу

1. `TipJar.tip()` — стейблкоїн від людини.
2. Спліт: частина автору, решта → `Treasury.creditFromTip()` (або
   escrow, якщо `TIPJAR_ROLE` ще не видана).
3. `InfluenceRegistry.award()` — Influence автору, зважений на поточну
   мережеву стадію.
4. `Influence ≥ 200` + humanity-скор → можна замінтити `ShieldSBT`.
5. `Influence ≥ 500` + grace-період → можна замінтити `CouncilSBT`.
6. Консули пропонують і голосують у `DaoGovernor`, зважено за поточним
   Influence (знімок на момент пропозиції).
7. Ухвалене йде через `DaoTimelock` (72 год) і виконується.

---

## 4. Генезис: перші дії DAO після деплою

Деплоєр не тримає жодної постійної ролі — усе передається
`DaoTimelock` у `Deploy.s.sol`. Два кроки навмисно залишені "pending"
(мають пройти через governance, не через деплой-скрипт) — мають бути
**першою ж пропозицією** нового `DaoGovernor`:

1. `humanityGate.acceptGovernor()` — інакше деплоєр необмежено довго
   лишається `governor`-ом `HumanityGate`.
2. `treasury.setTipJarRole(address(tipJar), true)` — інакше пул-частка
   з `tip()` накопичується в escrow всередині `TipJar` (гроші не
   втрачаються, але й не потрапляють у `Treasury`, доки хтось не
   викличе `sweepEscrowToTreasury()`).

---

## 5. Ролі та хто ними володіє (mainnet)

| Роль | Контракт(и) | Власник |
|---|---|---|
| `DAO_ROLE` | ShieldSBT, CouncilSBT, InfluenceRegistry, LocationRegistry, CouncilRankingEpoch, TipJar | `DaoTimelock` |
| `TREASURER_ROLE` | Treasury | `DaoTimelock` |
| `GUARDIAN_ROLE` | Treasury, DaoTimelock (guardians[]) | `GUARDIAN_MULTISIG` (Safe) |
| `EPOCH_SUBMITTER_ROLE` | CouncilRankingEpoch | `EPOCH_SUBMITTER` (окремий Safe) |
| `TIPJAR_ROLE` | InfluenceRegistry, Treasury | `TipJar` (контракт) |
| `DISCIPLINE_ROLE` | ShieldSBT, CouncilSBT | `DisciplineModule` (контракт) |
| `ACTIVITY_ROLE` | InfluenceRegistry | `DaoGovernor`, `DisciplineModule` |
| `PROPOSER_ROLE`/`CANCELLER_ROLE` | DaoTimelock | `DaoGovernor` |
| `governor` (окреме поле) | HumanityGate | `DaoTimelock` (після `acceptGovernor()`) |
| `MIGRATION_ROLE` | ShieldSBT, CouncilSBT, InfluenceRegistry | нікому (вимкнено за замовчуванням) |

**Безпекова модель:** деплоєр — одноразова роль, повністю відкликається
до кінця деплою. `GUARDIAN_MULTISIG` може паузити/скасовувати екстрено,
але не змінює параметри й не розпоряджається коштами напряму.
`EPOCH_SUBMITTER` подає лише епохальні дані, не впливає на Influence,
голоси чи кошти напряму. Єдиний шлях зміни параметрів протоколу —
`DaoTimelock`/`DaoGovernor`, завжди з 72-годинною затримкою й
голосуванням Консулів.

---

## 6. Технічний статус ZK-верифікатора локації — **потребує уваги перед mainnet**

`LocationRegistry` з v13 використовує PLONK (`PlonkVerifier`), не
Groth16 — PLONK не потребує circuit-specific trusted setup, досить
universal Powers-of-Tau (можна перевикористати вже завершену публічну
церемонію, напр. `powersOfTau28_hez_final_12.ptau`, той самий, що
Polygon Hermez використовує у виробничому zkEVM).

**Поточний фактичний стан:** `src/HexAncestryVerifier.sol`, який
реально деплоїться, усе ще згенерований з **локального тестового**
ptau — це прямо написано в заголовку самого файла і в коментарі
`script/Deploy.s.sol`. Реальний публічний ptau вже завантажено, і
кандидат на заміну (`.zkey`) уже згенеровано й, судячи з артефактів,
протестовано — але останній крок (`snarkjs zkey export
solidityverifier` з нового `.zkey` → заміна `src/HexAncestryVerifier.sol`)
ще **не виконаний**. Не покладайтесь на математичну надійність доказів
розкриття локації як на абсолютну гарантію, доки цей файл не
перегенеровано з реального ptau і повторно не перевірено реальним
доказом. Чекбокс-пункт про це — `MAINNET_PARAMETERS_CHECKLIST.md`,
розділ 4; технічні кроки заміни — `ZK_PRIVACY_V13_CHANGES.md`, розділ
"Перед mainnet"; повний опис пайплайна — `zk/README.md`.

---

## 7. Дрібні технічні деталі, які легко загубити

**Перейменування API `LocationRegistry` (з v12, чинне й зараз):**
`setLocation()` → `setLocationCommitment()`; `getHexId()`/
`getResolution()` прибрані повністю, замінені на `getCommitment()`,
`getRevealedAncestor()`, `getDeepestRevealedLevel()`; конструктор
отримав новий параметр `_verifier` (адреса верифікатора).

**На що зважати в коді крос-чейн міграції** (з перевірки набору файлів
`migration_contracts.zip` 31.08.2026):
- `MigrationSnapshotLib.leafHash()` (і, відповідно, `MigrationClaim.claim()`)
  вимагає **10 полів**, включно з `humanityScore` (через
  `shield.humanityGate().bestScore(account)`) і `policyConsentVersion`
  (через `shield.consentedPolicyHash(account)` — це `bytes32`-хеш
  конкретної версії політики, **не** порядковий номер версії). Якщо
  колись переписуватимете `script/migration/ExportMigrationSnapshot.s.sol`
  — легко ненавмисно повернутися до старих 8 полів і зламати збіг
  leaf-хешу з тим, що перевіряє `claim()`.
- `MigrationRootRegistry.sol` керується власною `DAO_ROLE` (той самий
  патерн, що й решта проєкту) — **не** окремою `TREASURER_ROLE`, як
  одного разу помилково стверджував коментар у файлі.

---

## 8. Довідкові документи в цьому репозиторії

| Файл | Навіщо відкривати |
|---|---|
| `HR_DAO_Change_History.md` | Хронологія всіх реформ і виправлень — чому код саме такий |
| `MAINNET_DEPLOY_GUIDE.md` | Покрокова інструкція mainnet-деплою |
| `MAINNET_PARAMETERS_CHECKLIST.md` | Робочий чекліст усіх параметрів перед деплоєм (ще не заповнений) |
| `CROSS_CHAIN_MIGRATION_DESIGN.md` | Runbook на випадок реальної міграції на інший чейн (не потрібен, доки міграція не стала рішенням) |
| `zk/README.md` | Детальний технічний опис ZK-пайплайна, схеми й фронтенд-інтеграції |
| `V1_MAINNET_LITE_PLAN.md` | Повний план і ризики фази v1 → v2 |
| `HR_DAO_Location_Disclosure_Notice_v1_FINAL.md` | Текст, який користувач приймає перед декларацією локації |

---

## 9. Відомі відкриті питання

Коротко (деталі й контекст — `HR_DAO_Change_History.md`, розділ
"Відкриті питання"):

- Верифікатор локації не фіналізований (розділ 6 вище).
- `keccak256`-хеш нотиса в `Deploy.s.sol` порахований від рядка-
  заголовка, а не від канонічного тексту документа — замінити після
  затвердження фінального тексту.
- IPFS-плейсхолдери (`location-notice-placeholder`, `policy-placeholder`)
  — обидва `immutable`, замінити до деплою.
- Три значення, позначені як "орієнтовні, до підтвердження":
  `ShieldSBT.inactivityWindow` (180 днів), `DaoGovernor.scopedQuorumFloor`
  (3), `DaoGovernor.maxRootStaleness` (30 днів).
- `forge test` жодного разу не запускався в задокументованих проходах
  аналізу (середовище без доступу до RPC/Foundry) — увесь код
  перевірявся компіляцією `solc` і ручним аналізом логіки. Реальний
  прогін тестів — обов'язковий, ще не підтверджений незалежно.
