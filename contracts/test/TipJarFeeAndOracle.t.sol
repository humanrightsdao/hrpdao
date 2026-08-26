// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../src/TipJar.sol";
import "../src/InfluenceRegistry.sol";
import "../src/MockFeeOnTransferERC20.sol";
import "../src/MockPriceFeed.sol";
import "../src/MockERC20.sol";

/**
 * @dev Мінімальна заглушка замість ShieldSBT/CouncilSBT — TipJar._authorBps()
 *      викликає лише isMember()/isCouncilMember() (та сама сигнатура, що й у
 *      реальних контрактах), тому повний стек HumanityGate/SBT для цього
 *      фокусованого тесту не потрібен.
 */
contract MockMemberships {
    mapping(address => bool) public isMember;
    mapping(address => bool) public isCouncilMember;

    function setMember(address a, bool v) external { isMember[a] = v; }
    function setCouncilMember(address a, bool v) external { isCouncilMember[a] = v; }
}

/**
 * @dev Мінімальна заглушка замість Treasury — TipJar тепер викликає
 *      supportPool.creditFromTip(token, author, amount) (замість
 *      простого safeTransfer), тож supportPool має вміти хоча б
 *      прийняти пул (той самий approve+pull патерн, що й реальний
 *      Treasury.creditFromTip, без самої каскадної гео-маршрутизації —
 *      вона тестується окремо, в test/ файлах Treasury/CouncilRankingEpoch).
 */
contract MockSupportPool {
    using SafeERC20 for IERC20;

    function creditFromTip(address token, address /*author*/, uint256 amount) external returns (uint256) {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        return 0;
    }
}

/**
 * @title TipJarFeeAndOracleTest
 * @notice Гео-реформа v6: тести на (1) облік tip-у в точці ОТРИМАННЯ для
 *         fee-on-transfer токенів і (2) конвертацію в Influence через оракул
 *         для не-стейблкоїнів. Раніше в проєкті НЕ було жодного тесту на
 *         TipJar.tip() з fee-on-transfer чи оракулом.
 *
 * Запуск: forge test --match-contract TipJarFeeAndOracleTest -vvvv
 */
