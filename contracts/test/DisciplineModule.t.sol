// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/DaoTimelock.sol";
import "../src/HumanityGate.sol";
import "../src/MockHumanityProvider.sol";
import "../src/LocationRegistry.sol";
import "../src/MockHexAncestryVerifier.sol";
import "../src/InfluenceRegistry.sol";
import "../src/ShieldSBT.sol";
import "../src/CouncilSBT.sol";
import "../src/CouncilRankingEpoch.sol";
import "../src/DisciplineModule.sol";

/**
 * @title DisciplineModuleTest
 * @notice Раніше цей модуль (санкції/вето/виконання) не мав ЖОДНОГО тесту
 *         (див. GOVERNANCE_AUDIT_V7_CHANGES.md, "найбільша тестова
 *         прогалина"). Цей файл покриває основний потік:
 *         proposeSanction → voteShield → finalizeShieldVote →
 *         (vetoSanction) → execute, для всіх трьох типів санкцій
 *         (Warning/PartialRestriction/FullSlash) і обох результатів
 *         кворуму (пройшло / не пройшло), плюс апеляцію (вето Council).
 *
 * Явка (participation floor) масштабується за тяжкістю санкції:
 *   Warning floor=5, PartialRestriction floor=8, FullSlash floor=12
 * — тому потрібен достатньо великий пул Shield-власників (13, з яких
 * 5 — Council, для вето-тестів), інакше найсуворіші санкції НІКОЛИ не
 * зможуть набрати кворум навіть при 100% явці.
 *
 * Запуск: forge test --match-contract DisciplineModuleTest -vvvv
 */
