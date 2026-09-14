// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/InfluenceRegistry.sol";
import "../src/ShieldSBT.sol";
import "../src/HumanityGate.sol";
import "../src/MockHumanityProvider.sol";

/**
 * @title ActiveSupplyTest
 * @notice Вирішення проблеми "неактивна більшість блокує голосування":
 *         100 Shield-власників, з них реально активні лише кілька —
 *         перевірка, що activeSupply() коректно відображає лише
 *         активних, syncActivityStatus() коректно рухає людей в обидва
 *         боки, і що це НЕ забирає право голосу в неактивних (лише
 *         впливає на ЗНАМЕННИК порогів явки/кворуму).
 *
 * Запуск: forge test --match-contract ActiveSupplyTest -vvvv
 */
contract ActiveSupplyTest is Test {
    InfluenceRegistry influenceRegistry;
    ShieldSBT               shieldSBT;
    HumanityGate            humanityGate;
    MockHumanityProvider    mockProvider;

    address deployer = makeAddr("deployer");
    address alice    = makeAddr("alice");
    address bob      = makeAddr("bob");
    address carol    = makeAddr("carol");

    function setUp() public {
        vm.startPrank(deployer);

        influenceRegistry = new InfluenceRegistry(deployer, deployer); // dao=tipJar=deployer, для простоти

        humanityGate = new HumanityGate(deployer);
        mockProvider = new MockHumanityProvider(10_000, deployer);
        humanityGate.addProvider(address(mockProvider));

        shieldSBT = new ShieldSBT(
            address(influenceRegistry),
            deployer,
            address(humanityGate),
            2000,
            true, // testMode
            keccak256("policy-v1"),
            "ipfs://policy"
        );
        humanityGate.setAuthorizedCaller(address(shieldSBT), true);

        vm.stopPrank();
    }

    function _mintShield(address who) internal {
        vm.prank(deployer);
        influenceRegistry.award(who, 250, keccak256("post"));

        vm.startPrank(who);
        shieldSBT.acceptPolicy(shieldSBT.currentPolicyHash());
        shieldSBT.mint();
        vm.stopPrank();
    }

    function test_activeSupply_startsEqualToTotalSupply() public {
        _mintShield(alice);
        _mintShield(bob);
        _mintShield(carol);

        assertEq(shieldSBT.totalSupply(), 3);
        assertEq(shieldSBT.activeSupply(), 3, "all freshly minted -> all counted active");
    }

    function test_syncActivityStatus_removesStaleAccountFromDenominator() public {
        _mintShield(alice);
        _mintShield(bob);
        _mintShield(carol);

        // Проходить час, довший за inactivityWindow (дефолт 180 днів),
        // а bob і carol нічого не роблять — жодного donate/vote/touchActivity.
        vm.warp(block.timestamp + shieldSBT.inactivityWindow() + 1 days);

        // Alice лишається активною — задонатила знову (award() оновлює lastActivityTimestamp).
        vm.prank(deployer);
        influenceRegistry.award(alice, 10, keccak256("post-2"));

        // Будь-хто (тут просто deployer, але могла б бути будь-яка адреса)
        // синхронізує статус bob і carol.
        shieldSBT.syncActivityStatus(bob);
        shieldSBT.syncActivityStatus(carol);
        shieldSBT.syncActivityStatus(alice); // теж синхронізуємо -> лишається active (не змінює лічильник)

        assertEq(shieldSBT.totalSupply(), 3, "membership itself unaffected");
        assertEq(shieldSBT.activeSupply(), 1, "only alice counted active now");

        // Bob і carol й НАДАЛІ full members — право голосу НЕ втрачене.
        assertTrue(shieldSBT.isMember(bob));
        assertTrue(shieldSBT.isMember(carol));
    }

    function test_syncActivityStatus_reactivatesOnNewActivity() public {
        _mintShield(alice);
        _mintShield(bob);

        vm.warp(block.timestamp + shieldSBT.inactivityWindow() + 1 days);
        shieldSBT.syncActivityStatus(bob);
        assertEq(shieldSBT.activeSupply(), 1, "bob pruned from denominator");

        // Bob повертається до активності (наприклад, задонатив знову).
        vm.prank(deployer);
        influenceRegistry.award(bob, 5, keccak256("post-3"));

        shieldSBT.syncActivityStatus(bob);
        assertEq(shieldSBT.activeSupply(), 2, "bob counted active again after new activity");
    }

    function test_syncActivityStatus_cannotPruneGenuinelyActiveAccount() public {
        _mintShield(alice);

        // Ще НЕ минуло inactivityWindow — alice досі активна.
        vm.warp(block.timestamp + shieldSBT.inactivityWindow() - 1 days);
        shieldSBT.syncActivityStatus(alice); // no-op, вона й так рахується активною

        assertEq(shieldSBT.activeSupply(), 1, "cannot prune an account that is objectively still active");
    }

    function test_activeSupply_realisticScenario_100members20active() public {
        // Симуляція описаного сценарію: 100 Shield-власників, лише 20 з
        // них щось робили за останні inactivityWindow. Для швидкості тесту
        // мінтимо менше акаунтів (10 всього, 2 активні), пропорція та сама.
        address[] memory members = new address[](10);
        for (uint256 i = 0; i < 10; i++) {
            members[i] = makeAddr(string(abi.encodePacked("member", i)));
            _mintShield(members[i]);
        }

        vm.warp(block.timestamp + shieldSBT.inactivityWindow() + 1 days);

        // Лише перші 2 з 10 лишаються активними.
        vm.startPrank(deployer);
        influenceRegistry.award(members[0], 5, keccak256("a"));
        influenceRegistry.award(members[1], 5, keccak256("b"));
        vm.stopPrank();

        for (uint256 i = 0; i < 10; i++) {
            shieldSBT.syncActivityStatus(members[i]);
        }

        assertEq(shieldSBT.totalSupply(), 10, "membership unaffected");
        assertEq(shieldSBT.activeSupply(), 2, "denominator now reflects the realistically active 20%");

        // Кворум/поріг явки, порахований від 2 (активних), а не від 10
        // (усіх) — саме той ефект, що вирішує описану проблему.
    }
}
