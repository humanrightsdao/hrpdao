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
import "../src/DaoGovernor.sol";
import "../src/H3Utils.sol";

/**
 * @title ScopedProposalsTest
 * @notice "Поверхи" (гео-скоуп пропозицій), узгоджено: Консул обирає
 *         конкретний активний "поверх" (EARTH чи гексагон) при створенні
 *         пропозиції, голосувати можуть лише ті, чия локація належить
 *         цій території (чи глибше в ній). Санкції (DisciplineModule) —
 *         БЕЗ гео-прив'язки, не зачіпаються цим тестом.
 *
 * Запуск: forge test --match-contract ScopedProposalsTest -vvvv
 */
contract ScopedProposalsTest is Test {
    using H3Utils for uint64;

    DaoTimelock          daoTimelock;
    HumanityGate         humanityGate;
    MockHumanityProvider mockProvider;
    LocationRegistry     locationRegistry;
    InfluenceRegistry influenceRegistry;
    ShieldSBT            shieldSBT;
    CouncilSBT           councilSBT;
    CouncilRankingEpoch  rankingEpoch;
    DisciplineModule     discipline;
    DaoGovernor          daoGovernor;

    address deployer  = makeAddr("deployer");
    address bobInHexA = makeAddr("bobInHexA");   // Консул, локація = branchA (рівень 1)
    address carolInHexA = makeAddr("carolInHexA"); // Shield, ТА САМА територія, що й bob
    address daveInHexB = makeAddr("daveInHexB"); // Консул, ІНША територія (branchB)

    uint64 branchA;
    uint64 branchB;
    int8 constant LEVEL_1 = 1;

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
        locationRegistry = new LocationRegistry(address(daoTimelock), address(hexVerifier), keccak256("notice-v1"), "ipfs://notice");
        influenceRegistry = new InfluenceRegistry(address(daoTimelock), address(0));

        shieldSBT = new ShieldSBT(
            address(influenceRegistry), address(daoTimelock), address(humanityGate),
            2000, true, keccak256("policy-v1"), "ipfs://policy"
        );
        shieldSBT.setTestGraceDuration(SHIELD_GRACE);
        humanityGate.setAuthorizedCaller(address(shieldSBT), true);

        councilSBT = new CouncilSBT(
            address(influenceRegistry), address(shieldSBT), address(daoTimelock),
            address(humanityGate), 5000
        );
        humanityGate.setAuthorizedCaller(address(councilSBT), true);
        influenceRegistry.setCouncilSBT(address(councilSBT));
        humanityGate.proposeGovernor(address(daoTimelock));

        rankingEpoch = new CouncilRankingEpoch(address(councilSBT), address(locationRegistry), address(daoTimelock));
        rankingEpoch.grantRole(rankingEpoch.EPOCH_SUBMITTER_ROLE(), deployer);

        discipline = new DisciplineModule(address(shieldSBT), address(councilSBT), address(influenceRegistry));

        DaoGovernor.GovernorConfig memory gc = DaoGovernor.GovernorConfig({
            votingDelay: 30,
            votingPeriod: 120,
            proposalThreshold: 0
        });
        daoGovernor = new DaoGovernor(
            address(influenceRegistry), address(shieldSBT), address(councilSBT),
            address(discipline), address(rankingEpoch),
            TimelockController(payable(address(daoTimelock))), gc
        );
        influenceRegistry.grantRole(influenceRegistry.ACTIVITY_ROLE(), address(daoGovernor));
        // Фікс: award() вимагає TIPJAR_ROLE (onlyRole), а конструктор
        // InfluenceRegistry викликається з tipJar=address(0) вище —
        // без цього рядка _award()/setUp() ревертає AccessControlUnauthorizedAccount
        // і ввесь файл (7 тестів, включно з тестом на фікс кворуму V13) не запускається.
        influenceRegistry.grantRole(influenceRegistry.TIPJAR_ROLE(), deployer);

        // Гексагони: base cell 5 (branchA) і base cell 9 (branchB), рівень 1 (дитина рівня 0).
        branchA = _buildHex(1, 5);
        branchB = _buildHex(1, 9);

        // Активуємо EARTH і обидві гілки рівня 0/1 (щоб effectiveHexFor/
        // territory-перевірки бачили їх як реально відкриті).
        _submitNode(rankingEpoch.LEVEL_EARTH(), rankingEpoch.EARTH_BRANCH(), true);
        _submitNode(0, branchA.ancestorOf(1), true);
        _submitNode(0, branchB.ancestorOf(1), true);
        _submitNode(LEVEL_1, branchA, true);
        _submitNode(LEVEL_1, branchB, true);

        vm.stopPrank();

        _mintCouncil(bobInHexA, branchA);
        _mintShieldOnly(carolInHexA, branchA);
        _mintCouncil(daveInHexB, branchB);

        // Гео-реформа v14: effectiveHexFor()/_isWithinTerritory() тепер
        // epoch-aware (читають розкриття "як воно було на момент початку
        // ПОТОЧНОЇ епохи", не живе значення) — без явного beginNewEpoch()
        // ПІСЛЯ всіх _declareLocation()-викликів вище жодне розкриття не
        // вважалось би чинним, і territory-перевірки завжди падали б.
        vm.prank(deployer);
        rankingEpoch.beginNewEpoch();

        // Гео-реформа v14 ("справедливий рейтинг"): EARTH у цьому файлі
        // явно позначено overflowed=true (нижче, у налаштуванні гексагонів
        // до _mintCouncil) — тож ранжування вже значуще, і proposeScoped()
        // для будь-кого вимагає реального Merkle-доказу місця. bobInHexA
        // отримує EARTH-місце (1 листок: root==leaf, proof=[]) — цього
        // достатньо для УНІВЕРСАЛЬНИХ прав (EARTH-місце дає право
        // пропонувати на БУДЬ-ЯКОМУ глибшому рівні власної території,
        // не лише EARTH). daveInHexB НАВМИСНЕ лишається без місця тут —
        // потрібно для test_proposeScoped_earthRevertsWithoutSeat_whenOverflowed;
        // отримує власне LEVEL_1-місце локально, лише в тому тесті, де
        // це реально потрібно (масштабування кворуму).
        address[] memory bobSeatAccounts = new address[](1);
        bool[] memory bobSeatFlags = new bool[](1);
        int8[] memory bobSeatLevels = new int8[](1);
        uint64[] memory bobSeatBranches = new uint64[](1);
        bobSeatAccounts[0] = bobInHexA;
        bobSeatFlags[0] = true;
        bobSeatLevels[0] = rankingEpoch.LEVEL_EARTH();
        bobSeatBranches[0] = rankingEpoch.EARTH_BRANCH();
        vm.prank(deployer);
        rankingEpoch.submitSeatAssignments(bobSeatAccounts, bobSeatFlags, bobSeatLevels, bobSeatBranches);
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

    function _submitNode(int8 level, uint64 branchId, bool overflowed) internal {
        int8[] memory levels = new int8[](1);
        uint64[] memory branchIds = new uint64[](1);
        uint32[] memory seatCounts = new uint32[](1);
        bool[] memory flags = new bool[](1);
        levels[0] = level; branchIds[0] = branchId; seatCounts[0] = 1; flags[0] = overflowed;
        rankingEpoch.submitNodeStatus(levels, branchIds, seatCounts, flags);
    }

    uint256[24] DUMMY_PROOF;

    /// @dev hexId тут завжди резолюції 1 (branchA/branchB з _buildHex(1, ...))
    ///      — розкриваємо і рівень 0, і рівень 1 (повний ланцюжок), як
    ///      реалістично зробив би користувач, що хоче брати участь у
    ///      голосуванні на рівні 1.
    function _declareLocation(address who, uint64 hexId) internal {
        vm.startPrank(who);
        locationRegistry.acceptPolicy(locationRegistry.currentPolicyHash());
        locationRegistry.setLocationCommitment(uint256(hexId) + 1);
        locationRegistry.revealAncestor(0, hexId.ancestorOf(1), DUMMY_PROOF);
        locationRegistry.revealAncestor(LEVEL_1, hexId, DUMMY_PROOF);
        vm.stopPrank();
    }

    function _mintShieldOnly(address who, uint64 hexId) internal {
        vm.prank(deployer);
        influenceRegistry.award(who, 250, keccak256("post"));
        _declareLocation(who, hexId);
        vm.startPrank(who);
        shieldSBT.acceptPolicy(shieldSBT.currentPolicyHash());
        shieldSBT.mint();
        vm.stopPrank();
    }

    function _mintCouncil(address who, uint64 hexId) internal {
        _mintShieldOnly(who, hexId);
        vm.warp(block.timestamp + SHIELD_GRACE + 1);
        vm.prank(deployer);
        influenceRegistry.award(who, 500, keccak256("post-2"));
        vm.prank(who);
        councilSBT.mint();
    }

    function _emptyCalldata() internal pure returns (address[] memory t, uint256[] memory v, bytes[] memory c) {
        t = new address[](1); t[0] = address(0x1234);
        v = new uint256[](1); v[0] = 0;
        c = new bytes[](1); c[0] = "";
    }

    // ── Тести ────────────────────────────────────────────────────

    function test_proposeScoped_earthAlwaysAllowed() public {
        (address[] memory t, uint256[] memory v, bytes[] memory c) = _emptyCalldata();
        // Фікс: аргументи rankingEpoch.LEVEL_EARTH()/EARTH_BRANCH() мають
        // обчислюватись ДО vm.prank — інакше сам виклик LEVEL_EARTH()
        // "з'їдає" prank (Foundry підміняє msg.sender лише для НАСТУПНОГО
        // зовнішнього виклику), і proposeScoped() реально виконується від
        // імені тестового контракту, а не bobInHexA.
        int8 earthLevel = rankingEpoch.LEVEL_EARTH();
        uint64 earthBranch = rankingEpoch.EARTH_BRANCH();

        // Гео-реформа v14: у setUp EARTH позначено overflowed=true, тож
        // тепер потрібне реальне місце (seat) — подаємо його як
        // EPOCH_SUBMITTER_ROLE (deployer). Один кандидат = дерево з
        // одним листком, proof порожній (корінь == сам листок).
        address[] memory seatAccounts = new address[](1);
        bool[] memory seatFlags = new bool[](1);
        int8[] memory seatLevels = new int8[](1);
        uint64[] memory seatBranches = new uint64[](1);
        seatAccounts[0] = bobInHexA;
        seatFlags[0] = true;
        seatLevels[0] = earthLevel;
        seatBranches[0] = earthBranch;
        vm.prank(deployer);
        rankingEpoch.submitSeatAssignments(seatAccounts, seatFlags, seatLevels, seatBranches);

        vm.prank(bobInHexA);
        uint256 id = daoGovernor.proposeScoped(t, v, c, "earth proposal", earthLevel, earthBranch, earthLevel, earthBranch, 0, new bytes32[](0));

        (int8 level, , bool set) = daoGovernor.proposalScope(id);
        assertTrue(set);
        assertEq(level, rankingEpoch.LEVEL_EARTH());
    }

    function test_proposeScoped_revertsForInactiveHexagon() public {
        uint64 unopenedBranch = _buildHex(1, 50);
        (address[] memory t, uint256[] memory v, bytes[] memory c) = _emptyCalldata();

        vm.prank(bobInHexA);
        vm.expectRevert("DaoGovernor: hexagon not active");
        daoGovernor.proposeScoped(t, v, c, "bad proposal", LEVEL_1, unopenedBranch, 0, 0, 0, new bytes32[](0));
    }

    function test_proposeScoped_revertsForOutsideOwnTerritory() public {
        (address[] memory t, uint256[] memory v, bytes[] memory c) = _emptyCalldata();

        // Bob живе в branchA, намагається створити пропозицію для branchB.
        vm.prank(bobInHexA);
        vm.expectRevert("DaoGovernor: outside your own territory");
        daoGovernor.proposeScoped(t, v, c, "wrong territory", LEVEL_1, branchB, 0, 0, 0, new bytes32[](0));
    }

    function test_vote_allowedWithinTerritory_revertsOutside() public {
        (address[] memory t, uint256[] memory v, bytes[] memory c) = _emptyCalldata();
        int8 earthLevel = rankingEpoch.LEVEL_EARTH();
        uint64 earthBranch = rankingEpoch.EARTH_BRANCH();
        vm.prank(bobInHexA);
        uint256 id = daoGovernor.proposeScoped(t, v, c, "local proposal", LEVEL_1, branchA, earthLevel, earthBranch, 0, new bytes32[](0));

        vm.warp(block.timestamp + 31); // minus votingDelay
        vm.roll(block.number + 1);

        // Carol (та сама територія, branchA) — голосує успішно.
        vm.prank(carolInHexA);
        daoGovernor.castVote(id, 1);

        // Dave (branchB, ІНША територія) — не може.
        vm.prank(daveInHexB);
        vm.expectRevert("DaoGovernor: vote outside proposal's territory");
        daoGovernor.castVote(id, 1);
    }

    function test_earthScopedProposal_anyoneCanVote() public {
        (address[] memory t, uint256[] memory v, bytes[] memory c) = _emptyCalldata();
        // Той самий фікс, що й у test_proposeScoped_earthAlwaysAllowed:
        // спершу читаємо константи, потім prank, потім виклик.
        int8 earthLevel = rankingEpoch.LEVEL_EARTH();
        uint64 earthBranch = rankingEpoch.EARTH_BRANCH();

        // Гео-реформа v14: те саме місце (seat) для bobInHexA, що й у
        // test_proposeScoped_earthAlwaysAllowed — EARTH тут теж overflowed.
        address[] memory seatAccounts = new address[](1);
        bool[] memory seatFlags = new bool[](1);
        int8[] memory seatLevels = new int8[](1);
        uint64[] memory seatBranches = new uint64[](1);
        seatAccounts[0] = bobInHexA;
        seatFlags[0] = true;
        seatLevels[0] = earthLevel;
        seatBranches[0] = earthBranch;
        vm.prank(deployer);
        rankingEpoch.submitSeatAssignments(seatAccounts, seatFlags, seatLevels, seatBranches);

        vm.prank(bobInHexA);
        uint256 id = daoGovernor.proposeScoped(t, v, c, "earth proposal", earthLevel, earthBranch, earthLevel, earthBranch, 0, new bytes32[](0));

        vm.warp(block.timestamp + 31);
        vm.roll(block.number + 1);

        // І branchA, і branchB — обидва можуть голосувати за EARTH-пропозицію.
        vm.prank(carolInHexA);
        daoGovernor.castVote(id, 1);
        vm.prank(daveInHexB);
        daoGovernor.castVote(id, 1);
    }

    /// @notice ГЕО-РЕФОРМА v14: коли EARTH переповнений (setUp тут явно
    ///         позначає true), Консул БЕЗ підтвердженого місця (seat) НЕ
    ///         може подати EARTH-пропозицію — навіть маючи повний
    ///         Council-статус. daveInHexB тут НІКОЛИ не отримував seat.
    function test_proposeScoped_earthRevertsWithoutSeat_whenOverflowed() public {
        (address[] memory t, uint256[] memory v, bytes[] memory c) = _emptyCalldata();
        int8 earthLevel = rankingEpoch.LEVEL_EARTH();
        uint64 earthBranch = rankingEpoch.EARTH_BRANCH();

        vm.prank(daveInHexB);
        vm.expectRevert("DaoGovernor: not in EARTH top-244 seat set");
        daoGovernor.proposeScoped(t, v, c, "earth proposal", earthLevel, earthBranch, 0, 0, 0, new bytes32[](0));
    }

    /// @notice Поки EARTH ЩЕ НЕ переповнений (< NODE_CAPACITY=244
    ///         кандидатів), ранжування не має сенсу — БУДЬ-ЯКИЙ Консул
    ///         може подавати EARTH-пропозиції без жодного seat-доказу.
    ///         Це і є фікс "генезис-дедлоку топ-244": перша ж пропозиція
    ///         в мережі не потребує попередньо поданого seat root.
    function test_proposeScoped_earthAllowedWithoutSeat_whenNotOverflowed() public {
        // Позначаємо EARTH ЩЕ РАЗ як НЕ переповнений (перекриває true з setUp).
        // Фікс: спершу читаємо LEVEL_EARTH()/EARTH_BRANCH() (зовнішні
        // view-виклики!), і лише ПОТІМ vm.prank — інакше сам виклик
        // LEVEL_EARTH() "з'їдає" prank, і submitNodeStatus() реально
        // виконується від імені тестового контракту, не deployer.
        int8[] memory levels = new int8[](1);
        uint64[] memory branchIds = new uint64[](1);
        uint32[] memory seatCounts = new uint32[](1);
        bool[] memory flags = new bool[](1);
        levels[0] = rankingEpoch.LEVEL_EARTH();
        branchIds[0] = rankingEpoch.EARTH_BRANCH();
        seatCounts[0] = 2;
        flags[0] = false;
        vm.prank(deployer);
        rankingEpoch.submitNodeStatus(levels, branchIds, seatCounts, flags);

        (address[] memory t, uint256[] memory v, bytes[] memory c) = _emptyCalldata();
        int8 earthLevel = rankingEpoch.LEVEL_EARTH();
        uint64 earthBranch = rankingEpoch.EARTH_BRANCH();

        // daveInHexB так само НЕ мав seat — але це вже не потрібно.
        vm.prank(daveInHexB);
        uint256 id = daoGovernor.proposeScoped(t, v, c, "earth proposal", earthLevel, earthBranch, 0, 0, 0, new bytes32[](0));

        (int8 level, , bool set) = daoGovernor.proposalScope(id);
        assertTrue(set);
        assertEq(level, rankingEpoch.LEVEL_EARTH());
    }

    function test_setScopedQuorumFloor_onlyViaGovernance() public {
        vm.expectRevert("DaoGovernor: only via governance");
        daoGovernor.setScopedQuorumFloor(5);

        vm.prank(address(daoTimelock));
        daoGovernor.setScopedQuorumFloor(5);
        assertEq(daoGovernor.scopedQuorumFloor(), 5);
    }

    /// @notice ⚠️ Регресійний тест на реальну знахідку: раніше скоупований
    ///         кворум був ЗАВЖДИ scopedQuorumFloor (фіксоване число, тут
    ///         дефолт 3), незалежно від реальної заявленої населеності
    ///         гексагону — свідомий вибір густонаселеного vs щойно
    ///         відкритого малолюдного гексагону не мав жодного значення
    ///         для того, скільки голосів треба зібрати. Тепер —
    ///         max(scopedQuorumFloor, rankingEpoch.quorumFor(level,branchId)) —
    ///         для гексагону з великою заявленою населеністю кворум має
    ///         РОСТИ понад фіксований флор.
    function test_scopedQuorum_scalesWithNodePopulation_notFlatExploitable() public {
        // branchA: заявлена населеність (nodeSeatCount) лише 1 (як і в
        // setUp() для всіх вузлів) — кворум обмежений ЛИШЕ флором.
        assertEq(rankingEpoch.quorumFor(LEVEL_1, branchA), 0); // 1 * 2000bps/10000 = 0, округлення вниз
        assertEq(daoGovernor.scopedQuorumFloor(), 3);

        // Тепер подаємо ЗНАЧНО більшу заявлену населеність для branchB —
        // імітує густонаселений (реальний) гексагон, на відміну від
        // щойно відкритого малолюдного branchA.
        int8[] memory levels = new int8[](1);
        uint64[] memory branchIds = new uint64[](1);
        uint32[] memory seatCounts = new uint32[](1);
        bool[] memory flags = new bool[](1);
        levels[0] = LEVEL_1; branchIds[0] = branchB; seatCounts[0] = 100; flags[0] = true;
        vm.prank(deployer);
        rankingEpoch.submitNodeStatus(levels, branchIds, seatCounts, flags);

        // 100 * 2000bps/10000 = 20 — значно більше за флор (3).
        assertEq(rankingEpoch.quorumFor(LEVEL_1, branchB), 20);

        // Пропозиція, скоупована на densely-populated branchB, тепер
        // вимагає РЕАЛЬНО пропорційної явки (20), а не фіксованих 3 —
        // одного голосу дейва вже НЕ досить для проходження кворуму,
        // навіть якщо voterCount вважав би інакше в старій логіці.
        (address[] memory t, uint256[] memory v, bytes[] memory c) = _emptyCalldata();

        // Гео-реформа v14: дейв тут НЕ має спільного EARTH-місця (лишається
        // без нього навмисно з setUp) — щоб пропонувати на LEVEL_1/branchB
        // (своїй реальній території), йому потрібне власне місце САМЕ на
        // цьому рівні. Один листок: root==leaf, proof=[].
        address[] memory daveSeatAccounts = new address[](1);
        bool[] memory daveSeatFlags = new bool[](1);
        int8[] memory daveSeatLevels = new int8[](1);
        uint64[] memory daveSeatBranches = new uint64[](1);
        daveSeatAccounts[0] = daveInHexB;
        daveSeatFlags[0] = true;
        daveSeatLevels[0] = LEVEL_1;
        daveSeatBranches[0] = branchB;
        vm.prank(deployer);
        rankingEpoch.submitSeatAssignments(daveSeatAccounts, daveSeatFlags, daveSeatLevels, daveSeatBranches);

        vm.prank(daveInHexB);
        uint256 id = daoGovernor.proposeScoped(t, v, c, "dense hex proposal", LEVEL_1, branchB, LEVEL_1, branchB, 0, new bytes32[](0));

        vm.warp(block.timestamp + 31);
        vm.roll(block.number + 1);

        vm.prank(daveInHexB);
        daoGovernor.castVote(id, 1);

        // Дочекатись завершення вікна голосування (votingDelay=30 +
        // votingPeriod=120), щоб state() дійсно врахував кворум/результат,
        // а не показав проміжний "Active" (який був би Active незалежно
        // від фіксу, доки голосування ще триває).
        vm.warp(block.timestamp + 121);
        vm.roll(block.number + 1);

        // 1 голос << 20 потрібних — кворум НЕ досягнутий → Defeated=3
        // (OZ IGovernor.ProposalState), а не Succeeded=4.
        assertEq(uint8(daoGovernor.state(id)), 3);
    }
}