contract DisciplineModuleTest is Test {
    DaoTimelock          daoTimelock;
    HumanityGate         humanityGate;
    MockHumanityProvider mockProvider;
    LocationRegistry     locationRegistry;
    InfluenceRegistry influenceRegistry;
    ShieldSBT             shieldSBT;
    CouncilSBT            councilSBT;
    CouncilRankingEpoch   rankingEpoch;
    DisciplineModule      discipline;

    address deployer = makeAddr("deployer");

    // 13 Shield-власників: [0] — типова "мішень" санкцій, [1..12] — voters.
    // З них [1..5] додатково стають Council (для вето-тестів).
    address[13] shield;

    uint256 constant SHIELD_GRACE = 30;

    function setUp() public {
        vm.startPrank(deployer);

        address[] memory noProposers = new address[](0);
        address[] memory anyExecutor = new address[](1);
        anyExecutor[0] = address(0);
        address[] memory guardians = new address[](1);
        guardians[0] = deployer;

        daoTimelock = new DaoTimelock(60, noProposers, anyExecutor, guardians, deployer);

        humanityGate = new HumanityGate(deployer);
        mockProvider = new MockHumanityProvider(10_000, deployer);
        humanityGate.addProvider(address(mockProvider));

        MockHexAncestryVerifier hexVerifier = new MockHexAncestryVerifier();
        locationRegistry = new LocationRegistry(
            address(daoTimelock), address(hexVerifier), keccak256("test-notice-v1"), "ipfs://test-notice"
        );

        influenceRegistry = new InfluenceRegistry(address(daoTimelock), address(0));

        shieldSBT = new ShieldSBT(
            address(influenceRegistry),
            address(daoTimelock),
            address(humanityGate),
            2000,
            true, // testMode
            keccak256("test-policy-v1"),
            "ipfs://test-policy"
        );
        shieldSBT.setTestGraceDuration(SHIELD_GRACE);
        humanityGate.setAuthorizedCaller(address(shieldSBT), true);

        councilSBT = new CouncilSBT(
            address(influenceRegistry), address(shieldSBT), address(daoTimelock), address(humanityGate), 5000
        );
        humanityGate.setAuthorizedCaller(address(councilSBT), true);
        influenceRegistry.setCouncilSBT(address(councilSBT));

        rankingEpoch = new CouncilRankingEpoch(address(councilSBT), address(locationRegistry), address(daoTimelock));

        discipline = new DisciplineModule(address(shieldSBT), address(councilSBT), address(influenceRegistry));
        shieldSBT.setDisciplineModule(address(discipline), true);
        councilSBT.setDisciplineModule(address(discipline), true);
        influenceRegistry.grantRole(influenceRegistry.ACTIVITY_ROLE(), address(discipline));

        // Деплоєр тимчасово тримає TIPJAR_ROLE (адмін — DAO_ROLE, який
        // деплоєр і так тримає в цьому вікні) лише щоб напряму award()-ити
        // Influence тестовим адресам — той самий трюк, що й у реальному
        // genesis-фіксі Deploy.s.sol, спрощує масовий сетап 13 адрес.
        influenceRegistry.grantRole(influenceRegistry.TIPJAR_ROLE(), deployer);

        for (uint256 i = 0; i < 13; i++) {
            shield[i] = makeAddr(string(abi.encodePacked("shield", vm.toString(i))));
            _mintShield(shield[i]);
        }

        // [1..5] додатково стають Council (потребує проходження grace-періоду).
        vm.warp(block.timestamp + SHIELD_GRACE + 1);
        for (uint256 i = 1; i <= 5; i++) {
            _mintCouncil(shield[i]);
        }

        // REPROPOSAL_COOLDOWN (14 днів) рахується від lastFailedAttempt,
        // яке за замовчуванням = 0 — тому ПЕРША-ЛІПША пропозиція на
        // ранньому genesis-часі (block.timestamp ще < 14 днів) хибно
        // впала б у "cooldown active". Не баг контракту — властивість
        // дефолтного нульового значення мапи; просто прогріваємо час.
        vm.warp(block.timestamp + 15 days);

        vm.stopPrank();
    }

    function _mintShield(address who) internal {
        influenceRegistry.award(who, 250, keccak256(abi.encodePacked("seed-shield-", who)));
        vm.startPrank(who);
        shieldSBT.acceptPolicy(shieldSBT.currentPolicyHash());
        shieldSBT.mint();
        vm.stopPrank();
        vm.startPrank(deployer);
    }

    function _mintCouncil(address who) internal {
        influenceRegistry.award(who, 500, keccak256(abi.encodePacked("seed-council-", who)));
        vm.stopPrank();
        vm.prank(who);
        councilSBT.mint();
        vm.startPrank(deployer);
    }

    /// @dev voters = shield[1..count], у порядку. forVotes перших, decision решта - Against.
    function _voteBlock(uint256 id, uint256 count, uint256 forVotes) internal {
        for (uint256 i = 1; i <= count; i++) {
            vm.prank(shield[i]);
            discipline.voteShield(id, i <= forVotes ? DisciplineModule.VoteChoice.For : DisciplineModule.VoteChoice.Against);
        }
    }

    // ── 1. Warning: кворум проходить → execute → blackMark ─────────

    function test_warning_quorumPasses_executesAndRecordsBlackMark() public {
        bytes32 postRef = keccak256("violation-1");
        vm.prank(shield[6]);
        uint256 id = discipline.proposeSanction(shield[0], postRef, DisciplineModule.SanctionType.Warning, DisciplineModule.RestrictionPeriod.Quarter);

        // floor=5, потрібно >=5 голосів явки, >50% approval серед визначених.
        _voteBlock(id, 5, 3); // 3 For, 2 Against -> 60% > 50%

        vm.warp(block.timestamp + 7 days + 1);
        discipline.finalizeShieldVote(id);

        (,,,,,,,,,,,,, DisciplineModule.Status status) = _proposalFields(id);
        assertEq(uint8(status), uint8(DisciplineModule.Status.VetoWindow));

        vm.warp(block.timestamp + 10 days + 1);
        discipline.execute(id);

        assertEq(discipline.blackMarks(shield[0]), 1);
        assertTrue(discipline.violationPostUsed(postRef));
    }

    // ── 2. Явка не набрана → Cancelled ──────────────────────────────

    function test_warning_participationNotMet_cancelled() public {
        bytes32 postRef = keccak256("violation-2");
        vm.prank(shield[6]);
        uint256 id = discipline.proposeSanction(shield[0], postRef, DisciplineModule.SanctionType.Warning, DisciplineModule.RestrictionPeriod.Quarter);

        _voteBlock(id, 3, 3); // лише 3 голоси, floor=5 не досягнуто

        vm.warp(block.timestamp + 7 days + 1);
        discipline.finalizeShieldVote(id);

        (,,,,,,,,,,,,, DisciplineModule.Status status) = _proposalFields(id);
        assertEq(uint8(status), uint8(DisciplineModule.Status.Cancelled));
        assertFalse(discipline.violationPostUsed(postRef)); // доказ НЕ згорів
    }

    // ── 3. Явка є, але немає більшості → Cancelled ──────────────────

    function test_warning_approvalNotMet_cancelled() public {
        bytes32 postRef = keccak256("violation-3");
        vm.prank(shield[6]);
        uint256 id = discipline.proposeSanction(shield[0], postRef, DisciplineModule.SanctionType.Warning, DisciplineModule.RestrictionPeriod.Quarter);

        _voteBlock(id, 5, 2); // 2 For, 3 Against -> 40% < 50%

        vm.warp(block.timestamp + 7 days + 1);
        discipline.finalizeShieldVote(id);

        (,,,,,,,,,,,,, DisciplineModule.Status status) = _proposalFields(id);
        assertEq(uint8(status), uint8(DisciplineModule.Status.Cancelled));
    }

    // ── 4. Reproposal cooldown після Cancelled ──────────────────────

    function test_reproposalCooldown_blocksImmediateRetryThenAllowsAfterWait() public {
        bytes32 postRef = keccak256("violation-4");
        vm.prank(shield[6]);
        uint256 id = discipline.proposeSanction(shield[0], postRef, DisciplineModule.SanctionType.Warning, DisciplineModule.RestrictionPeriod.Quarter);
        _voteBlock(id, 3, 3); // не набирає кворуму -> Cancelled
        vm.warp(block.timestamp + 7 days + 1);
        discipline.finalizeShieldVote(id);

        vm.prank(shield[6]);
        vm.expectRevert("Discipline: reproposal cooldown active");
        discipline.proposeSanction(shield[0], postRef, DisciplineModule.SanctionType.Warning, DisciplineModule.RestrictionPeriod.Quarter);

        vm.warp(block.timestamp + 14 days + 1);
        vm.prank(shield[6]);
        uint256 id2 = discipline.proposeSanction(shield[0], postRef, DisciplineModule.SanctionType.Warning, DisciplineModule.RestrictionPeriod.Quarter);
        assertTrue(id2 != id);
    }

    // ── 5. PartialRestriction: execute → isRestricted до кінця періоду ──

    function test_partialRestriction_executes_setsRestrictedUntilQuarter() public {
        bytes32 postRef = keccak256("violation-5");
        vm.prank(shield[6]);
        uint256 id = discipline.proposeSanction(shield[0], postRef, DisciplineModule.SanctionType.PartialRestriction, DisciplineModule.RestrictionPeriod.Quarter);

        // floor=8, approval>55%: 6 For / 2 Against (75%>55%)
        _voteBlock(id, 8, 6);

        vm.warp(block.timestamp + 7 days + 1);
        discipline.finalizeShieldVote(id);
        vm.warp(block.timestamp + 10 days + 1);

        uint256 execTime = block.timestamp;
        discipline.execute(id);

        assertTrue(discipline.isRestricted(shield[0]));
        // Quarter = 90 днів від моменту execute()
        vm.warp(execTime + 90 days - 1);
        assertTrue(discipline.isRestricted(shield[0]));
        vm.warp(execTime + 90 days + 1);
        assertFalse(discipline.isRestricted(shield[0]));
    }

    // ── 6. FullSlash: execute → Shield SBT спалено ──────────────────

    function test_fullSlash_executes_burnsShieldMembership() public {
        bytes32 postRef = keccak256("violation-6");
        vm.prank(shield[6]);
        uint256 id = discipline.proposeSanction(shield[0], postRef, DisciplineModule.SanctionType.FullSlash, DisciplineModule.RestrictionPeriod.Quarter);

        // floor=12 (з 13 total, target не голосує -> рівно 12 доступно).
        // approval>66%: 9 For / 3 Against = 75%>66%
        _voteBlock(id, 12, 9);

        vm.warp(block.timestamp + 7 days + 1);
        discipline.finalizeShieldVote(id);
        vm.warp(block.timestamp + 10 days + 1);

        assertTrue(shieldSBT.isMember(shield[0]));
        discipline.execute(id);
        assertFalse(shieldSBT.isMember(shield[0]));
    }

    // ── 7. FullSlash на Council-власника — палить і Council, і Shield ──

    function test_fullSlash_onCouncilMember_burnsBoth() public {
        address target = shield[1]; // це один із 5 Council-власників
        bytes32 postRef = keccak256("violation-7");
        vm.prank(shield[6]);
        uint256 id = discipline.proposeSanction(target, postRef, DisciplineModule.SanctionType.FullSlash, DisciplineModule.RestrictionPeriod.Quarter);

        // Голосують решта 11 (усі, крім target=shield[1] і пропонента, який теж може голосувати —
        // тут просто беремо будь-які інші 12 з пулу, виключаючи target).
        for (uint256 i = 2; i <= 12; i++) {
            vm.prank(shield[i]);
            discipline.voteShield(id, i <= 10 ? DisciplineModule.VoteChoice.For : DisciplineModule.VoteChoice.Against);
        }
        // Це 11 голосів (i=2..12), потрібно ще 1 щоб добити floor=12.
        vm.prank(shield[0]);
        discipline.voteShield(id, DisciplineModule.VoteChoice.For);

        vm.warp(block.timestamp + 7 days + 1);
        discipline.finalizeShieldVote(id);
        vm.warp(block.timestamp + 10 days + 1);

        assertTrue(shieldSBT.isMember(target));
        assertTrue(councilSBT.isCouncilMember(target));
        discipline.execute(id);
        assertFalse(shieldSBT.isMember(target));
        assertFalse(councilSBT.isCouncilMember(target));
    }

    // ── 8. Вето Council більшістю скасовує санкцію ──────────────────

    function test_vetoByCouncilMajority_cancelsSanction() public {
        bytes32 postRef = keccak256("violation-8");
        vm.prank(shield[6]);
        uint256 id = discipline.proposeSanction(shield[0], postRef, DisciplineModule.SanctionType.Warning, DisciplineModule.RestrictionPeriod.Quarter);
        _voteBlock(id, 5, 4); // 4 For / 1 Against -> проходить

        vm.warp(block.timestamp + 7 days + 1);
        discipline.finalizeShieldVote(id);

        // 5 Council-власників (shield[1..5]) — 3 з 5 (>50%) ветують.
        vm.prank(shield[1]);
        discipline.vetoSanction(id);
        vm.prank(shield[2]);
        discipline.vetoSanction(id);
        vm.prank(shield[3]);
        discipline.vetoSanction(id);

        (,,,,,,,,,,,,, DisciplineModule.Status status) = _proposalFields(id);
        assertEq(uint8(status), uint8(DisciplineModule.Status.Cancelled));
        // Скасована вето -> не виконана -> blackMark НЕ нарахований, доказ вільний.
        assertEq(discipline.blackMarks(shield[0]), 0);
    }

    // ── 9. Вето меншістю НЕ скасовує — санкція виконується після вікна ──

    function test_vetoByCouncilMinority_doesNotCancel_executesAfterWindow() public {
        bytes32 postRef = keccak256("violation-9");
        vm.prank(shield[6]);
        uint256 id = discipline.proposeSanction(shield[0], postRef, DisciplineModule.SanctionType.Warning, DisciplineModule.RestrictionPeriod.Quarter);
        _voteBlock(id, 5, 4);

        vm.warp(block.timestamp + 7 days + 1);
        discipline.finalizeShieldVote(id);

        // Лише 2 з 5 (40% < 50%) ветують.
        vm.prank(shield[1]);
        discipline.vetoSanction(id);
        vm.prank(shield[2]);
        discipline.vetoSanction(id);

        (,,,,,,,,,,,,, DisciplineModule.Status statusAfterVeto) = _proposalFields(id);
        assertEq(uint8(statusAfterVeto), uint8(DisciplineModule.Status.VetoWindow)); // ще не скасована

        vm.warp(block.timestamp + 10 days + 1);
        discipline.execute(id);
        assertEq(discipline.blackMarks(shield[0]), 1);
    }

    // ── 10. Не можна голосувати двічі ────────────────────────────────

    function test_cannotVoteTwice() public {
        bytes32 postRef = keccak256("violation-10");
        vm.prank(shield[6]);
        uint256 id = discipline.proposeSanction(shield[0], postRef, DisciplineModule.SanctionType.Warning, DisciplineModule.RestrictionPeriod.Quarter);

        vm.startPrank(shield[7]);
        discipline.voteShield(id, DisciplineModule.VoteChoice.For);
        vm.expectRevert("Discipline: already voted");
        discipline.voteShield(id, DisciplineModule.VoteChoice.Against);
        vm.stopPrank();
    }

    // ── 11. Хто заминтив Shield ПІСЛЯ пропозиції — не голосує ────────

    function test_cannotVoteIfJoinedAfterProposalCreated() public {
        bytes32 postRef = keccak256("violation-11");
        vm.prank(shield[6]);
        uint256 id = discipline.proposeSanction(shield[0], postRef, DisciplineModule.SanctionType.Warning, DisciplineModule.RestrictionPeriod.Quarter);

        // Новий Shield-власник, заминчений ПІСЛЯ proposeSanction — час
        // МАЄ реально просунутись, інакше memberSince == createdAt і
        // перевірка "<=" (не "<") хибно пропустила б цей межовий випадок.
        vm.warp(block.timestamp + 1);
        address latecomer = makeAddr("latecomer");
        vm.startPrank(deployer);
        _mintShield(latecomer);
        vm.stopPrank();

        vm.prank(latecomer);
        vm.expectRevert("Discipline: joined after proposal, cannot vote");
        discipline.voteShield(id, DisciplineModule.VoteChoice.For);
    }

    // ── 12. Виконаний доказ не можна використати повторно ────────────

    function test_executedViolationPostRef_cannotBeReused() public {
        bytes32 postRef = keccak256("violation-12");
        vm.prank(shield[6]);
        uint256 id = discipline.proposeSanction(shield[0], postRef, DisciplineModule.SanctionType.Warning, DisciplineModule.RestrictionPeriod.Quarter);
        _voteBlock(id, 5, 3);
        vm.warp(block.timestamp + 7 days + 1);
        discipline.finalizeShieldVote(id);
        vm.warp(block.timestamp + 10 days + 1);
        discipline.execute(id);

        vm.prank(shield[6]);
        vm.expectRevert("Discipline: this violation already adjudicated");
        discipline.proposeSanction(shield[0], postRef, DisciplineModule.SanctionType.Warning, DisciplineModule.RestrictionPeriod.Quarter);
    }

    // ── Хелпер: розпаковка Proposal (лише status, останнє поле) ─────
    function _proposalFields(uint256 id)
        internal
        view
        returns (
            address, bytes32, DisciplineModule.SanctionType, DisciplineModule.RestrictionPeriod,
            uint256, uint256, uint256, uint256, uint256, uint256,
            uint256, uint256, uint256, DisciplineModule.Status
        )
    {
        (
            address target,
            bytes32 violationPostRef,
            DisciplineModule.SanctionType sType,
            DisciplineModule.RestrictionPeriod period,
            uint256 createdAt,
            uint256 shieldSupplySnapshot,
            uint256 shieldVoteDeadline,
            uint256 shieldForVotes,
            uint256 shieldAgainstVotes,
            uint256 shieldAbstainVotes,
            uint256 vetoWindowOpenedAt,
            uint256 councilSupplySnapshot,
            uint256 vetoDeadline,
            , // vetoForVotes — не потрібне тут
            DisciplineModule.Status status
        ) = discipline.proposals(id);
        return (
            target, violationPostRef, sType, period, createdAt, shieldSupplySnapshot,
            shieldVoteDeadline, shieldForVotes, shieldAgainstVotes, shieldAbstainVotes,
            vetoWindowOpenedAt, councilSupplySnapshot, vetoDeadline, status
        );
    }
}
