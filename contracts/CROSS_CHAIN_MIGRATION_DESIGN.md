# HR DAO — Механізм крос-чейн міграції даних (design + реалізація)

Доповнює `V1_MAINNET_LITE_PLAN.md`. Відповідає на: "якщо настане
необхідність міграції на інший блокчейн (чи інша причина) — чи
перенесуться усі дані користувачів?"

**Коротка відповідь: автоматично — ні (EVM-стан одного чейну фізично не
існує на іншому). Але контрольований, верифікований, self-serve механізм
перенесення тепер написаний, вбудований у сам v1-код з дня генезису і
перевірений компіляцією** (той самий `solc 0.8.24`, `evm_version=cancun`,
`optimizer runs=200`, `via_ir=true`, що й `foundry.toml` проєкту — з
генерацією байткоду, не лише ABI).

---

## 0. Архітектурне рішення: вбудовано в v1, не окремий форк

Розглядались два варіанти:

- **А) Окремий форк** ("vNext"-копії ShieldSBT/CouncilSBT/InfluenceRegistry,
  що деплояться лише в момент реальної міграції) — мінімальна поверхня
  аудиту генезису, але ризик розходження версій з часом.
- **Б) Вбудувати міграційні хуки прямо в `src/ShieldSBT.sol`,
  `src/CouncilSBT.sol`, `src/InfluenceRegistry.sol` з першого дня** —
  одне джерело правди назавжди.

**Обрано (Б)**, свідомо: готовність до міграції визнана частиною
необхідного функціоналу v1, а не надбудовою "на майбутнє" — оскільки
наперед невідомо, які зміни (в т.ч. вимушені) чекають попереду, а
додати цю можливість ПІСЛЯ генезису до вже задеплоєних immutable-
контрактів неможливо в принципі.

Наслідок: `src/ShieldSBT.sol`, `src/CouncilSBT.sol`,
`src/InfluenceRegistry.sol` — це вже й є контракти, готові до генезису.
Ніякого окремого "vNext"-репозиторію/копії більше не існує.

---

## 1. Чому "просто скопіювати стан" не працює

EVM-стан живе на конкретному чейні. Немає операції "перенести storage"
між двома мережами — новий деплой завжди починає з storage = 0. Тому
"перенесення даних" — завжди процес:

1. **Зняти знімок** (snapshot) реального стану на вихідному чейні.
2. **Довести** цей знімок так, щоб йому можна було довіряти на цільовому
   чейні (без єдиної точки довіри — інакше централізація).
3. **Відтворити** відповідний стан на цільовому чейні окремими
   транзакціями, з правильним обліком (не "скинути" стаж/decay-годинник).

Гроші в `Treasury` — окрема, ще важливіша проблема: це не "дані", а
реальні токени (USDC/USDT/DAI). Їх перенесення — через canonical bridge
цільового чейну або DAO-кероване OTC, і **свідомо не є частиною цього
документа** (окрема, суто фінансова операція з окремим аудитом).

---

## 2. Що саме переноситься

| Дані | Джерело | Чому важливо зберегти |
|---|---|---|
| Influence-бал | `InfluenceRegistry.influence[account]` | Основний показник репутації |
| Точка відліку decay | `InfluenceRegistry.lastActivityTimestamp[account]` | Інакше decay хибно "перезапускається", завищуючи ефективний Influence |
| Вік проєкту | `InfluenceRegistry.projectStartTimestamp` | Впливає на грейс-період Shield→Council і на `networkStage()` |
| Shield-статус + стаж | `ShieldSBT.memberSince[account]` | Стаж — вимога для переходу в Consul |
| Council-статус + стаж | `CouncilSBT.memberSince[account]` | Те саме для Консула |

Свідомо **НЕ** переноситься цим механізмом:
- Гроші Treasury (окремий bridge/OTC-процес, окремий аудит).
- Гео/рейтингові дані (`LocationRegistry`/`CouncilRankingEpoch`) — якщо
  міграція станеться у фазі 1 (до 244 користувачів), цих даних ще
  просто не існує в жодного користувача. Якщо міграція станеться вже у
  фазі 2 — знадобиться symmetric-доповнення того самого патерну для цих
  контрактів (не описано тут, оскільки актуальне лише після фактичної
  геo-активації).
- Історія модерації (`DisciplineModule`) — публічний архів, а не "право"
  користувача, яке зобов'язково нести далі.

---

## 3. Архітектура

