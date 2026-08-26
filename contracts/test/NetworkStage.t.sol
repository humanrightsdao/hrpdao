// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/InfluenceRegistry.sol";

/// @dev Мінімальна заглушка CouncilSBT — InfluenceRegistry.networkStage()
///      читає лише totalSupply(). Дозволяє довільно виставляти "кількість
///      Консулів" без реального mint-флоу (HumanityGate/policy/Influence-поріг),
///      щоб ізольовано протестувати саму формулу стадій.
contract MockCouncilSupply {
    uint256 private _n;
    function setTotalSupply(uint256 n) external { _n = n; }
    function totalSupply() external view returns (uint256) { return _n; }
}

/**
 * @title NetworkStageTest
 * @notice Динамічний коефіцієнт $→Influence, узгоджено: <244 Консулів → 1:1;
 *         ≥244 (EARTH переповнений) → 1:0.5. ⚠️ Стадія 2+ СВІДОМО не
 *         реалізована (аудит виявив: на рівні 0 вже 122 різні гілки,
 *         глобальний totalSupply() не може коректно сказати, чи хоч ОДНА
 *         з них реально заповнена — див. розлогий коментар у
 *         InfluenceRegistry.sol і GEO_REFORM_V10_CHANGES.md).
 *         Перевірка формули networkStage()/currentStageMultiplierBps() і
 *         того, що award() дійсно застосовує множник до фактично
 *         нарахованого Influence, обмежена лише стадіями 0/1.
 *
 * Запуск: forge test --match-contract NetworkStageTest -vvvv
 */
contract NetworkStageTest is Test {
    InfluenceRegistry influenceRegistry;
    MockCouncilSupply       councilSupply;

    address deployer = makeAddr("deployer");
    address alice    = makeAddr("alice");

    function setUp() public {
        vm.startPrank(deployer);
        influenceRegistry = new InfluenceRegistry(deployer, deployer); // dao=tipJar=deployer
        councilSupply = new MockCouncilSupply();
        vm.stopPrank();
    }

    function test_stageZero_beforeCouncilSBTLinked() public view {
        // councilSBT ще не підключено взагалі — безпечний дефолт: стадія 0.
        assertEq(influenceRegistry.networkStage(), 0);
        assertEq(influenceRegistry.currentStageMultiplierBps(), 10_000);
    }

    function test_setCouncilSBT_onlyOnce() public {
        vm.startPrank(deployer);
        influenceRegistry.setCouncilSBT(address(councilSupply));

        vm.expectRevert("Influence: councilSBT already set");
        influenceRegistry.setCouncilSBT(address(councilSupply));
        vm.stopPrank();
    }

    function test_stageProgression_cappedAtOne() public {
        vm.prank(deployer);
        influenceRegistry.setCouncilSBT(address(councilSupply));

        councilSupply.setTotalSupply(243);
        assertEq(influenceRegistry.networkStage(), 0);
        assertEq(influenceRegistry.currentStageMultiplierBps(), 10_000); // 1:1

        councilSupply.setTotalSupply(244); // рівно поріг — EARTH переповнений, стадія 1
        assertEq(influenceRegistry.networkStage(), 1);
        assertEq(influenceRegistry.currentStageMultiplierBps(), 5_000); // 1:0.5

        // Навіть значно більше Консулів — стадія й надалі 1, НЕ 2 чи глибше
        // (свідоме обмеження, не забутий edge case).
        councilSupply.setTotalSupply(1_000_000);
        assertEq(influenceRegistry.networkStage(), 1);
        assertEq(influenceRegistry.currentStageMultiplierBps(), 5_000);
    }

    function test_award_appliesStageMultiplier() public {
        vm.startPrank(deployer);
        influenceRegistry.setCouncilSBT(address(councilSupply));

        // Стадія 0: $100 -> 100 Influence (без змін).
        influenceRegistry.award(alice, 100, keccak256("post-1"));
        assertEq(influenceRegistry.currentInfluence(alice), 100);

        // Мережа виросла — 244 Консули, стадія 1 (÷2).
        councilSupply.setTotalSupply(244);
        influenceRegistry.award(alice, 100, keccak256("post-2")); // +50 (не +100)
        assertEq(influenceRegistry.currentInfluence(alice), 150);

        vm.stopPrank();
    }

    function test_award_revertsIfRoundsToZero() public {
        vm.startPrank(deployer);
        influenceRegistry.setCouncilSBT(address(councilSupply));
        councilSupply.setTotalSupply(244); // стадія 1, множник 50%

        // amount=1 при множнику 50% -> effectiveAmount = 0 (округлення вниз).
        vm.expectRevert("Influence: amount rounds to zero at current network stage");
        influenceRegistry.award(alice, 1, keccak256("post"));
        vm.stopPrank();
    }
}
