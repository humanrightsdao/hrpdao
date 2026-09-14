# ZK-приватність гексагонів локації (Гео-реформа v12, верифікатор — PLONK з v13)

Ця директорія містить повний, РЕАЛЬНО СКОМПІЛЬОВАНИЙ і ПЕРЕВІРЕНИЙ
ZK-SNARK (PLONK) пайплайн, що ховає точний H3-гексагон учасника від
публічного перегляду, дозволяючи смарт-контрактам (`CouncilRankingEpoch`,
`Treasury`, `DaoGovernor`) і надалі коректно рахувати каскад/маршрутизацію
податку/територію голосування.

> Схема з v12 (Groth16) і схема з v13 (PLONK) доводять РІВНО те саме на
> тому самому контурі `HexAncestry.circom` — змінилась лише схема
> доведення (арифметизація й формат верифікатора/доказу), не логіка.
> Деталі переходу — `../ZK_PRIVACY_V13_CHANGES.md`.

## ⚠️ Найважливіше застереження ПЕРЕД усім іншим

**Файл `src/HexAncestryVerifier.sol`, який реально деплоїться, і зараз
згенерований з ЛОКАЛЬНОГО, ОДНОРАЗОВОГО, НЕБЕЗПЕЧНОГО (для продакшн)
Powers-of-Tau ptau** — усі кроки (`powersoftau new` → `contribute` →
`prepare phase2` → `plonk setup` → export) виконано в одному
ізольованому середовищі, без реальної множинної (multi-party) церемонії.
Це означає: **особа, що проводила цей тестовий setup, теоретично
могла б підробити ZK-доказ**, доки цей файл не замінено.

PLONK (на відміну від Groth16 у v12) не потребує circuit-specific
церемонії — досить universal Powers-of-Tau, який можна ПЕРЕВИКОРИСТАТИ
з уже завершеної публічної церемонії, замість того щоб проводити власну
multi-party церемонію з нуля. Реальний файл (`powersOfTau28_hez_final_12.ptau`
— той самий, що Polygon Hermez використовує у своєму production zkEVM)
**уже завантажено**, і кандидат-`.zkey` на його основі **уже
згенеровано й, судячи з наявних артефактів (`proof.json`, `calldata.txt`),
протестовано**. Але останній крок — `snarkjs zkey export
solidityverifier` з цього нового `.zkey` і заміна ним
`src/HexAncestryVerifier.sol` — **ще не виконаний**. Перед mainnet
ОБОВ'ЯЗКОВО довести цей крок до кінця (команди — розділ "Як
перекомпілювати" нижче) і повторити повну перевірку реальним доказом на
новому файлі (`../ZK_PRIVACY_V13_CHANGES.md`, розділ "Як перевірено").

## Що тут є

```
zk/
├── circuits/
│   └── HexAncestry.circom       — сама схема (Circom 2.1.9, без змін з v12)
├── build/
│   ├── HexAncestry.r1cs         — скомпільована схема (constraint system)
│   ├── HexAncestry_js/          — WASM-witness-генератор (для браузера)
│   ├── pot10_final.ptau         — Powers-of-Tau (2^10, ЛОКАЛЬНИЙ, v12-реліквія)
│   └── HexAncestryVerifier.sol  — ЕТАЛОН, версія v12 (Groth16) — ЗАСТАРІЛИЙ,
│                                    не відповідає поточному src/HexAncestryVerifier.sol
├── HexAncestry_plonk_final.zkey — PLONK proving key, кандидат на основі
│                                    РЕАЛЬНОГО ptau (див. застереження вище)
└── frontend-example/
    └── locationFlow.js          — приклад інтеграції "кнопка → ZK"
```

`src/HexAncestryVerifier.sol` і `src/MockHexAncestryVerifier.sol` —
робочі копії для компіляції разом з рештою проєкту (Foundry компілює
лише `src/`).

## Що доводить схема (`HexAncestry.circom`)

Публічні входи: `commitment`, `level` (0–10), `branchId`.
Приватні входи: `hexId`, `salt`.

Доводить: **"я знаю `hexId` і `salt` такі, що (1) Poseidon(hexId,salt) ==
commitment, і (2) предок hexId на резолюції `level` дорівнює `branchId`"**
— без розкриття самого `hexId`. Формула реконструює предка НАПРЯМУ (той
самий mode/base cell, resolution=`level`, digit-групи 1..level лишаються,
глибші стають "unused"=7) — не ітеративним "здиранням" рівнів, як
`H3Utils.parentOf()`, тому схема маленька.

Реально скомпільовано, реально прогнано:
```
circom compiler 2.1.9
template instances: 76
public inputs: 3, private inputs: 2
```
R1CS-контур (Groth16, v12): **398 non-linear constraints**.
Той самий контур в PLONK-арифметизації (v13): **2910 gates** — більше
через відмінну модель обчислення PLONK, доводить те саме твердження.

