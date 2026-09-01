# Верифікація міграційних файлів — що перевірено, що виправлено

Цей файл документує перевірку `migration_contracts.zip` перед перенесенням
у проект. Дата перевірки: 2026-08-31.

## Метод перевірки

Зібрано повний `src/` (оригінальні контракти + три заміщені файли з архіву:
`ShieldSBT.sol`, `CouncilSBT.sol`, `InfluenceRegistry.sol` + нові
`src/migration/*.sol`) і реально скомпільовано через `solc 0.8.24`
(js/wasm-білд з npm) з ТИМИ Ж налаштуваннями, що в `foundry.toml` проєкту:
`evm_version=cancun`, `optimizer=true`, `optimizer_runs=200`, `via_ir=true`.

**Результат: 0 помилок, 0 попереджень**, повний білдовий граф (усі 25
файлів `src/` разом з міграційними доповненнями + окремо
`script/migration/ExportMigrationSnapshot.s.sol`) компілюється чисто.

`forge test` **не запускався** — мережевий доступ цього середовища
обмежений реєстрами пакетів (npm/pypi/crates/github), RPC-нод немає.
Обов'язково прогнати `forge test` (зокрема `test/FullCycle.t.sol`) у
реальному Foundry-оточенні перед реальним використанням.

## Перевірено вручну (не лише компілятором)

- **Diff трьох заміщених файлів проти оригіналів** (`ShieldSBT.sol`,
  `CouncilSBT.sol`, `InfluenceRegistry.sol`) — зміни чисто адитивні
  (нові функції/роль/подія), жоден існуючий рядок логіки не видалено і
  не змінено.
- **Сигнатури викликів** у `MigrationClaim.claim()` (`migrationSetInfluence`,
  `shieldSBT.migrationMint`, `councilSBT.migrationMint`) — точно
  відповідають визначенням у контрактах (підтверджено і компілятором
  через успішне зв'язування типів, і окремим grep-порівнянням).
- **`MigrationSnapshotLib.buildRoot()`** — ідентична вже перевіреній у
  проєкті `SeatMerkleLib.buildRoot()` (той самий алгоритм
  commutativeKeccak256 знизу вгору), звірено рядок-в-рядок.
- **Захист від double-claim / double-mint**: `MigrationClaim.claimed[msg.sender]`
  + `require(accountToTokenId[account]==0)` в `migrationMint` + 
  `require(influence[account]==0 && lastActivityTimestamp[account]==0)` в
  `migrationSetInfluence` — трирівневий захист від повторного виклику.
- **Council без Shield**: якщо офчейн-скрипт помилково згенерує листок з
  `hasCouncil=true, hasShield=false`, виклик `councilSBT.migrationMint()`
  сам revert-не (вимагає `shieldSBT.isMember(account)`) — це safe failure,
  не пошкодження стану.

## Знайдено і виправлено

### 1. `ExportMigrationSnapshot.s.sol` не збирав `humanityScore`/`policyConsentVersion`

**Проблема:** `MigrationSnapshotLib.leafHash()` (і, відповідно,
`MigrationClaim.claim()`) вимагають 10 полів, включно з `humanityScore`
та `policyConsentVersion`. Оригінальний скрипт з архіву формував CSV лише
з 8 полів — без цих двох. Офчейн-інструмент, що будує дерево з такого
CSV, не зміг би порахувати leaf, який збігається з тим, що перевіряє
on-chain `claim()`.

**Виправлення:** додано читання:
- `humanityScore` — через `shield.humanityGate().bestScore(account)`
  (ShieldSBT вже тримає `humanityGate` як `immutable`-адресу, окремий
  деплой/параметр не потрібен);
- `policyConsentVersion` — через `shield.consentedPolicyHash(account)`
  (ShieldSBT сам успадковує `PolicyConsentGate`, тому дані вже доступні
  напряму). **Увага:** це `bytes32`-хеш конкретної версії політики, на
  яку акаунт дав згоду (`consentedPolicyHash`), НЕ порядковий номер версії
  (`consentedVersion`, окремий `uint256`-мапінг) — саме такий тип
  (`bytes32`) очікує сигнатура `leafHash()`.

Формат CSV оновлено (в коментарі й у самому виводі):
`index,account,influence,lastActivityTimestamp,hasShield,shieldMintedAt,hasCouncil,councilMintedAt,humanityScore,policyConsentVersion`

Перекомпільовано після правки — компілюється чисто.

### 2. Неточний коментар у `MigrationRootRegistry.sol`

NatSpec стверджував, що корінь публікується "лише через `TREASURER_ROLE`"
— в коді такої ролі немає, контракт самокерований і використовує власну
`DAO_ROLE` (той самий патерн, що й решта проєкту). Функціонально це не
впливало на роботу контракту, лише на коментар — виправлено на `DAO_ROLE`.

## Що НЕ перевірено цим методом (обов'язково зробити далі)

- `forge test` на реальному тулчейні — компіляція ABI не гарантує, що
  `test/FullCycle.t.sol` і решта існуючих тестів досі проходять з
  доданими хуками.
- Нові тести саме на `migrationMint`/`migrationSetInfluence`/
  `MigrationClaim.claim()` — у проєкті їх ще немає, це наступний крок.
- End-to-end прогін `export → publishRoot → finalize → deploy target → claim`
  на Arbitrum Sepolia.
- Відомий, задокументований у самому дизайн-документі ліміт: акаунти з
  `Influence > 0`, але без `ShieldSBT` (наприклад, ще не мінтили) —
  НЕ покриваються цим export-скриптом (цикл іде по `ShieldSBT.tokenId`).
  Якщо це критично для вашого сценарію міграції — знадобиться додаткове
  сканування подій `InfluenceAwarded`.

## Файли в цьому наборі

```
src/ShieldSBT.sol                              (+ MIGRATION_ROLE, migrationMint, setMigrationClaim)
src/CouncilSBT.sol                              (+ MIGRATION_ROLE, migrationMint, setMigrationClaim)
src/InfluenceRegistry.sol                       (+ MIGRATION_ROLE, migrationSetInfluence,
                                                    migrationSetProjectStart, setMigrationClaim)
src/migration/MigrationSnapshotLib.sol          (без змін відносно архіву)
src/migration/MigrationRootRegistry.sol         (виправлено коментар TREASURER_ROLE → DAO_ROLE)
src/migration/MigrationClaim.sol                (без змін відносно архіву)
script/migration/ExportMigrationSnapshot.s.sol  (ВИПРАВЛЕНО: додано humanityScore/policyConsentVersion)
CROSS_CHAIN_MIGRATION_DESIGN.md                 (без змін)
```

## Як застосувати

1. Скопіювати `src/ShieldSBT.sol`, `src/CouncilSBT.sol`,
   `src/InfluenceRegistry.sol` з цього набору поверх відповідних файлів
   у `contracts/src/` (замінюють оригінали).
2. Скопіювати `src/migration/` і `script/migration/` у `contracts/`
   як нові директорії.
3. Скопіювати `CROSS_CHAIN_MIGRATION_DESIGN.md` у корінь `contracts/`.
4. `forge build` — має пройти чисто (те саме, що перевірено тут через solc).
5. `forge test` — перш ніж довіряти, обов'язково прогнати
   `test/FullCycle.t.sol` і переконатись, що жоден існуючий тест не зламався.
