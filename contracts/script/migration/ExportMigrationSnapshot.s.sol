// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console2.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "../../src/ShieldSBT.sol";
import "../../src/CouncilSBT.sol";
import "../../src/InfluenceRegistry.sol";
import "../../src/HumanityGate.sol";
import "../../src/migration/MigrationSnapshotLib.sol";

/**
 * @title ExportMigrationSnapshot
 * @notice READ-ONLY скрипт (жодного --broadcast, нічого не пише в чейн).
 *         Виконується на ВИХІДНОМУ чейні. Формує повний Merkle-снепшот
 *         усіх акаунтів, що мають ShieldSBT і/або CouncilSBT, для
 *         подальшої публікації кореня в MigrationRootRegistry і claim-у
 *         через MigrationClaim на цільовому чейні.
 *
 * Чому іменно так, а не через event-індексацію:
 *   ShieldSBT/CouncilSBT НЕ ERC721Enumerable (свідоме рішення в проєкті —
 *   економія газу на mint), АЛЕ tokenId інкрементальний від 1 до
 *   totalSupply() (див. _tokenIdCounter у ShieldSBT.sol/CouncilSBT.sol).
 *   Тому просте послідовне ownerOf(1..totalSupply) дає ПОВНИЙ, детермінований
 *   список без потреби піднімати індексатор чи сканувати логи — коректно
 *   навіть для акаунтів, чий Shield/Council згодом був спалений через
 *   DisciplineModule (ownerOf на спаленому tokenId ревертить —
 *   обробляється нижче через try/catch і просто пропускається: це коректно,
 *   учасник без активного статусу не повинен переносити SBT-статус,
 *   що й був у нього анульований).
 *
 * Запуск (тільки читання, БЕЗ --broadcast):
 *   forge script script/migration/ExportMigrationSnapshot.s.sol:ExportMigrationSnapshot \
 *     --rpc-url arbitrum_one -vvv
 *
 * Вивід іде в stdout (console2.log) у CSV-подібному форматі — ДАЛІ
 * передається в окремий офчейн-інструмент (Node/TS, ПОЗА цим репо), що:
 *   1. рахує ту саму MigrationSnapshotLib.leafHash формулу для кожного рядка,
 *   2. будує дерево (MigrationSnapshotLib.buildRoot / OZ merkletreejs-сумісний),
 *   3. генерує per-account Merkle-proof для фронтенду MigrationClaim.claim(),
 *   4. публікує повний JSON снепшоту на IPFS/Arweave → snapshotURI.
 * Навмисно НЕ реалізовано тут у Solidity — побудова дерева й керування
 * proof-ами для тисяч акаунтів природніше й дешевше офчейн; сам forge
 * script лишається єдиним джерелом ІСТИНИ про сирі ончейн-дані.
 */
contract ExportMigrationSnapshot is Script {
    function run(address shieldAddr, address councilAddr, address influenceAddr) external view {
        ShieldSBT shield = ShieldSBT(shieldAddr);
        CouncilSBT council = CouncilSBT(councilAddr);
        InfluenceRegistry influence = InfluenceRegistry(influenceAddr);
        HumanityGate humanityGate = shield.humanityGate();

        uint256 shieldSupply = shield.totalSupply();
        console2.log("# ShieldSBT totalSupply (verify manually against this number):", shieldSupply);
        console2.log("# councilSBT totalSupply:", council.totalSupply());
        console2.log(
            "# format: index,account,influence,lastActivityTimestamp,hasShield,shieldMintedAt,hasCouncil,councilMintedAt,humanityScore,policyConsentVersion"
        );
        console2.log("---SNAPSHOT-CSV-START---");

        uint256 idx = 0;
        for (uint256 tokenId = 1; tokenId <= shieldSupply; tokenId++) {
            address account = _safeOwnerOf(shield, tokenId);
            if (account == address(0)) continue; // спалений токен — пропускаємо

            uint256 shieldMintedAt = shield.memberSince(account);
            uint256 rawInfluence   = influence.influence(account);
            uint256 lastActivity   = influence.lastActivityTimestamp(account);

            bool hasCouncil;
            uint256 councilMintedAt;
            uint256 councilTokenId = council.accountToTokenId(account);
            if (councilTokenId != 0) {
                hasCouncil = true;
                councilMintedAt = council.memberSince(account);
            }

            // ── Дані, яких раніше НЕ вистачало (див. CROSS_CHAIN_MIGRATION_DESIGN.md):
            //    MigrationSnapshotLib.leafHash() і MigrationClaim.claim() обидва
            //    вимагають humanityScore/policyConsentVersion — без них листок,
            //    побудований офчейн-інструментом, НЕ збігся б з тим, що перевіряє
            //    on-chain claim(). Джерело — ті самі контракти, на які ShieldSBT
            //    вже посилається immutable-адресами, окремого деплою не потрібно.
            uint256 humanityScore = humanityGate.bestScore(account);
            bytes32 policyConsentVersion = shield.consentedPolicyHash(account);

            console2.log(
                string.concat(
                    Strings.toString(idx), ",",
                    Strings.toHexString(account), ",",
                    Strings.toString(rawInfluence), ",",
                    Strings.toString(lastActivity), ",",
                    "true,", // hasShield — гарантовано, бо ми в циклі по shield tokenId
                    Strings.toString(shieldMintedAt), ",",
                    hasCouncil ? "true," : "false,",
                    Strings.toString(councilMintedAt), ",",
                    Strings.toString(humanityScore), ",",
                    Strings.toHexString(uint256(policyConsentVersion), 32)
                )
            );
            idx++;
        }
        console2.log("---SNAPSHOT-CSV-END---");
        // projectStartTimestamp peredaietsia okremo cherez migrationSetProjectStart()
        console2.log("# projectStartTimestamp (pass separately via migrationSetProjectStart):", influence.projectStartTimestamp());
        // UVAGA (dyv. NatSpec vyshche): accounts with Influence > 0 but NO ShieldSBT
        // (e.g. waiting to mint) are NOT covered by this loop - see NatSpec above,
        // requires event-log scan (InfluenceAwarded) to capture fully if needed.
        console2.log("# NOTE: accounts with Influence>0 but no ShieldSBT are NOT covered here - see NatSpec");
        // UVAGA: policyConsentVersion tut - tse consentedPolicyHash (bytes32 gash
        // konkretnoi versii polityky, na yaku pogodyvsya akaunt), NE poriadkovyi
        // nomer versii (consentedVersion, uint256) - tse vidpovidaie typu bytes32
        // v MigrationSnapshotLib.leafHash()/MigrationClaim.claim().
    }

    /// @dev ownerOf() ревертить на непроданому/спаленому tokenId — обгортаємо,
    ///      щоб цикл не падав цілком через один спалений акаунт.
    function _safeOwnerOf(ShieldSBT shield, uint256 tokenId) internal view returns (address) {
        try shield.ownerOf(tokenId) returns (address owner) {
            return owner;
        } catch {
            return address(0);
        }
    }
}
