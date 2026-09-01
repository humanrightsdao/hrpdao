# HR DAO — План спрощення до Mainnet v1 (централізована фаза, ≤244 користувачів)

Статус: аналіз існуючого коду репозиторію (`contracts.rar`, Foundry, Arbitrum,
Solidity 0.8.24) + чинного `script/Deploy.s.sol`. Документ доповнює
`MIGRATION_NOTES.md` (Lens → Arbitrum) і написаний у тому ж форматі.

---

## 0. Головний висновок

**Двофазна модель "спочатку централізовано, після 244 — рейтинги/гексагони"
уже реалізована в контрактах.** Вона не потребує рефакторингу — потребує
формалізації як product/ops-плану і дисципліни в тому, що саме деплоїться
і що саме будується у фронтенді на v1.

Доказ по коду (не по коментарях — по факту, що саме читають контракти):

| Що | Файл / рядок | Поведінка до 244 користувачів |
|---|---|---|
| Поріг місткості вузла | `CouncilRankingEpoch.sol:78` `NODE_CAPACITY = 244` | Константа, з якої все стартує |
| Прапор "вузол переповнений" | `CouncilRankingEpoch.sol:130` `mapping nodeOverflowed` | Дефолт `false` для КОЖНОГО ключа, доки хтось явно не викличе `submitNodeStatus` |
| Розподіл коштів (Treasury) | `Treasury.sol:511` `rankingEpoch.activeLevelsForAccount(payer)` | Повертає `1` (лише EARTH), поки `nodeOverflowed[EARTH]==false` → **100% "спільнотної" частки йде в один глобальний пул**, каскад по гексагонах не виконується |
| Голосування (DaoGovernor) | `DaoGovernor.sol:184` `set=false` = "звичайна EARTH-масштабна пропозиція" | `propose()` без жодної гео-перевірки працює завжди; `proposeScoped()` заблокований `require(rankingEpoch.nodeOverflowed(...))` |
| Shield/Council SBT | `ShieldSBT.mint()`, `CouncilSBT.mint()` | Самостійний мінт за Influence + стаж + humanity-score. **Жодної залежності** від рейтингів/гексагонів |
| Permissionless подача рейтингу | `OptimisticEpochSubmission.sol` | Не деплоїться основним `script/Deploy.s.sol` взагалі — окремий `script/DeployOptEpoch.s.sol`, запускається пізніше |

Наслідок: **жодних змін у Solidity-коді для v1 не потрібно**. Потрібне
дисципліноване рішення "що деплоїмо", "яку роль кому видаємо" і "що НЕ
будуємо у фронтенді", доки реальна кількість учасників не сягне 244.

---

## 1. Мапінг вашого запиту на контракти

### Залишаємо в v1 (централізована фаза)

| Ваша вимога | Контракт(и) | Коментар |
|---|---|---|
| Гонорари, розподіл 50/50 | `TipJar.sol` (`councilAuthorBps=5000`, `shieldAuthorBps=5000`, `noneAuthorBps=5000`) | Спліт автор/пул уже 50/50 за замовчуванням, керується DAO в межах [50%;95%] автору |
| Казна / отримання коштів | `Treasury.sol` | Без змін коду. Гео-маршрутизація автоматично звужується до 1 глобального рівня, поки вузол EARTH не переповнений |
| Отримання Shield-статусу | `ShieldSBT.sol` | Самостійний мінт (Influence + humanity + `PolicyConsentGate`) |
| Отримання Consul-статусу | `CouncilSBT.sol` | Самостійний мінт (вищий поріг Influence/humanity) |
| Модерація | `DisciplineModule.sol` | Санкції за докази порушень, спалює SBT через `burnByDiscipline` |
| Голосування | `DaoGovernor.sol` + `DaoTimelock.sol` | Тільки звичайні (`propose`), НЕ гео-скоуповані пропозиції |
| Визначення людяності | `HumanityGate.sol` + `PassportAdapter.sol` (+ `MockHumanityProvider.sol` на testnet) | Провайдер-агностичний гейт |
| Прийняття політики прав людини | `PolicyConsentGate.sol` | Абстрактний гейт, успадкований `ShieldSBT`/`LocationRegistry` |
| Накопичення Influence (для збереження даних) | `InfluenceRegistry.sol` | Працює з дня 1, історія балів зберігається незалежно від фази |

### Переносимо на v2 (після 244 — активація рейтингів/гексагонів)

