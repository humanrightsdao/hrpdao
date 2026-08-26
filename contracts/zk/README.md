# ZK-приватність гексагонів локації (Гео-реформа v12)

Ця директорія містить повний, РЕАЛЬНО СКОМПІЛЬОВАНИЙ і ПЕРЕВІРЕНИЙ
ZK-SNARK (Groth16) пайплайн, що ховає точний H3-гексагон учасника від
публічного перегляду, дозволяючи смарт-контрактам (`CouncilRankingEpoch`,
`Treasury`, `DaoGovernor`) і надалі коректно рахувати каскад/маршрутизацію
податку/територію голосування.

## ⚠️ Найважливіше застереження ПЕРЕД усім іншим

**Verification key й Solidity-верифікатор у цьому репозиторії згенеровані
ЛОКАЛЬНОЮ, ОДНОРАЗОВОЮ, НЕБЕЗПЕЧНОЮ (для продакшн) Powers-of-Tau
церемонією** — я сам виконав усі кроки (`snarkjs powersoftau new` →
`contribute` → `prepare phase2` → `groth16 setup` → `zkey contribute`) в
одному ізольованому середовищі, без жодної реальної множинної
(multi-party) церемонії. Це означає: **я один теоретично знаю "toxic
waste" цього конкретного setup** і міг би (гіпотетично) підробити доказ.
Для тестового деплою це прийнятно (сама механіка перевірена й працює
коректно). **Перед mainnet — ОБОВ'ЯЗКОВО**:
- або приєднатися до вже існуючої публічної multi-party Powers-of-Tau
  церемонії (напр. Hermez/PSE) і перегенерувати `HexAncestry_final.zkey`
  з НЕЇ, а не з локального `pot10_final.ptau` цього репо;
- або перейти на PLONK/Halo2 (без per-схемного trusted setup узагалі) —
  дорожча перевірка ончейн, але прибирає цю категорію ризику повністю.

Обидва варіанти вимагають перегенерації `src/HexAncestryVerifier.sol` і
повторного деплою.

## Що тут є

```
zk/
├── circuits/
│   └── HexAncestry.circom       — сама схема (Circom 2.1.9)
├── build/
│   ├── HexAncestry.r1cs         — скомпільована схема (constraint system)
│   ├── HexAncestry_js/          — WASM-witness-генератор (для браузера)
│   ├── HexAncestry_final.zkey   — proving key (ЛОКАЛЬНИЙ setup, див. вище)
│   ├── verification_key.json    — verification key у JSON (для офчейн-перевірки)
│   ├── pot10_final.ptau         — Powers-of-Tau (2^10, ЛОКАЛЬНИЙ, для відтворюваності)
│   └── HexAncestryVerifier.sol  — ЕТАЛОН (те саме, що src/HexAncestryVerifier.sol)
└── frontend-example/
    └── locationFlow.js          — приклад інтеграції "кнопка → ZK" (детально нижче)
```

`src/HexAncestryVerifier.sol` і `src/MockHexAncestryVerifier.sol` —
робочі копії для компіляції разом з рештою проєкту (Foundry компілює
лише `src/`).

## Що доводить схема (`HexAncestry.circom`)

Публічні входи: `commitment`, `level` (0-10), `branchId`.
Приватні входи: `hexId`, `salt`.

Доводить: **"я знаю `hexId` і `salt` такі, що (1) Poseidon(hexId,salt) ==
commitment, і (2) предок hexId на резолюції `level` дорівнює `branchId`"**
— без розкриття самого `hexId`. Формула реконструює предка НАПРЯМУ (той
самий mode/base cell, resolution=`level`, digit-групи 1..level лишаються,
глибші стають "unused"=7) — не ітеративним "здиранням" рівнів, як
`H3Utils.parentOf()`, тому схема маленька: **398 non-linear constraints**
— дешево й швидко доводити навіть у браузері.

Реально скомпільовано, реально прогнано:
```
circom compiler 2.1.9
template instances: 76
non-linear constraints: 398
public inputs: 3, private inputs: 2
```
Тестовий доказ згенеровано й ПЕРЕВІРЕНО через `snarkjs groth16 verify` —
`OK!`.

## Архітектурне рішення: commit-and-reveal, НЕ "приховано назавжди"

Одразу технічне уточнення, яке важливо розуміти: **смарт-контракт
принципово НЕ МОЖЕ "розшифрувати щось, але не показати"** — усе, що
відбувається в EVM (включно зі storage, calldata, проміжними
обчисленнями), видиме будь-якому вузлу мережі. Тому "приховане
розшифрування ончейн" неможливе за визначенням публічного блокчейну.

Натомість реалізовано **commit-and-reveal**:
1. `LocationRegistry.setLocationCommitment(commitment)` — комітмент
   зберігається ЗАМІСТЬ сирого hexId. Сире значення НІКОЛИ не потрапляє
   ончейн — ні в цей момент, ні пізніше.
