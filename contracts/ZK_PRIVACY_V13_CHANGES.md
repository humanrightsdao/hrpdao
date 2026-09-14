# v13: Перехід з Groth16 на PLONK для HexAncestryVerifier

Причина: `HexAncestryVerifier.sol` (Groth16) у версії v12 був згенерований
ОДНООСІБНО, локально, без справжньої multi-party trusted-setup церемонії
(див. `zk/README.md`, розділ "Найважливіше застереження"). Це створювало
теоретичну можливість підробити ZK-доказ приватності локації — модуль, від
якого залежать `CouncilRankingEpoch`, `Treasury._routeTax()` і
`DaoGovernor._isWithinTerritory()`.

PLONK (на відміну від Groth16) не потребує circuit-specific церемонії —
досить universal Powers-of-Tau, який можна ПЕРЕВИКОРИСТАТИ з уже
завершеної, справді масової публічної церемонії (наприклад, той самий
`powersOfTau28_hez_final_XX.ptau`, який Polygon Hermez використовує у
своєму production zkEVM — 54 реальні контрибутори + опублікований beacon,
хеші для звірки лежать у офіційному README `snarkjs`).

## Чому не FFLONK

`snarkjs` офіційно позначає FFLONK як "Beta version". Для протоколу, що йде
на mainnet із реальними коштами (маршрутизація податку) і правами голосу
(територіальне голосування), обрано PLONK — production-стабільний,
використовується Aztec/Polygon Hermez у бойових умовах.

## Зміни в контрактах

### `src/HexAncestryVerifier.sol` — перегенеровано повністю
Контракт `Groth16Verifier` → `PlonkVerifier`. Згенеровано командою
`snarkjs zkey export solidityverifier` з нового `.zkey`, побудованого
через `snarkjs plonk setup` на ТОМУ САМОМУ circom-контурі
(`zk/circuits/HexAncestry.circom` — без жодних змін самої схеми, лише
арифметизація R1CS→PLONK-gates, 398→2910 constraints).

⚠️ Файл у цьому вигляді використовує ЛОКАЛЬНИЙ ТЕСТОВИЙ ptau — див.
розділ "Перед mainnet" нижче.

### `src/LocationRegistry.sol`
- `IHexAncestryVerifier.verifyProof()`: сигнатура змінена з
  `(uint256[2] _pA, uint256[2][2] _pB, uint256[2] _pC, uint256[3] _pubSignals)`
  на `(uint256[24] _proof, uint256[3] _pubSignals)` — формат, у якому
  snarkjs генерує PLONK-докази (один плаский масив замість трьох точок
  Groth16). Кількість і порядок публічних сигналів (`commitment`, `level`,
  `branchId`) — БЕЗ ЗМІН.
- `revealAncestor(int8 level, uint64 branchId, uint256[2] a, uint256[2][2] b, uint256[2] c)`
  → `revealAncestor(int8 level, uint64 branchId, uint256[24] proof)`.
  Решта логіки функції (перевірка `level`/`branchId`, читання
  `commitmentOf`, запис у `revealedAncestorOf`/`_revealedAncestorHistory`,
  оновлення `deepestRevealedLevel`, подія `AncestorRevealed`) — без змін.

### `src/MockHexAncestryVerifier.sol`
Сигнатура `verifyProof()` оновлена під новий інтерфейс (як і раніше,
`alwaysValid` — не робить жодної реальної перевірки, лише для
testnet/local).

### `script/Deploy.s.sol`
`new Groth16Verifier()` → `new PlonkVerifier()` у гілці `!cfg.testMode`.
Коментар оновлено з посиланням на цей файл замість `ZK_PRIVACY_V12_CHANGES.md`.

### Тести
`test/LocationRankingEpoch.t.sol`, `test/ScopedProposals.t.sol`:
`DUMMY_A`/`DUMMY_B`/`DUMMY_C` (Groth16-формат) замінено на єдиний
`DUMMY_PROOF` (`uint256[24]`, за замовчуванням нулі — `MockHexAncestryVerifier`
ігнорує вміст). Виклики `revealAncestor()` оновлені під нову сигнатуру.
Жодних змін у самій тестовій логіці/асертах.

`CouncilRankingEpoch.sol`, `Treasury.sol`, `DaoGovernor.sol`,
`OptimisticEpochSubmission.sol` — БЕЗ ЗМІН: усі вони читають вже
ПЕРЕВІРЕНИЙ результат через `locationRegistry.getRevealedAncestor()`, не
викликають верифікатор напряму, тож заміна Groth16→PLONK їх не зачіпає.

## Як перевірено (не лише компіляцією)

1. Реально встановлено `snarkjs` (npm), прогнано повний пайплайн на
   справжньому `zk/build/HexAncestry.r1cs`:
   `powersoftau new/contribute/beacon/prepare phase2` → `plonk setup` →
   `zkey export verificationkey` → `zkey export solidityverifier`.
2. Обчислено коректний Poseidon-коміт і валідний witness (реальний
   `hexId`/`salt`, що задовольняє всі constraint'и контуру, включно з
   `mode===1`, `levelCheck`, `reconstructed===branchId`).