```
Вихідний чейн (де DAO працює зараз)
├── ShieldSBT.sol, CouncilSBT.sol, InfluenceRegistry.sol
│     (звичайний Deploy.s.sol — MIGRATION_ROLE існує в коді,
│      але НІКОМУ не видана, dormant з дня генезису)
└── MigrationRootRegistry.sol   ← деплоїться ОКРЕМО, лише коли
        │                          міграція реально стає рішенням DAO
        │  DAO публікує snapshotRoot (Merkle-корінь) + finalize()
        │
        ▼ (корінь копіюється деплой-скриптом на новий чейн — не
        ▼  онлайн-читанням; контракт на чейні B фізично не читає
        ▼  стан чейну A)
        │
Цільовий чейн (куди мігруємо)
├── ShieldSBT.sol, CouncilSBT.sol, InfluenceRegistry.sol
│     (ТОЙ САМИЙ код, звичайний Deploy.s.sol, без жодних змін)
├── ... решта стека — Treasury, TipJar, DaoGovernor, DisciplineModule ...
└── MigrationClaim.sol   ← НОВИЙ, деплоїться після vsього стека
        │  користувач сам викликає claim(proof, ...) за себе,
        │  контракт верифікує Merkle-proof і викликає
        │  migrationMint()/migrationSetInfluence() на щойно
        │  задеплоєних ShieldSBT/CouncilSBT/InfluenceRegistry
```

Чому **self-serve claim**, а не адмін-скрипт, що масово мінтить усім:
той самий урок, що вже задокументований у `CouncilRankingEpoch`/
`SeatMerkleLib` цього проєкту — bulk-мінт лінійно масштабується по газу
й одного дня впирається в block gas limit. Корінь = O(1) сторедж, кожен
користувач сам платить газ за свій один `claim()`.

### 3.1. `MigrationSnapshotLib.sol`
Спільна формула листка (`leafHash`) і побудова дерева (`buildRoot`) —
той самий принцип, що вже є в `SeatMerkleLib.sol` (навмисно НЕ
перевикористовує саме `SeatMerkleLib`, аби міграційний код не залежав
від гео/ranking-модуля, який на момент фазо-1-міграції може бути ще не
задіяний).

### 3.2. `MigrationRootRegistry.sol` (вихідний чейн)
Суто адитивний контракт — деплоїться будь-коли на вже працюючому
mainnet, окремою транзакцією, нічого не чіпаючи. DAO-контрольована
(через `DaoTimelock`, звичайний цикл propose→vote→queue→execute)
публікація кореня + `finalize()`, що робить його незмінним назавжди.
`snapshotURI` (IPFS/Arweave) дозволяє будь-кому незалежно перебудувати
дерево й звірити з `snapshotRoot` **до** фіналізації.

### 3.3. `MigrationClaim.sol` (цільовий чейн)
`claim(index, influence, ..., proof)` — permissionless, лише за себе,
захист від повторного виклику (`claimed[msg.sender]`), `claimDeadline`
(immutable — вікно міграції обмежене за часом). Конструктор бере адреси
вже задеплоєних `ShieldSBT`/`CouncilSBT`/`InfluenceRegistry` як
`immutable` — тому деплоїться після них (не обов'язково в тій самій
транзакції: можна задеплоїти цільовий чейн сьогодні, а `MigrationClaim`
— пізніше, коли снепшот з вихідного чейну готовий).

### 3.4. Хуки в `ShieldSBT.sol` / `CouncilSBT.sol` / `InfluenceRegistry.sol`
Вбудовані прямо в канонічний v1-код (не окрема копія):
- `MIGRATION_ROLE` — окрема роль, видається ЛИШЕ `MigrationClaim` через
  `setMigrationClaim(address, bool)` (той самий патерн, що вже є в
  `ShieldSBT.setDisciplineModule`). За замовчуванням нікому не видана.
- `migrationMint()` / `migrationSetInfluence()` / `migrationSetProjectStart()`
  — та сама логіка, що й звичайний `mint()`/`award()`, але БЕЗ live-
  перевірки Influence/humanity (уже верифіковано Merkle-proof-ом) і зі
  ЗБЕРЕЖЕННЯМ оригінальних часових міток замість `block.timestamp`.
  Захищені від повторного виклику (`accountToTokenId[account]==0`,
  `influence[account]==0 && lastActivityTimestamp[account]==0`).

---

## 4. Компіляція — перевірено, не "на віру"

Увесь `src/` (25 файлів — оригінали + міграційні доповнення разом, як
одне ціле) прогнаний через `solc 0.8.24` з ТИМИ Ж налаштуваннями, що
`foundry.toml` проєкту, включно з генерацією байткоду — компілюється без
помилок і без "stack too deep". `MigrationRootRegistry.sol`,
`MigrationClaim.sol`, `MigrationSnapshotLib.sol` і
`ExportMigrationSnapshot.s.sol` так само перевірено окремо.

**Чого не робив і чому:** не запускав `forge test`/anvil — мережевий
доступ цього середовища обмежений реєстрами пакетів (npm/pypi/crates),
RPC-нод немає. Перед реальним використанням обов'язково: `forge test`
(зокрема на існуючий `test/FullCycle.t.sol` — переконатись, що додані
хуки нічого не зламали в звичайному, не-міграційному сценарії) + окремі
нові тести на `migrationMint`/`migrationSetInfluence`/`MigrationClaim` +
деплой на testnet (Arbitrum Sepolia) з реальним end-to-end прогоном
`export → publishRoot → finalize → deploy target → claim` хоча б для
3–5 тестових акаунтів.

---