| Що відкладаємо | Контракт(и) | Чому можна відкласти без шкоди |
|---|---|---|
| Гео-локація / H3-гексагони | `LocationRegistry.sol`, `H3Utils.sol` | Деплоїться разом з рештою (потрібен Treasury/DaoGovernor як адреса), але **функціонал не використовується**, доки користувачі не подають ZK-доказ локації |
| ZK-верифікація гілки предків | `HexAncestryVerifier.sol` (`Groth16Verifier`) | Задеплоєний, але не викликається без фронтенд-флоу подачі локації |
| Каскадне ранжування/seats | `CouncilRankingEpoch.sol` — сама логіка каскаду (`submitSeatAssignments`, `effectiveHexFor`, `verifySeatLeaf`) | Контракт деплоїться (потрібен як адреса-залежність), але ці функції просто не викликаються |
| Permissionless подача епох | `OptimisticEpochSubmission.sol` | **Не деплоїти взагалі в v1** — окремий скрипт, окреме голосування ДАО пізніше |
| Merkle-бібліотека для seats | `SeatMerkleLib.sol` | Використовується лише всередині `CouncilRankingEpoch`/`OptimisticEpochSubmission` |
| Гео-скоуповані пропозиції | `DaoGovernor.proposeScoped()` | Функція в контракті є, але заблокована `nodeOverflowed`; просто не показувати в UI |

---

## 2. Чому дані НІКОЛИ не втрачаються при переході v1 → v2

Це не міграція в класичному сенсі (немає редеплою Treasury/SBT/Influence) —
**той самий набір контрактів працює з дня 1 до і після 244 користувача**.

- `InfluenceRegistry`, `ShieldSBT`, `CouncilSBT`, `Treasury` — деплояться
  **один раз**, на генезисі v1, і ніколи не змінюють адресу.
- Перехід у "фазу 2" — це не деплой нових контрактів для існуючої
  функціональності, а **одна операційна дія**: викликати
  `CouncilRankingEpoch.submitNodeStatus(...)` (роль `EPOCH_SUBMITTER_ROLE`)
  з реальними даними про >244 живих людей → `nodeOverflowed[EARTH] = true`.
- Після цього виклику **та сама** функція `Treasury._routeTax()` і **той
  самий** `DaoGovernor` автоматично починають працювати за каскадною
  логікою — без жодного forced-migration кроку для користувачів.
- Єдине, що деплоюється додатково у v2 — `OptimisticEpochSubmission.sol`
  (щоб decentralized-увати САМЕ подачу рейтингу), через окрему DAO-пропозицію
  (`script/DeployOptEpoch.s.sol` + `grantRole(EPOCH_SUBMITTER_ROLE, ...)`).

Тобто вимога "існуючі користувачі зберігають усі свої дані на випадок
міграції" виконується **автоматично**, тому що реальної міграції немає —
є лише активація вже задеплоєної, але сплячої логіки.

---

## 3. Версійність проєкту

Семантичне версіонування протоколу (не npm-пакета):
`MAJOR.MINOR.PATCH-фаза`, де MAJOR = зміна фази активації, MINOR = зміна
параметрів через голосування ДАО (без редеплою), PATCH = операційні нотатки.

| Версія | Назва | Що це технічно |
|---|---|---|
| **v1.0.0-genesis** | Mainnet Genesis (Centralized) | `forge script script/Deploy.s.sol:Deploy --broadcast` на Arbitrum One. `EPOCH_SUBMITTER` = довірений ops-мультисиг, який **свідомо не викликає** `submitNodeStatus`, доки немає реальних 244 учасників. `OptimisticEpochSubmission` НЕ деплоїться |
| v1.1.x … v1.N.x | Параметричні релізи | Зміни через DAO-голосування (без редеплою): `TipJar.setAuthorBps`, `Treasury.perTxCapBps/rollingCapBps`, `ShieldSBT/CouncilSBT.setMinHumanityScore`, `DaoGovernor` (votingDelay/Period — потребують нового Governor, якщо міняти константи; параметризовані значення — без редеплою) |
| **v2.0.0-geo-activation** | Активація гео-каскаду | Той самий деплой v1.0.0. Операційна дія: `EPOCH_SUBMITTER` викликає `submitNodeStatus(EARTH, реальна_кількість>244, …)`. Гео-скоуповані пропозиції та каскадна маршрутизація податку вмикаються автоматично для всіх існуючих і нових користувачів |
| v2.1.0-permissionless-epochs | Децентралізація подачі рейтингу | `forge script script/DeployOptEpoch.s.sol` + DAO-пропозиція `rankingEpoch.grantRole(EPOCH_SUBMITTER_ROLE, address(optEpoch))` |
| v2.x | Фронтенд гео-функцій | ZK location declare (`zk/frontend-example/locationFlow.js`), карта гексагонів, seat-вибори, `proposeScoped()` в UI |