Тестовий доказ згенеровано й ПЕРЕВІРЕНО через `snarkjs plonk verify` —
`OK!` (і офчейн, і викликом `verifyProof()` на реальному локальному EVM
через `cast call` — деталі в `../ZK_PRIVACY_V13_CHANGES.md`).

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
   `revealAncestor(level, branchId, proof)` (з v13 — `proof` це один
   плаский `uint256[24]`, формат PLONK; публічні сигнали `commitment`/
   `level`/`branchId` не змінились). Контракт перевіряє ЛИШЕ
   математичний доказ; сире значення так і лишається невідомим —
   розкривається РІВНО branchId на рівні level, нічого більше.
3. Усі інші контракти (`CouncilRankingEpoch.effectiveHexFor`,
   `Treasury._routeTax`, `DaoGovernor._isWithinTerritory`) читають
   `LocationRegistry.revealedAncestorOf[account][level]` — вже
   ЗАВЕРИФІКОВАНЕ й закешоване значення — замість обчислення "на льоту"
   з сирого hexId через `H3Utils.ancestorOf()`.

### Наслідок дизайну (свідомий, не побічний ефект)

Глибина видимості ПОВНІСТЮ під контролем власника — розкривається РІВНО
те, що потрібно (типово — до поточного активного рівня каскаду в своєму
регіоні), а не все одразу. Найглибше значення (рівень 10, ~65–150м)
НІКОЛИ не з'являється в жодному ончейн-полі, доки власник явно НЕ
розкриє САМЕ рівень 10 — а типово йому це й не потрібно.

### Важливе технічне обмеження, яке варто розуміти

Оскільки СТОРОННІ контракти (напр. `Treasury` під час маршрутизації
tip-донату від анонімного тіпера) читають `revealedAncestorOf`, а не
рахують "на льоту" — **маршрутизація податку для когось працює ЛИШЕ до
того рівня, який ця людина сама вже розкрила**. Якщо автор поста ще
нічого не розкрив (лише має комітмент) — `activeLevelsForAccount`/
`effectiveHexFor` повертають рівень EARTH, незалежно від того, наскільки
густо населений його реальний регіон. Це природний, очікуваний наслідок:
privacy має ціну — розкриття рівня є ПОПЕРЕДНЬОЮ УМОВОЮ участі на цьому
рівні, а не автоматичним побічним ефектом самої декларації.

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
   через `snarkjs.plonk.fullProve()` (WASM, у браузері, секунди) і
   викликає `revealAncestor(level, branchId, proof)`.

Мінімальні залежності фронтенду: `snarkjs`, `circomlibjs`, `ethers`
(чи `viem`) + WASM/zkey-файли, роздані як статичні ассети
(`/public/zk/HexAncestry.wasm`, `/public/zk/HexAncestry_plonk_final.zkey`).

## Як перекомпілювати схему (якщо змінюється логіка контуру)

```bash
circom circuits/HexAncestry.circom --r1cs --wasm --sym -o build -l node_modules/circomlib/circuits
```

## Як фіналізувати верифікатор перед mainnet (те, що ще НЕ зроблено — див. застереження вгорі)

```bash
# 1. Реальний публічний ptau вже завантажено — звірити ще раз blake2b-хеш
#    з офіційною таблицею snarkjs (https://github.com/iden3/snarkjs) перед використанням:
#    powersOfTau28_hez_final_12.ptau

# 2. Кандидат .zkey вже згенеровано з цього ptau (HexAncestry_plonk_final.zkey).
#    Якщо перегенеровуєте з нуля:
snarkjs plonk setup build/HexAncestry.r1cs powersOfTau28_hez_final_12.ptau HexAncestry_plonk_final.zkey

# 3. ЦЕЙ КРОК ЩЕ НЕ ВИКОНАНО — обов'язково перед mainnet:
snarkjs zkey export verificationkey HexAncestry_plonk_final.zkey verification_key_final.json
snarkjs zkey export solidityverifier HexAncestry_plonk_final.zkey ../src/HexAncestryVerifier.sol

# 4. Повторити повну перевірку РЕАЛЬНИМ доказом на новому файлі —
#    не лише компіляцією (див. ../ZK_PRIVACY_V13_CHANGES.md, розділ "Як перевірено").
```

Стара (v12, Groth16) послідовність — лише для довідки, більше не
використовується:
```bash
snarkjs powersoftau new bn128 10 build/pot10_0000.ptau
snarkjs powersoftau contribute build/pot10_0000.ptau build/pot10_0001.ptau
snarkjs powersoftau prepare phase2 build/pot10_0001.ptau build/pot10_final.ptau
snarkjs groth16 setup build/HexAncestry.r1cs build/pot10_final.ptau build/HexAncestry_0000.zkey
```

## Компонент, що НЕ входить до цього кроку

- Реальна multi-party trusted setup церемонія — ptau вже публічний і
  реальний (Hermez), але **фінальний крок заміни верифікатора цим
  ptau ще не виконаний** (див. застереження вгорі).
- Оновлення `src/DisciplineModule.sol` — санкції й надалі не гео-
  прив'язані (узгоджено раніше), туди ZK не заходить.
- Динамічний $→Influence коефіцієнт (`InfluenceRegistry.networkStage()`) —
  не залежить від конкретного гексагону жодного учасника (лише від
  глобальної кількості Консулів), тому ZK-приватність його не зачіпає.