contract TipJarFeeAndOracleTest is Test {
    TipJar          tipJar;
    InfluenceRegistry  influenceRegistry;
    MockMemberships memberships;
    MockSupportPool supportPool;

    address deployer = makeAddr("deployer");
    address alice    = makeAddr("alice"); // тіпає
    address bob      = makeAddr("bob");   // автор, без SBT-статусу (NONE-рівень, 50/50)

    function setUp() public {
        vm.startPrank(deployer);

        memberships = new MockMemberships();
        supportPool = new MockSupportPool();
        influenceRegistry = new InfluenceRegistry(deployer, address(0));

        address[] memory noTokens = new address[](0);
        uint256[] memory noAmounts = new uint256[](0);
        uint256[] memory noRates = new uint256[](0);

        tipJar = new TipJar(
            address(memberships), // ShieldSBT-заглушка
            address(memberships), // CouncilSBT-заглушка (та сама адреса — обидві функції на ній є)
            address(influenceRegistry),
            address(supportPool), // Treasury-заглушка з creditFromTip()
            deployer,              // dao
            noTokens, noAmounts, noRates
        );
        influenceRegistry.setTipJar(address(tipJar), true);

        vm.stopPrank();
    }

    // ── Fee-on-transfer: облік у точці ОТРИМАННЯ ────────────────────

    function test_feeOnTransfer_splitAndInfluenceUseReceivedAmount() public {
        // 2% fee-on-transfer, 6 decimals (як типовий стейблкоїн-із-комісією).
        MockFeeOnTransferERC20 feeToken = new MockFeeOnTransferERC20("Fee USD", "fUSD", 6, 200);

        vm.prank(deployer);
        tipJar.setStablecoin(address(feeToken), true, 1e6, 1e12); // $1 = 1 токен, 1e12 як у mockToken

        feeToken.mint(alice, 100e6); // 100 fUSD
        vm.prank(alice);
        feeToken.approve(address(tipJar), 100e6);

        uint256 poolBefore = feeToken.balanceOf(address(supportPool));

        vm.prank(alice);
        tipJar.tip(bob, address(feeToken), 100e6, keccak256("post"));

        // TipJar отримав 98 (100 - 2% на вхідному трансфері) — а сам fee-
        // токен НЕ бере комісію ще раз при вихідних переказах TipJar→bob/
        // TipJar→pool у ЦЬОМУ моку (комісія лише на "справжніх" переказах
        // between non-zero addresses — і вихідні перекази теж такі!).
        // Отже й вихідні 49+49 самі по собі втратять по 2% ще раз:
        // 49 * 0.98 = 48.02 (округлення вниз до 48.02e6 = 48_020_000 wei-подібних одиниць).
        // Це ТОЧНО той сценарій "подвійної комісії", який totalReceivedByAuthor/
        // totalToSupportPool рахують ЧЕСНО (реальний баланс), а не "на папері".
        uint256 expectedReceivedByTipJar = 98e6; // 100e6 - 2%
        uint256 expectedAuthorNominal    = 49e6; // 50% від 98e6
        uint256 expectedPoolNominal      = 49e6;
        uint256 expectedAuthorActual     = expectedAuthorNominal - (expectedAuthorNominal * 200 / 10_000); // ще -2% на виході
        uint256 expectedPoolActual       = expectedPoolNominal   - (expectedPoolNominal   * 200 / 10_000);

        assertEq(feeToken.balanceOf(bob), expectedAuthorActual);
        assertEq(feeToken.balanceOf(address(supportPool)) - poolBefore, expectedPoolActual);
        assertEq(tipJar.totalReceivedByAuthor(bob), expectedAuthorActual);
        assertEq(tipJar.totalToSupportPool(), expectedPoolActual);

        // Influence нараховано за РЕАЛЬНО отриманою TipJar сумою (98e6), НЕ за
        // заявленою (100e6): Influence = 98e6 * 1e12 / 1e18 = 98.
        assertEq(influenceRegistry.currentInfluence(bob), 98);
        assertEq(expectedReceivedByTipJar, 98e6); // sanity: підтверджує коментар вище
    }

    // ── Оракул для не-стейблкоїнів ───────────────────────────────────

    function test_oraclePricedToken_ratesInfluenceFromLivePrice() public {
        MockERC20 weth = new MockERC20("Wrapped Ether (mock)", "WETH", 18);
        MockPriceFeed feed = new MockPriceFeed(8, 2_000e8); // $2000, 8 decimals (як реальний Chainlink ETH/USD)

        vm.prank(deployer);
        tipJar.setOraclePricedToken(address(weth), true, 1e15, address(feed), 18);

        weth.mint(alice, 1e18); // 1 WETH
        vm.prank(alice);
        weth.approve(address(tipJar), 1e18);

        assertEq(tipJar.previewInfluence(address(weth), 1e18), 2_000);

        vm.prank(alice);
        tipJar.tip(bob, address(weth), 1e18, keccak256("post"));

        // 1 WETH за $2000 → 50/50 спліт: bob отримує 0.5 WETH, пул — 0.5 WETH,
        // Influence нараховано за ВСІЄЮ сумою (1 WETH = $2000 = 2000 Influence).
        assertEq(weth.balanceOf(bob), 0.5e18);
        assertEq(influenceRegistry.currentInfluence(bob), 2_000);

        // Ціна оракула змінюється "наживо" — наступний tip того самого
        // токена вже рахує Influence за НОВОЮ ціною, без жодних дій ДАО.
        vm.prank(deployer);
        feed.setPrice(3_000e8); // $3000
        weth.mint(alice, 1e18);
        vm.prank(alice);
        weth.approve(address(tipJar), 1e18);
        vm.prank(alice);
        tipJar.tip(bob, address(weth), 1e18, keccak256("post-2"));

        assertEq(influenceRegistry.currentInfluence(bob), 2_000 + 3_000);
    }

    function test_oraclePricedToken_revertsOnStalePrice() public {
        MockERC20 weth = new MockERC20("Wrapped Ether (mock)", "WETH", 18);
        MockPriceFeed feed = new MockPriceFeed(8, 2_000e8);

        vm.prank(deployer);
        tipJar.setOraclePricedToken(address(weth), true, 1e15, address(feed), 18);

        // Фікс: на genesis block.timestamp=1 MockPriceFeed.setStaleBy(2 hours)
        // клампить updatedAt до 0 (timestamp>secondsAgo не виконується), і
        // перевірка block.timestamp - updatedAt <= maxOracleStaleness (1 - 0 = 1)
        // хибно проходить як "свіжа" ціна. Спершу просуваємо час, щоб
        // secondsAgo дійсно можна було відняти від поточного часу.
        vm.warp(block.timestamp + 3 hours);
        feed.setStaleBy(2 hours); // > дефолтного maxOracleStaleness (1 година)

        weth.mint(alice, 1e18);
        vm.prank(alice);
        weth.approve(address(tipJar), 1e18);

        vm.prank(alice);
        vm.expectRevert("TipJar: oracle price stale");
        tipJar.tip(bob, address(weth), 1e18, keccak256("post"));
    }

    function test_removeAcceptedToken_disablesFurtherTips() public {
        MockERC20 weth = new MockERC20("Wrapped Ether (mock)", "WETH", 18);
        MockPriceFeed feed = new MockPriceFeed(8, 2_000e8);

        vm.startPrank(deployer);
        tipJar.setOraclePricedToken(address(weth), true, 1e15, address(feed), 18);
        tipJar.removeAcceptedToken(address(weth)); // "голосування за видалення валюти"
        vm.stopPrank();

        weth.mint(alice, 1e18);
        vm.prank(alice);
        weth.approve(address(tipJar), 1e18);

        vm.prank(alice);
        vm.expectRevert("TipJar: token not accepted");
        tipJar.tip(bob, address(weth), 1e18, keccak256("post"));
    }

    // ── 50/50 дефолт для всіх рівнів ────────────────────────────────

    function test_defaultSplitsAreFiftyFiftyForAllTiers() public view {
        assertEq(tipJar.councilAuthorBps(), 5_000);
        assertEq(tipJar.shieldAuthorBps(), 5_000);
        assertEq(tipJar.noneAuthorBps(), 5_000);
    }

    function test_setSplits_stillBoundedToFivePercentMinFiftyPercentMax() public {
        vm.startPrank(deployer);
        vm.expectRevert("TipJar: tax out of [5%,50%] range");
        tipJar.setSplits(9_600, 5_000, 5_000); // council-податок був би 4% — нижче мінімуму 5%

        vm.expectRevert("TipJar: tax out of [5%,50%] range");
        tipJar.setSplits(4_000, 5_000, 5_000); // council-податок був би 60% — вище максимуму 50%

        tipJar.setSplits(9_500, 6_000, 5_500); // 5%, 40%, 45% — усе в межах
        vm.stopPrank();

        assertEq(tipJar.councilAuthorBps(), 9_500);
        assertEq(tipJar.shieldAuthorBps(), 6_000);
        assertEq(tipJar.noneAuthorBps(), 5_500);
    }
}
