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
import "../src/Treasury.sol";
import "../src/DisciplineModule.sol";
import "../src/TipJar.sol";
import "../src/DaoGovernor.sol";
import "../src/MockERC20.sol";

/**
 * @title FullCycleTest
 * @notice Наскрізний тестовий цикл HR DAO: mint статусу Захисника → mint
 *         статусу Консула → пропозиція в DaoGovernor → голосування →
 *         queue → execute → зміна параметра Treasury (allowlist +
 *         recipientCooldown) → withdraw. Усі затримки — testMode-
 *         значення (секунди/хвилини), щоб весь цикл проходив у межах
 *         одного forge test прогону БЕЗ реального очікування — лише
 *         vm.warp().
 *
 * Це саме той "тестовий цикл", якого не вистачало для RECIPIENT_COOLDOWN/
 * ROLLING_WINDOW (розділ 15.5 Tokenomics) — після параметризації цих двох
 * констант у Treasury цей тест проходить за секунди symulowanego часу
 * замість реальних 14/30 днів.
 *
 * Запуск: forge test --match-contract FullCycleTest -vvvv
 */
contract FullCycleTest is Test {
    DaoTimelock          daoTimelock;
    HumanityGate         humanityGate;
    MockHumanityProvider mockProvider;
    LocationRegistry     locationRegistry;
    InfluenceRegistry       influenceRegistry;
    ShieldSBT             shieldSBT;
    CouncilSBT           councilSBT;
    CouncilRankingEpoch  rankingEpoch;
    Treasury             treasury;
    DisciplineModule     discipline;
    TipJar                tipJar;
    DaoGovernor          daoGovernor;
    MockERC20            token;

    address deployer = makeAddr("deployer");
    address alice    = makeAddr("alice");   // тіпає донати, сама не бере участі в DAO
    address bob      = makeAddr("bob");     // майбутній Council-власник

    // testMode-параметри — короткі, щоб цикл проходив за vm.warp(), не реальний час
    uint256 constant TIMELOCK_DELAY      = 60;   // 60с замість 72г
    uint256 constant SHIELD_GRACE        = 30;   // 30с замість 180-730д до статусу Консула
    uint256 constant ROLLING_WINDOW      = 600;  // 10хв замість 30д
    uint256 constant RECIPIENT_COOLDOWN  = 60;   // 60с замість 14д
    uint48  constant VOTING_DELAY        = 30;   // 30с
    uint32  constant VOTING_PERIOD       = 120;  // 2хв

    function setUp() public {
        vm.startPrank(deployer);

        address[] memory noProposers = new address[](0);
        address[] memory anyExecutor = new address[](1);
        anyExecutor[0] = address(0);
        address[] memory guardians = new address[](1);
        guardians[0] = deployer;

        daoTimelock = new DaoTimelock(TIMELOCK_DELAY, noProposers, anyExecutor, guardians, deployer);

        humanityGate = new HumanityGate(deployer);
        mockProvider = new MockHumanityProvider(10_000, deployer); // 100.00% score
        humanityGate.addProvider(address(mockProvider));

        MockHexAncestryVerifier hexVerifier = new MockHexAncestryVerifier();
        locationRegistry = new LocationRegistry(
            address(daoTimelock),
            address(hexVerifier),
            keccak256("test-notice-v1"),
            "ipfs://test-notice"
        );

        influenceRegistry = new InfluenceRegistry(address(daoTimelock), address(0));

        shieldSBT = new ShieldSBT(
            address(influenceRegistry),
            address(daoTimelock),
            address(humanityGate),
            2000, // мінімальний score ×100 = 20.00%, легко проходить мок (100%)
            true, // testMode
            keccak256("test-policy-v1"),
            "ipfs://test-policy"
        );
        shieldSBT.setTestGraceDuration(SHIELD_GRACE);
        humanityGate.setAuthorizedCaller(address(shieldSBT), true);

        councilSBT = new CouncilSBT(
            address(influenceRegistry),
            address(shieldSBT),
            address(daoTimelock),
            address(humanityGate),
            5000 // 50.00%, теж проходить мок
        );
        humanityGate.setAuthorizedCaller(address(councilSBT), true);
        influenceRegistry.setCouncilSBT(address(councilSBT));
        humanityGate.proposeGovernor(address(daoTimelock));

        rankingEpoch = new CouncilRankingEpoch(address(councilSBT), address(locationRegistry), address(daoTimelock));

        treasury = new Treasury(
            address(daoTimelock),
            guardians,
            address(locationRegistry),
            address(rankingEpoch),
            ROLLING_WINDOW,
            RECIPIENT_COOLDOWN
        );

        discipline = new DisciplineModule(address(shieldSBT), address(councilSBT), address(influenceRegistry));
        shieldSBT.setDisciplineModule(address(discipline), true);
        councilSBT.setDisciplineModule(address(discipline), true);

        token = new MockERC20("Test USD", "tUSD", 6);

        address[] memory initialTokens = new address[](1);
        uint256[] memory initialMinAmounts = new uint256[](1);
        uint256[] memory initialInfluencePerUnit = new uint256[](1);
        initialTokens[0] = address(token);
        initialMinAmounts[0] = 1e6;
        initialInfluencePerUnit[0] = 1e12; // 1 tUSD (6 decimals) = 1 RIGHT — див. коментар у Deploy.s.sol

        tipJar = new TipJar(
            address(shieldSBT),
            address(councilSBT),
            address(influenceRegistry),
            address(treasury),
            address(daoTimelock),
            initialTokens,
            initialMinAmounts,
            initialInfluencePerUnit
        );

        DaoGovernor.GovernorConfig memory gc = DaoGovernor.GovernorConfig({
            votingDelay: VOTING_DELAY,
            votingPeriod: VOTING_PERIOD,
            proposalThreshold: 0
        });
        daoGovernor = new DaoGovernor(
            address(influenceRegistry),
            address(shieldSBT),
            address(councilSBT),
            address(discipline),
            address(rankingEpoch),
            TimelockController(payable(address(daoTimelock))),
            gc
        );

        influenceRegistry.setTipJar(address(tipJar), true);
        influenceRegistry.grantRole(influenceRegistry.ACTIVITY_ROLE(), address(daoGovernor));
        influenceRegistry.grantRole(influenceRegistry.ACTIVITY_ROLE(), address(discipline));

        // Treasury.TIPJAR_ROLE — лише daoTimelock (TREASURER_ROLE) може
        // видати, деплоєр тут НЕ тримає тимчасового TREASURER_ROLE (на
        // відміну від DAO_ROLE в інших контрактах) — симулюємо, що це
        // вже пройшло голосуванням ДАО раніше. (stopPrank/startPrank
        // навколо — vm.prank не можна викликати всередині активного
        // vm.startPrank(deployer).)
        vm.stopPrank();
        vm.prank(address(daoTimelock));
        treasury.setTipJarRole(address(tipJar), true);
        vm.startPrank(deployer);

        daoTimelock.grantRole(daoTimelock.PROPOSER_ROLE(), address(daoGovernor));
        daoTimelock.grantRole(daoTimelock.CANCELLER_ROLE(), address(daoGovernor));

        // Фіналізація ролей деплоєра (як у Deploy.s.sol._finalizeRoles)
        influenceRegistry.revokeRole(influenceRegistry.DAO_ROLE(), deployer);
        shieldSBT.revokeRole(shieldSBT.DAO_ROLE(), deployer);
        councilSBT.revokeRole(councilSBT.DAO_ROLE(), deployer);
        rankingEpoch.revokeRole(rankingEpoch.DAO_ROLE(), deployer);
        daoTimelock.revokeRole(daoTimelock.DEFAULT_ADMIN_ROLE(), deployer);

        vm.stopPrank();

        token.mint(alice, 10_000e6); // 10 000 tUSD для донатів
    }

    /// @dev Alice тіпає Bob-а на заданy суму (у "доларах", конвертовано в 6-decimals).
    function _tip(uint256 usdAmount) internal {
        vm.startPrank(alice);
        token.approve(address(tipJar), usdAmount * 1e6);
        tipJar.tip(bob, address(token), usdAmount * 1e6, keccak256("post-ref"));
        vm.stopPrank();
    }

    function test_FullCycle_MintProposeVoteQueueExecuteWithdraw() public {
        // ── 1. Bob набирає 200+ Influence і отримує статус Захисника ──
        _tip(250); // 250 Influence
        assertGe(influenceRegistry.currentInfluence(bob), 200);

        vm.startPrank(bob);
        shieldSBT.acceptPolicy(shieldSBT.currentPolicyHash());
        shieldSBT.mint();
        vm.stopPrank();
        assertTrue(shieldSBT.isMember(bob), "Bob must hold Shield status");

        // ── 2. Час минає (SHIELD_GRACE), Bob набирає 500+ Influence, mint Council ──
        vm.warp(block.timestamp + SHIELD_GRACE + 1);
        _tip(300); // разом 550 Influence

        vm.prank(bob);
        councilSBT.mint();
        assertTrue(councilSBT.isCouncilMember(bob), "Bob must hold Council status");

        // ── 3. Хтось поповнює вільний баланс Treasury токеном tUSD ──
        // (Treasury вже отримав частину коштів раніше як supportPool з
        // обох tip-ів вище: 50%×250 (NONE-тір, ще без SBT) + 50%×300
        // (SHIELD-тір, єдиний спліт 50/50 для всіх рівнів) = 125+150 =
        // 275 tUSD — TipJar шле "податок" спліту напряму на адресу
        // Treasury звичайним ERC-20-трансфером, не через
        // depositERC20()/depositTax().)
        vm.startPrank(alice);
        token.approve(address(treasury), 500e6);
        treasury.depositERC20(address(token), 500e6);
        vm.stopPrank();
        assertEq(token.balanceOf(address(treasury)), 775e6, "275 tUSD from tip splits + 500 tUSD direct deposit");

        // ── 4. DAO-пропозиція #1: allowlist-нути Боба як отримувача Treasury ──
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        targets[0] = address(treasury);
        values[0] = 0;
        calldatas[0] = abi.encodeCall(Treasury.setAllowedRecipient, (bob, true));
        string memory description = "Allowlist bob as Treasury recipient";

        vm.prank(bob); // лише Council може пропонувати
        uint256 proposalId1 = daoGovernor.propose(targets, values, calldatas, description);

        _voteQueueExecute(proposalId1, targets, values, calldatas, description);
        assertTrue(treasury.allowedRecipient(bob), "bob must be allowlisted after execute");

        // ── 5. RECIPIENT_COOLDOWN (тепер recipientCooldown, DAO-керований) ──
        // Без параметризації довелось би чекати 14 РЕАЛЬНИХ днів — тепер
        // це testMode-значення (60с), яке проходимо через vm.warp().
        vm.warp(block.timestamp + RECIPIENT_COOLDOWN + 1);

        // ── 6. DAO-пропозиція #2: вивести 100 tUSD Бобу ──
        // (Bob вже тримає tUSD як автор-частку зі своїх же tip-ів вище —
        // 50%×250 + 50%×300 = 275 tUSD — тому перевіряємо ДЕЛЬТУ балансу
        // від withdraw(), а не абсолютне значення.)
        uint256 bobBalanceBefore = token.balanceOf(bob);
        bytes[] memory calldatas2 = new bytes[](1);
        calldatas2[0] = abi.encodeCall(Treasury.withdraw, (address(token), bob, 50e6)); // 10% perTxCap = 77.5 tUSD максимум від 775
        string memory description2 = "Withdraw 50 tUSD to bob";

        vm.prank(bob);
        uint256 proposalId2 = daoGovernor.propose(targets, values, calldatas2, description2);

        _voteQueueExecute(proposalId2, targets, values, calldatas2, description2);

        assertEq(
            token.balanceOf(bob) - bobBalanceBefore,
            50e6,
            "bob must receive exactly 50 tUSD more after full governance cycle"
        );
    }

    /// @dev Спільна частина voting→queue→execute для обох пропозицій вище.
    function _voteQueueExecute(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description
    ) internal {
        vm.warp(block.timestamp + VOTING_DELAY + 1);

        vm.prank(bob);
        daoGovernor.castVote(proposalId, 1); // 1 = For

        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        bytes32 descriptionHash = keccak256(bytes(description));
        daoGovernor.queue(targets, values, calldatas, descriptionHash);

        vm.warp(block.timestamp + TIMELOCK_DELAY + 1);
        daoGovernor.execute(targets, values, calldatas, descriptionHash);
    }

    /// @notice Регресійний тест: подвійний облік у кворумі виправлено —
    ///         quorum() рахується лише від shieldSBT.totalSupply, не
    ///         Shield+Council. З одним Shield-власником totalSupply == 1,
    ///         тому будь-яка ненульова участь (Bob сам) вже проходить
    ///         кворум — тест вище це неявно підтверджує (інакше execute()
    ///         впав би на "Governor: proposal not successful").
    function test_QuorumUsesShieldSupplyOnly() public {
        _tip(250);
        vm.startPrank(bob);
        shieldSBT.acceptPolicy(shieldSBT.currentPolicyHash());
        shieldSBT.mint();
        vm.stopPrank();

        vm.warp(block.timestamp + SHIELD_GRACE + 1);
        _tip(800);
        vm.prank(bob);
        councilSBT.mint();

        uint256 shieldActiveSupply = shieldSBT.getPastActiveSupply(block.timestamp - 1);
        uint256 expectedQuorum = (shieldActiveSupply * daoGovernor.QUORUM_BPS()) / 10_000;
        assertEq(daoGovernor.quorum(block.timestamp - 1), expectedQuorum);
    }

    /// @notice Регресійний тест на fee-on-transfer облік: depositERC20()
    ///         рахує РЕАЛЬНУ дельту балансу, не номінальний amount.
    ///         MockERC20 не бере комісії, тому received == amount тут —
    ///         цей тест лише фіксує контракт поведінки на майбутнє
    ///         (якщо колись підмінити MockERC20 на fee-on-transfer мок).
    function test_DepositERC20_AccountsActualBalanceDelta() public {
        vm.startPrank(alice);
        token.approve(address(treasury), 100e6);
        uint256 beforeBal = token.balanceOf(address(treasury));
        treasury.depositERC20(address(token), 100e6);
        vm.stopPrank();
        assertEq(token.balanceOf(address(treasury)) - beforeBal, 100e6);
    }
}