3. Згенеровано реальний PLONK-доказ (`snarkjs plonk prove`), перевірено
   офчейн (`snarkjs plonk verify` → `OK!`).
4. Задеплоєно згенерований `PlonkVerifier` на реальний локальний EVM
   (Foundry `anvil`) і викликано `verifyProof()` з реальним доказом і
   реальними публічними сигналами через `cast call` — **`true`**.
5. Негативний тест: підмінений `branchId` (+1) у публічних сигналах —
   `verifyProof()` коректно повертає **`false`**, доказ не проходить.
6. Повна компіляція проєкту (`forge build`, реальний `solc 0.8.24`,
   `cancun`, `optimizer=true, runs=200, via_ir=true`) — чисто.
7. Повна тестова база (`forge test`) — **76/76 passed** (56 базових + 20
   міграційних), без жодної зміни в самій бізнес-логіці тестів окрім
   формату виклику `revealAncestor()`.
8. Повторний mainnet-режим dry-run через `script/Deploy.s.sol`
   (`TESTNET=false`, з усіма обов'язковими env: `GUARDIAN_MULTISIG`,
   `EPOCH_SUBMITTER`, `PASSPORT_DECODER`, `USDC/USDT/DAI_ADDRESS`) на
   реальному локальному EVM — увесь стек, включно з новим
   `PlonkVerifier`, деплоїться без revert.

## ⚠️ Перед mainnet — ОБОВ'ЯЗКОВО

Поточний `src/HexAncestryVerifier.sol` згенерований із **локального
тестового** ptau (2 симульовані контрибуції в ізольованому середовищі
перевірки) — годиться ЛИШЕ для підтвердження працездатності пайплайна.
Перед реальним деплоєм:

1. Завантажити РЕАЛЬНИЙ публічний universal ptau — наприклад,
   `powersOfTau28_hez_final_12.ptau` з офіційного README `snarkjs`
   (https://github.com/iden3/snarkjs) — той самий, що Polygon Hermez
   використовує у своєму production zkEVM. Обов'язково звірити
   blake2b-хеш файлу з опублікованим у таблиці README.
2. `snarkjs plonk setup zk/build/HexAncestry.r1cs <РЕАЛЬНИЙ_ptau.ptau> HexAncestry_plonk_final.zkey`
3. `snarkjs zkey export solidityverifier HexAncestry_plonk_final.zkey src/HexAncestryVerifier.sol`
   (замінити файл повністю)
4. Повторити кроки 2-5 з розділу "Як перевірено" вище — з РЕАЛЬНИМ
   доказом на РЕАЛЬНОМУ фінальному verifier'і, не лише компіляцією.
5. **Зміряти реальну вартість газу `verifyProof()` на публічному тестнеті
   (Sepolia)**. Виміряне в цьому середовищі значення (~62.5k газу) було
   аномально низьким порівняно з теоретичним мінімумом (сам precompile
   `ecPairing` коштує ≥113k газу за 2 паринги, які цей контракт викликає)
   — ймовірний артефакт конкретної збірки `anvil`/`revm`, використаної
   під час перевірки. НЕ використовуйте це число для фінансового
   планування без незалежного підтвердження на публічній мережі.
6. Прогнати `forge test` локально з фінальним верифікатором — переконатись,
   що всі 76 тестів (і будь-які нові, написані відтоді) досі проходять.

## Файли в цьому наборі

```
src/HexAncestryVerifier.sol       (перегенеровано: Groth16Verifier → PlonkVerifier)
src/LocationRegistry.sol          (інтерфейс + revealAncestor() під новий формат доказу)
src/MockHexAncestryVerifier.sol   (сигнатура під новий інтерфейс)
script/Deploy.s.sol               (new Groth16Verifier() → new PlonkVerifier())
test/LocationRankingEpoch.t.sol   (DUMMY_A/B/C → DUMMY_PROOF)
test/ScopedProposals.t.sol        (DUMMY_A/B/C → DUMMY_PROOF)
ZK_PRIVACY_V13_CHANGES.md         (цей файл)
```

## Як застосувати

1. Скопіювати `src/HexAncestryVerifier.sol`, `src/LocationRegistry.sol`,
   `src/MockHexAncestryVerifier.sol` поверх відповідних файлів у
   `contracts/src/`.
2. Скопіювати `script/Deploy.s.sol` поверх `contracts/script/Deploy.s.sol`.
3. Скопіювати `test/LocationRankingEpoch.t.sol`,
   `test/ScopedProposals.t.sol` поверх відповідних файлів у
   `contracts/test/`.
4. Скопіювати `ZK_PRIVACY_V13_CHANGES.md` у корінь `contracts/`.
5. `forge build` — має пройти чисто.
6. `forge test` — очікується 76/76 passed (той самий результат, що й
   до цієї зміни, оскільки нова інтеграція не зачіпає бізнес-логіку).
7. Виконати розділ "Перед mainnet — ОБОВ'ЯЗКОВО" вище до реального
   деплою.
