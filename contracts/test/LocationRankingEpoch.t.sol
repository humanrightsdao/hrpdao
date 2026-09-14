// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/DaoTimelock.sol";
import "../src/LocationRegistry.sol";
import "../src/CouncilRankingEpoch.sol";
import "../src/MockHexAncestryVerifier.sol";
import "../src/H3Utils.sol";

/**
 * @title LocationRankingEpochTest
 * @notice Гео-реформа v5 (MAX_RESOLUTION=10, effectiveHexFor) + v12
 *         (ZK-приватність — commit+reveal замість відкритого hexId).
 *
 *         ⚠️ Оновлено під нову модель: LocationRegistry більше НЕ зберігає
 *         сирий hexId — лише комітмент (setLocationCommitment) і
 *         ZK-перевірені (тут — через MockHexAncestryVerifier, що завжди
 *         приймає, бо реальний Groth16-доказ у Foundry-тестах
 *         згенерувати практично неможливо) розкриті предки
 *         (revealAncestor). Тестові хелпери нижче явно розкривають ВЕСЬ
 *         ланцюжок предків від 0 до заданої резолюції — той самий ефект,
 *         що й старе "миттєве" розкриття через відкритий hexId, лише
 *         тепер це явна дія, а не побічний ефект зберігання.
 *
 * Запуск: forge test --match-contract LocationRankingEpochTest -vvvv
 */