2. Коли (і ЛИШЕ коли) якийсь рівень-предок потрібен для реальної
   взаємодії (голосування на певній території, маршрутизація частки
   податку) — власник ГЕНЕРУЄ ZK-ДОКАЗ ЛОКАЛЬНО і викликає
   `revealAncestor(level, branchId, proof)`. Контракт перевіряє ЛИШЕ
   математичний доказ; сире значення так і лишається невідомим —
   розкривається РІВНО branchId на рівні level, нічого більше.
3. Усі інші контракти (`CouncilRankingEpoch.effectiveHexFor`,
   `Treasury._routeTax`, `DaoGovernor._isWithinTerritory`) тепер читають
   `LocationRegistry.revealedAncestorOf[account][level]` — вже
   ЗАВЕРИФІКОВАНЕ й закешоване значення — замість обчислення "на льоту"
   з сирого hexId через `H3Utils.ancestorOf()`.

### Наслідок дизайну (свідомий, не побічний ефект)

Глибина видимості ПОВНІСТЮ під контролем власника — розкривається РІВНО
те, що потрібно (типово — до поточного активного рівня каскаду в своєму
регіоні), а не все одразу. Найглибше значення (рівень 10, ~65-150м)
НІКОЛИ не з'являється в жодному ончейн-полі, доки власник явно НЕ
розкриє САМЕ рівень 10 — а типово йому це й не потрібно.

### Важливе технічне обмеження, яке варто розуміти

Оскільки СТОРОННІ контракти (напр. `Treasury` під час маршрутизації
tip-donату від анонімного тіпера — Гео-реформа v11/v10) читають
`revealedAncestorOf`, а не рахують "на льоту" — **маршрутизація податку
для когось працює ЛИШЕ до того рівня, який ця людина сама вже розкрила**.
Якщо автор поста ще нічого не розкрив (лише має комітмент) —
`activeLevelsForAccount`/`effectiveHexFor` повертають рівень EARTH,
незалежно від того, наскільки густо населений його реальний регіон. Це
природний, очікуваний наслідок: privacy має ціну — розкриття рівня є
ПОПЕРЕДНЬОЮ УМОВОЮ участі на цьому рівні, а не автоматичним побічним
ефектом самої декларації.

## Frontend-інтеграція ("кнопка визначити локацію")

Детальний робочий приклад — `zk/frontend-example/locationFlow.js`. Коротко:

1. Користувач тисне "Визначити локацію" → браузерний Geolocation API →
   локально (у фронтенді, НЕ на бекенді) рахується точний H3-індекс
   (рекомендовано через офіційну `h3-js`).
2. Генерується випадковий `salt`, рахується `commitment =
   Poseidon(hexId, salt)` (через `circomlibjs`, у браузері).
3. `hexId` і `salt` зберігаються ЛОКАЛЬНО (localStorage/IndexedDB чи
   гаманець-сумісне сховище) — вони знадобляться для КОЖНОГО майбутнього
   розкриття. Якщо користувач їх втратить — доведеться заново
   декларувати (новий комітмент, стара точність губиться назавжди, з
   урахуванням `CHANGE_COOLDOWN`).
4. На ланцюг записується ЛИШЕ `commitment` — виклик
   `setLocationCommitment()`.
5. ОКРЕМА, за бажанням/потребою дія — `revealLevel()`: генерує ZK-доказ
   через `snarkjs.groth16.fullProve()` (WASM, у браузері, секунди) і
   викликає `revealAncestor(level, branchId, proof)`.

Мінімальні залежності фронтенду: `snarkjs`, `circomlibjs`, `ethers`
(чи `viem`) + WASM/zkey-файли, роздані як статичні ассети
(`/public/zk/HexAncestry.wasm`, `/public/zk/HexAncestry_final.zkey`).

## Як перекомпілювати схему (якщо змінюється логіка)

```bash
circom circuits/HexAncestry.circom --r1cs --wasm --sym -o build -l node_modules/circomlib/circuits

# Trusted setup (ЛИШЕ для тестування — див. застереження вгорі щодо mainnet):
snarkjs powersoftau new bn128 10 build/pot10_0000.ptau
snarkjs powersoftau contribute build/pot10_0000.ptau build/pot10_0001.ptau
snarkjs powersoftau prepare phase2 build/pot10_0001.ptau build/pot10_final.ptau
snarkjs groth16 setup build/HexAncestry.r1cs build/pot10_final.ptau build/HexAncestry_0000.zkey
snarkjs zkey contribute build/HexAncestry_0000.zkey build/HexAncestry_final.zkey

# Ключі й верифікатор:
snarkjs zkey export verificationkey build/HexAncestry_final.zkey build/verification_key.json
snarkjs zkey export solidityverifier build/HexAncestry_final.zkey build/HexAncestryVerifier.sol
cp build/HexAncestryVerifier.sol ../src/HexAncestryVerifier.sol
```

## Компонент, що НЕ входить до цього кроку

- Реальна multi-party trusted setup церемонія (лише локальна, тестова).
- Оновлення `src/DisciplineModule.sol` — санкції й надалі не гео-
  прив'язані (узгоджено раніше), туди ZK не заходить.
- Динамічний $→Influence коефіцієнт (`InfluenceRegistry.networkStage()`) —
  не залежить від конкретного гексагону жодного учасника (лише від
  глобальної кількості Консулів), тому ZK-приватність його не зачіпає.