---

## 4. Покроковий план реалізації

### Крок 1 — Заморозити product-скоуп v1 (product/ops, без коду)
Зафіксувати, що у фронтенді/додатку v1 **не** будується:
декларація локації, карта гексагонів, seat-вибори, `proposeScoped`, будь-яке
UI навколо `CouncilRankingEpoch`/`LocationRegistry`. Це єдине, що реально
"спрощує" продукт для користувача — контракти лишаються ті самі.

### Крок 2 — Деплой v1.0.0 (без змін у Solidity)
```bash
export TESTNET=false
export PRIVATE_KEY=...
export GUARDIAN_MULTISIG=0x...        # реальний Safe, НЕ EOA
export EPOCH_SUBMITTER=0x...          # довірений ops-мультисиг (2-з-3+)
export PASSPORT_DECODER=0x...         # Human Passport Decoder на Arbitrum One
export USDC_ADDRESS=0x...             # за потреби USDT/DAI
forge script script/Deploy.s.sol:Deploy --rpc-url arbitrum_one --broadcast --verify -vvvv
```
`script/DeployOptEpoch.s.sol` **не запускати** — свідомо відкладено до v2.

### Крок 3 — Ops-правило для EPOCH_SUBMITTER
Задокументувати і підписати мультисигом-власниками: `submitNodeStatus`
для гілки EARTH викликається **лише після** незалежної звірки реальної
кількості верифікованих (humanity-gated) учасників ≥ 244. Це єдина дія,
яка перемикає фазу — тому вона має бути під найсуворішим контролем
(рекомендовано Safe 2-з-3, окремий від `GUARDIAN_MULTISIG`).

### Крок 4 — Перша DAO-пропозиція після генезису
Обов'язкові кроки (вже закладені в `Deploy.s.sol` як "pending"):
- `humanityGate.acceptGovernor()` — прийняти governor від деплоєра.
- `treasury.setTipJarRole(address(tipJar), true)` — інакше пул-частка
  tip-ів накопичується в escrow всередині `TipJar` (safe fallback, гроші не
  втрачаються, просто чекають).
- Після цього — permissionless `tipJar.sweepEscrowToTreasury(token)`.

### Крок 5 — Моніторинг росту до 244
Відстежувати `shieldSBT.activeSupply()` / `councilSBT.activeSupply()` як
проксі реальної залученості. Ніяких контрактних дій не потрібно — система
вже коректно працює централізовано.

### Крок 6 — Активація v2.0.0 (за фактом ≥244 реальних учасників)
1. `EPOCH_SUBMITTER` викликає `rankingEpoch.submitNodeStatus(...)` для
   EARTH з підтвердженою кількістю.
2. Публічно підтвердити подію (`nodeOverflowed[EARTH]` стає `true`).
3. Розгорнути фронтенд гео-функцій (ZK-локація, карта, seats).
4. Опційно — DAO-пропозиція на деплой `OptimisticEpochSubmission` і
   передачу йому `EPOCH_SUBMITTER_ROLE` (v2.1.0).

---

## 5. Що НЕ чіпати (навмисно)

- Solidity-код контрактів — компілюється чисто, логіка вже відповідає
  вимозі. Зміни підвищують ризик для контракту, що тримає реальні кошти
  (`Treasury`), без потреби.
- `MockHumanityProvider`, `MockERC20`, `MockHexAncestryVerifier` —
  лишаються тестовими, на mainnet не деплояться (`cfg.testMode=false` вже
  це гарантує в `Deploy.s.sol`).

## 6. Ризики й рекомендації

- **`EPOCH_SUBMITTER` — найчутливіша роль у фазі 1.** Це єдина точка,
  здатна достроково "увімкнути" каскад. Обов'язково мультисиг, обов'язково
  публічний ops-регламент, коли саме викликати `submitNodeStatus`.
- Перед mainnet-деплоєм — прогнати `forge test` (зокрема
  `test/FullCycle.t.sol`, `test/ActiveSupply.t.sol`,
  `test/TipJarFeeAndOracle.t.sol`) в реальному Foundry-оточенні (не було
  доступне в цьому середовищі аналізу — мережевий доступ обмежений
  реєстрами пакетів, не RPC-нодами).
- `test/NetworkStage.t.sol`, `test/LocationRankingEpoch.t.sol`,
  `test/ScopedProposals.t.sol`, `test/InfluenceSnapshot.t.sol` — стосуються
  фази 2; для v1-релізу не блокуючі, але варто тримати зеленими для
  готовності до v2.
