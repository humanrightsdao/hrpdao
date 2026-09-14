// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/InfluenceRegistry.sol";

/**
 * @title InfluenceSnapshotTest
 * @notice Аудит голосування: перевірка, що getPastInfluence()/getPastVotingPower()
 *         дійсно "заморожують" вагу голосу на timepoint і НЕ реагують на
 *         award(), що стався ПІСЛЯ цього timepoint — тобто донат через
 *         TipJar, отриманий ПІД ЧАС вікна голосування, більше не може
 *         підняти вагу голосу для ВЖЕ створеної пропозиції.
 *
 * Запуск: forge test --match-contract InfluenceSnapshotTest -vvvv
 */
contract InfluenceSnapshotTest is Test {
    InfluenceRegistry influenceRegistry;

    address deployer = makeAddr("deployer"); // тут одночасно dao І tipJar (для простоти тесту)
    address alice    = makeAddr("alice");

    function setUp() public {
        vm.prank(deployer);
        influenceRegistry = new InfluenceRegistry(deployer, deployer); // dao=deployer, tipJar=deployer
    }

    function test_getPastInfluence_ignoresAwardsAfterTimepoint() public {
        vm.startPrank(deployer);
        influenceRegistry.award(alice, 100, keccak256("post-1"));
        // Фікс: з via_ir=true solc кешує звичайний "block.timestamp" у
        // локальну змінну так, що вона хибно "стрибає" за наступним
        // vm.warp() (відомий артефакт Foundry, issue foundry-rs/foundry
        // #7911/#8102) — vm.getBlockTimestamp() читає реальне поточне
        // значення й не підпадає під цю оптимізацію.
        uint256 tProposalSnapshot = vm.getBlockTimestamp(); // "момент створення пропозиції"

        // Через 2 дні (типове вікно голосування) alice отримує ще один
        // донат — намагаючись підняти собі вагу голосу ЗАДНІМ ЧИСЛОМ для
        // пропозиції, знімок якої вже зафіксований на tProposalSnapshot.
        vm.warp(block.timestamp + 2 days);
        influenceRegistry.award(alice, 500, keccak256("post-2"));
        vm.stopPrank();

        // Живе значення ВЖЕ бачить нові 500 rights.
        assertEq(influenceRegistry.currentInfluence(alice), 600);

        // Але знімок на момент пропозиції — і НАДАЛІ 100, без "накрутки".
        assertEq(influenceRegistry.getPastInfluence(alice, tProposalSnapshot), 100);

        // А знімок на "зараз" (після другого донату) вже бачить усі 600 —
        // тобто снапшот коректно рухається вперед у часі, лише не назад.
        assertEq(influenceRegistry.getPastInfluence(alice, block.timestamp), 600);
    }

    function test_getPastVotingPower_matchesRootFormulaAtSnapshot() public {
        vm.startPrank(deployer);
        influenceRegistry.award(alice, 10_000, keccak256("post-1"));
        // Той самий фікс, що й у test_getPastInfluence_ignoresAwardsAfterTimepoint.
        uint256 tSnap = vm.getBlockTimestamp();

        vm.warp(block.timestamp + 3 days);
        influenceRegistry.award(alice, 990_000, keccak256("post-2")); // разом 1_000_000
        vm.stopPrank();

        // votingPower = rights^(1/4). У знімку — лише перші 10_000: 10_000^(1/4) = 10.
        assertEq(influenceRegistry.getPastVotingPower(alice, tSnap), 10);

        // Живе значення вже враховує усі 1_000_000: 1_000_000^(1/4) = 31 (ціло, Babylonian sqrt(sqrt(...))).
        assertEq(influenceRegistry.votingPower(alice), 31);
    }

    function test_getPastInfluence_beforeAnyActivity_isZero() public view {
        assertEq(influenceRegistry.getPastInfluence(alice, block.timestamp), 0);
    }

    function test_getPastInfluence_atExactCheckpointMoment() public {
        vm.startPrank(deployer);
        influenceRegistry.award(alice, 42, keccak256("post-1"));
        uint256 tAward = block.timestamp;
        vm.stopPrank();

        // Знімок РІВНО в момент award() (не до і не після) — бачить нові rights.
        assertEq(influenceRegistry.getPastInfluence(alice, tAward), 42);
        // Знімок за секунду ДО award() — ще 0 (у алісі взагалі не було rights).
        if (tAward > 0) {
            assertEq(influenceRegistry.getPastInfluence(alice, tAward - 1), 0);
        }
    }

    function test_getPastInfluence_appliesYearDecayRelativeToSnapshotActivity() public {
        vm.startPrank(deployer);
        influenceRegistry.award(alice, 1_000, keccak256("post-1"));
        uint256 tAward = block.timestamp;
        vm.stopPrank();

        // Знімок рівно через 400 днів (> 1 рік) ПІСЛЯ award(), без жодної
        // подальшої активності — має показати ОДИН крок затухання (10%),
        // так само, як і currentInfluence() показав би, якби зараз було
        // саме це tSnap.
        uint256 tSnap = tAward + 400 days;

        uint256 expected = (1_000 * 9_000) / 10_000; // -10%, складно за 1 рік
        assertEq(influenceRegistry.getPastInfluence(alice, tSnap), expected);
    }

    function test_touchActivity_alsoCheckpoints() public {
        vm.startPrank(deployer);
        influenceRegistry.grantRole(influenceRegistry.ACTIVITY_ROLE(), deployer);
        influenceRegistry.award(alice, 100, keccak256("post-1"));

        vm.warp(block.timestamp + 1 days);
        influenceRegistry.touchActivity(alice); // без нарахування, лише "освіжає" активність
        uint256 tTouch = block.timestamp;
        vm.stopPrank();

        // Influence не змінився від touchActivity — лише activity-годинник.
        assertEq(influenceRegistry.getPastInfluence(alice, tTouch), 100);
        assertEq(influenceRegistry.currentInfluence(alice), 100);
    }
}
