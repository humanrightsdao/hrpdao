// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/Hashes.sol";

/**
 * @title MigrationSnapshotLib
 * @notice Спільна формула листка й побудова Merkle-дерева для експорту
 *         стану користувачів HR DAO при міграції на інший блокчейн (чи на
 *         новий набір контрактів на тому самому чейні). Той самий принцип,
 *         що й SeatMerkleLib: формула ОБОВ'ЯЗКОВО ідентична там, де корінь
 *         будується (офчейн-скрипт експорту + MigrationRootRegistry на
 *         вихідному чейні), і там, де перевіряється (MigrationClaim на
 *         цільовому чейні) — інакше proof ніколи не пройде верифікацію.
 *
 * Листок навмисно НЕ включає баланс Treasury конкретного користувача —
 * Treasury не має "балансів користувачів" (це спільна казна), кошти
 * мігрують окремо, через міст/OTC/DAO-рішення, а не через цей claim-флоу.
 *
 * Листок ТАКОЖ навмисно не включає geo/ranking дані (LocationRegistry,
 * CouncilRankingEpoch) — на момент, коли ця бібліотека знадобиться,
 * ці дані або ще не існують (міграція під час фази 1, до 244 користувачів),
 * або підуть окремим, схожим за принципом claim-флоу пізніше (Етап 2
 * міграції, поза межами цього документа).
 */
library MigrationSnapshotLib {
    /// @notice Один листок = повний "переносимий" профіль одного акаунта.
    /// @param index                Унікальний порядковий номер листка (як і в
    ///                              SeatMerkleLib — захист від колізій/дублів).
    /// @param account               Адреса користувача (та сама на цільовому чейні —
    ///                              міграція НЕ підтримує зміну адреси в цьому флоу).
    /// @param influence             InfluenceRegistry.influence(account) на момент
    ///                              снепшоту (ДО decay-перерахунку на новому чейні).
    /// @param lastActivityTimestamp InfluenceRegistry.lastActivityTimestamp(account) —
    ///                              потрібен новому InfluenceRegistry для коректного
    ///                              продовження decay-розрахунку без штучного "скидання".
    /// @param hasShield             Чи був власником ShieldSBT на момент снепшоту.
    /// @param shieldMintedAt        Оригінальний час мінту ShieldSBT (для чесного
    ///                              збереження стажу — CouncilSBT-поріг рахує стаж
    ///                              у статусі Shield, скидати його при міграції
    ///                              несправедливо для вже "заслужених" учасників).
    /// @param hasCouncil            Чи був власником CouncilSBT на момент снепшоту.
    /// @param councilMintedAt       Оригінальний час мінту CouncilSBT.
    /// @param humanityScore         Останній відомий HumanityGate-скор (×100), щоб
    ///                              новий ShieldSBT/CouncilSBT міг far пройти власні
    ///                              пороги без повторного проходження humanity-флоу
    ///                              одразу в день міграції (акаунт підтверджує
    ///                              актуальність окремо, див. MigrationClaim NatSpec).
    /// @param policyConsentVersion  Версія політики прав людини, з якою погодився
    ///                              акаунт (PolicyConsentGate) — переноситься, АЛЕ
    ///                              MigrationClaim все одно вимагає повторної згоди
    ///                              з ПОТОЧНОЮ версією політики на новому чейні
    ///                              (див. NatSpec MigrationClaim.claim()).
    function leafHash(
        uint256 index,
        address account,
        uint256 influence,
        uint256 lastActivityTimestamp,
        bool    hasShield,
        uint256 shieldMintedAt,
        bool    hasCouncil,
        uint256 councilMintedAt,
        uint256 humanityScore,
        bytes32 policyConsentVersion
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                index,
                account,
                influence,
                lastActivityTimestamp,
                hasShield,
                shieldMintedAt,
                hasCouncil,
                councilMintedAt,
                humanityScore,
                policyConsentVersion
            )
        );
    }

    /// @notice Ідентична побудова дерева, що й SeatMerkleLib.buildRoot —
    ///         навмисно скопійована (не заімпортована з SeatMerkleLib),
    ///         щоб міграційний код НЕ мав жодної залежності від
    ///         geo/ranking-модуля (Етап 2/3), який на момент міграції фази 1
    ///         може бути навіть не задеплоєний.
    function buildRoot(bytes32[] memory leaves) internal pure returns (bytes32) {
        uint256 n = leaves.length;
        require(n > 0, "MigrationSnapshotLib: empty leaf set");
        if (n == 1) return leaves[0];

        bytes32[] memory level = leaves;
        while (level.length > 1) {
            uint256 nextLen = (level.length + 1) / 2;
            bytes32[] memory next = new bytes32[](nextLen);
            for (uint256 i = 0; i < nextLen; i++) {
                uint256 left = i * 2;
                uint256 right = left + 1;
                if (right < level.length) {
                    next[i] = Hashes.commutativeKeccak256(level[left], level[right]);
                } else {
                    next[i] = level[left];
                }
            }
            level = next;
        }
        return level[0];
    }
}