## 5. Покроковий runbook (коли міграція справді стане рішенням)

### Крок 1 — Зняти знімок (вихідний чейн, read-only)
```bash
forge script script/migration/ExportMigrationSnapshot.s.sol:ExportMigrationSnapshot \
  --rpc-url arbitrum_one \
  --sig "run(address,address,address)" \
  <ShieldSBT> <CouncilSBT> <InfluenceRegistry> -vvv
```
Вивід передається в окремий офчейн-інструмент (Node/TS, поза цим репо),
що будує дерево за формулою `MigrationSnapshotLib.leafHash` і публікує
повний JSON на IPFS/Arweave.

### Крок 2 — Опублікувати корінь (вихідний чейн, DAO-пропозиція)
Деплой `MigrationRootRegistry` (окремо, лише зараз, не на генезисі),
потім DAO-пропозиція через `DaoGovernor`:
`publishRoot(root, leafCount, snapshotURI, targetChainId)`.

### Крок 3 — Вікно незалежної перевірки
Мінімум один повний governance-цикл (voting period + timelock delay
`DaoGovernor`) — community перебудовує дерево локально зі `snapshotURI`
і звіряє з опублікованим коренем.

### Крок 4 — Фіналізація (вихідний чейн)
DAO-пропозиція: `finalize()`. Корінь стає незмінним назавжди.

### Крок 5 — Деплой на цільовому чейні
Звичайний `Deploy.s.sol`, без жодних змін (ShieldSBT/CouncilSBT/
InfluenceRegistry вже мають потрібні хуки) + окремий деплой
`MigrationClaim` зі `snapshotRoot`, скопійованим із фіналізованого
`MigrationRootRegistry` на вихідному чейні. Одразу після:
```solidity
influenceRegistry.migrationSetProjectStart(<оригінальний projectStartTimestamp>);
shieldSBT.setMigrationClaim(address(migrationClaim), true);
councilSBT.setMigrationClaim(address(migrationClaim), true);
influenceRegistry.setMigrationClaim(address(migrationClaim), true);
```

### Крок 6 — Вікно claim (публічне, для користувачів)
Кожен користувач сам викликає `MigrationClaim.claim(...)` зі своїм
Merkle-proof (генерується тим самим офчейн-інструментом із Кроку 1,
публікується разом із фронтендом міграції — по одному proof на
акаунт). Рекомендований термін вікна: 90–180 днів.

### Крок 7 — Закриття вікна
Після `claimDeadline` (або раніше, DAO-рішенням): DAO-пропозиція
відкликає `MIGRATION_ROLE` на всіх трьох контрактах —
`setMigrationClaim(address(migrationClaim), false)`. Це закриває
"бекдор" міграційного мінту назавжди.

---

## 6. Ризики й що явно НЕ вирішено цим документом

- **Гроші Treasury** — окрема, критичніша проблема, свідомо не вирішена
  тут (розділ 2). Потребує окремого проєктування bridge/OTC-механізму з
  окремим аудитом.
- **Довіра до офчейн-побудови дерева.** Контракти перевіряють
  Merkle-proof коректно, АЛЕ саме дерево будується поза чейном. Захист —
  публічний `snapshotURI` + вікно перевірки (Крок 3) ДО `finalize()`.
- **`MIGRATION_ROLE` — постійно існуючий, але dormant механізм.** Він
  тепер є частиною самого v1-коду з дня генезису (навіть якщо міграція
  ніколи не знадобиться) — це свідомий компроміс: трохи більша поверхня
  коду в обмін на неможливість "не встигнути" додати цю можливість
  пізніше. Поки роль нікому не видана — жодного ефекту на звичайну
  роботу v1. DAO зобов'язана відкликати роль одразу після закриття
  вікна міграції (Крок 7) — це не відбувається автоматично.
- **Гео-дані другого етапу.** Якщо міграція станеться вже після
  активації рейтингів/гексагонів (фаза 2), потрібне symmetric-розширення
  цього ж патерну на `LocationRegistry`/`CouncilRankingEpoch`.
- **Немає `forge test`-покриття для нового коду** (розділ 4) —
  обов'язково перед будь-яким реальним використанням, і особливо
  важливо переконатись, що додані хуки НЕ зламали жоден існуючий тест
  (`FullCycle.t.sol`, `ActiveSupply.t.sol` тощо).

---

## 7. Файли цього доповнення

```
Змінено (додано міграційні хуки, решта коду не займано):
  src/ShieldSBT.sol            (+ MIGRATION_ROLE, migrationMint, setMigrationClaim)
  src/CouncilSBT.sol           (+ MIGRATION_ROLE, migrationMint, setMigrationClaim)
  src/InfluenceRegistry.sol    (+ MIGRATION_ROLE, migrationSetInfluence,
                                  migrationSetProjectStart, setMigrationClaim)

Нові файли:
  src/migration/MigrationSnapshotLib.sol
  src/migration/MigrationRootRegistry.sol
  src/migration/MigrationClaim.sol
  script/migration/ExportMigrationSnapshot.s.sol
```