contract LocationRankingEpochTest is Test {
    using H3Utils for uint64;

    LocationRegistry        locationRegistry;
    CouncilRankingEpoch     rankingEpoch;
    MockHexAncestryVerifier hexVerifier;

    address deployer      = makeAddr("deployer");
    address alice         = makeAddr("alice");
    address bob           = makeAddr("bob");
    address carol         = makeAddr("carol");
    address dummyCouncilSBT = address(0xC0FFEE);

    bytes32 constant NOTICE_HASH = keccak256("location-notice-v1");

    uint256[24] DUMMY_PROOF; // за замовчуванням масив з 24 нулів, MockHexAncestryVerifier ігнорує вміст

    function setUp() public {
        vm.startPrank(deployer);

        hexVerifier = new MockHexAncestryVerifier();
        locationRegistry = new LocationRegistry(deployer, address(hexVerifier), NOTICE_HASH, "ipfs://location-notice");
        rankingEpoch = new CouncilRankingEpoch(dummyCouncilSBT, address(locationRegistry), deployer);
        rankingEpoch.grantRole(rankingEpoch.EPOCH_SUBMITTER_ROLE(), deployer);

        vm.stopPrank();
    }

    function _buildHex(uint8 resolution, uint8 baseCell) internal pure returns (uint64) {
        uint64 index = uint64(1) << 59;
        index |= uint64(resolution) << 52;
        index |= uint64(baseCell) << 45;
        for (uint8 r = 1; r <= 15; r++) {
            uint64 digit = (r <= resolution) ? uint64(0) : uint64(7);
            uint64 shift = uint64(15 - r) * 3;
            index |= digit << shift;
        }
        return index;
    }

    function _declare(address account, uint64 hexId, uint8 resolution) internal {
        vm.startPrank(account);
        locationRegistry.acceptPolicy(NOTICE_HASH);
        locationRegistry.setLocationCommitment(uint256(hexId) + 1);
        for (uint8 r = 0; r <= resolution; r++) {
            uint64 ancestor = hexId.ancestorOf(resolution - r);
            locationRegistry.revealAncestor(int8(uint8(r)), ancestor, DUMMY_PROOF);
        }
        vm.stopPrank();
    }

    /// @dev Гео-реформа v14: effectiveHexFor()/_isWithinTerritory() тепер
    ///      epoch-aware — читають розкриття "як воно було на момент
    ///      currentEpochStartedAt", а НЕ живе значення. Тому в тестах
    ///      треба явно "зафіксувати" епоху ПІСЛЯ revealAncestor(), інакше
    ///      currentEpochStartedAt==0 і жодне розкриття не вважається
    ///      чинним (effectiveHexFor завжди поверне EARTH).
    function _lockInEpoch() internal {
        vm.prank(deployer);
        rankingEpoch.beginNewEpoch();
    }

    function _submitNode(int8 level, uint64 branchId, bool overflowed) internal {
        int8[]   memory levels  = new int8[](1);
        uint64[] memory branchIds = new uint64[](1);
        uint32[] memory seatCounts = new uint32[](1);
        bool[]   memory flags   = new bool[](1);
        levels[0] = level;
        branchIds[0] = branchId;
        seatCounts[0] = 1;
        flags[0] = overflowed;

        vm.prank(deployer);
        rankingEpoch.submitNodeStatus(levels, branchIds, seatCounts, flags);
    }

    function test_maxResolutionIsTen() public {
        assertEq(locationRegistry.MAX_RESOLUTION(), 10);

        _declare(alice, _buildHex(10, 5), 10);
        assertEq(locationRegistry.getDeepestRevealedLevel(alice), 10);

        vm.startPrank(bob);
        locationRegistry.acceptPolicy(NOTICE_HASH);
        locationRegistry.setLocationCommitment(999);
        vm.expectRevert("Location: invalid level");
        locationRegistry.revealAncestor(11, _buildHex(11, 5), DUMMY_PROOF);
        vm.stopPrank();
    }

    function test_totalDeclaredLocationsCounter() public {
        assertEq(locationRegistry.totalDeclaredLocations(), 0);

        _declare(alice, _buildHex(3, 5), 3);
        assertEq(locationRegistry.totalDeclaredLocations(), 1);

        _declare(bob, _buildHex(4, 5), 4);
        assertEq(locationRegistry.totalDeclaredLocations(), 2);

        vm.warp(block.timestamp + 366 days);
        vm.prank(alice);
        locationRegistry.setLocationCommitment(uint256(_buildHex(6, 5)) + 1);
        assertEq(locationRegistry.totalDeclaredLocations(), 2);

        vm.warp(block.timestamp + 366 days);
        vm.prank(alice);
        locationRegistry.setLocationCommitment(0);
        assertEq(locationRegistry.totalDeclaredLocations(), 1);
    }

    function test_totalActiveHexagonsCounter() public {
        assertEq(rankingEpoch.totalActiveHexagons(), 0);

        uint64 branchA = _buildHex(0, 5);
        uint64 branchB = _buildHex(1, 5);

        _submitNode(0, branchA, true);
        assertEq(rankingEpoch.totalActiveHexagons(), 1);

        _submitNode(1, branchB, true);
        assertEq(rankingEpoch.totalActiveHexagons(), 2);

        _submitNode(0, branchA, true);
        assertEq(rankingEpoch.totalActiveHexagons(), 2);

        _submitNode(-1, rankingEpoch.EARTH_BRANCH(), true);
        assertEq(rankingEpoch.totalActiveHexagons(), 2);

        _submitNode(0, branchA, false);
        assertEq(rankingEpoch.totalActiveHexagons(), 1);
    }

    function test_effectiveHexFor_noLocation_returnsGlobal() public {
        (int8 level, uint64 branchId) = rankingEpoch.effectiveHexFor(alice);
        assertEq(level, -1);
        assertEq(branchId, rankingEpoch.EARTH_BRANCH());
    }

    function test_effectiveHexFor_globalNotOverflowed_returnsGlobal() public {
        _declare(alice, _buildHex(5, 5), 5);
        (int8 level, uint64 branchId) = rankingEpoch.effectiveHexFor(alice);
        assertEq(level, -1);
        assertEq(branchId, rankingEpoch.EARTH_BRANCH());
        assertEq(rankingEpoch.activeLevelsForAccount(alice), 1);
    }

    function test_effectiveHexFor_sparsePopulation_stopsAtLevelZero() public {
        _declare(alice, _buildHex(5, 5), 5);
        _submitNode(-1, rankingEpoch.EARTH_BRANCH(), true);

        _lockInEpoch();

        (int8 level, uint64 branchId) = rankingEpoch.effectiveHexFor(alice);
        assertEq(level, 0);
        assertEq(branchId, _buildHex(0, 5));
        assertEq(rankingEpoch.activeLevelsForAccount(alice), 2);
    }

    function test_effectiveHexFor_cascadesToDeclaredResolution() public {
        uint64 aliceHex = _buildHex(5, 5);
        _declare(alice, aliceHex, 5);

        _submitNode(-1, rankingEpoch.EARTH_BRANCH(), true);
        for (uint8 r = 0; r < 5; r++) {
            uint64 ancestor = aliceHex.ancestorOf(5 - r);
            _submitNode(int8(uint8(r)), ancestor, true);
        }

        _lockInEpoch();

        (int8 level, uint64 branchId) = rankingEpoch.effectiveHexFor(alice);
        assertEq(level, 5);
        assertEq(branchId, aliceHex);
        assertEq(rankingEpoch.activeLevelsForAccount(alice), 7);
    }

    function test_effectiveHexFor_capsAtDeclaredResolution_evenIfDeeperIsActive() public {
        uint64 bobHex = _buildHex(1, 9);
        _declare(bob, bobHex, 1);

        _submitNode(-1, rankingEpoch.EARTH_BRANCH(), true);
        _submitNode(0, bobHex.ancestorOf(1), true);

        _lockInEpoch();

        (int8 level, uint64 branchId) = rankingEpoch.effectiveHexFor(bob);
        assertEq(level, 1);
        assertEq(branchId, bobHex);
        assertEq(rankingEpoch.activeLevelsForAccount(bob), 3);
    }

    function test_effectiveHexFor_stopsWhenIntermediateNodeNotOverflowed() public {
        uint64 carolHex = _buildHex(6, 12);
        _declare(carol, carolHex, 6);

        _submitNode(-1, rankingEpoch.EARTH_BRANCH(), true);
        _submitNode(0, carolHex.ancestorOf(6), true);
        _submitNode(1, carolHex.ancestorOf(5), true);
        _submitNode(2, carolHex.ancestorOf(4), true);
        _submitNode(3, carolHex.ancestorOf(3), false);

        _lockInEpoch();

        (int8 level, uint64 branchId) = rankingEpoch.effectiveHexFor(carol);
        assertEq(level, 3);
        assertEq(branchId, carolHex.ancestorOf(3));
        assertEq(rankingEpoch.activeLevelsForAccount(carol), 5);
    }

    function test_partialReveal_onlyRevealedLevelsAreUsable() public {
        uint64 aliceHex = _buildHex(6, 5);
        vm.startPrank(alice);
        locationRegistry.acceptPolicy(NOTICE_HASH);
        locationRegistry.setLocationCommitment(uint256(aliceHex) + 1);
        for (uint8 r = 0; r <= 2; r++) {
            locationRegistry.revealAncestor(int8(uint8(r)), aliceHex.ancestorOf(6 - r), DUMMY_PROOF);
        }
        vm.stopPrank();

        assertEq(locationRegistry.getDeepestRevealedLevel(alice), 2);
        assertEq(locationRegistry.getRevealedAncestor(alice, 3), 0);

        _submitNode(-1, rankingEpoch.EARTH_BRANCH(), true);
        _submitNode(0, aliceHex.ancestorOf(6), true);
        _submitNode(1, aliceHex.ancestorOf(5), true);
        _submitNode(2, aliceHex.ancestorOf(4), true);
        _submitNode(3, aliceHex.ancestorOf(3), true);

        _lockInEpoch();

        (int8 level, uint64 branchId) = rankingEpoch.effectiveHexFor(alice);
        assertEq(level, 2);
        assertEq(branchId, aliceHex.ancestorOf(4));
    }
}
