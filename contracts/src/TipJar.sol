// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "./ShieldSBT.sol";
import "./CouncilSBT.sol";
import "./InfluenceRegistry.sol";

/**
 * @title IPriceFeed
 * @notice Мінімальний підмножина Chainlink-сумісного AggregatorV3Interface —
 *         лише те, що реально потрібно TipJar (ціна + час останнього
 *         оновлення). Навмисно НЕ імпортується напряму з пакета chainlink-contracts
 *         (щоб не тягнути зайву залежність) — будь-який фід, що реалізує
 *         ЦІ ДВІ функції з такими самими сигнатурами (Chainlink, і більшість
 *         сумісних з ним фідів на Arbitrum — API3, Pyth-адаптери тощо),
 *         підійде без змін коду.
 */
interface IPriceFeed {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (
            uint80  roundId,
            int256  answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80  answeredInRound
        );
}

/**
 * @title ITreasuryTipCredit
 * @notice Мінімальний інтерфейс до Treasury.creditFromTip() — та сама
 *         каскадна маршрутизація "спільнотної" частки по гексагонах
 *         (hexBalance), що вже є для прямих депозитів, але за локацією
 *         АВТОРА, не тіпера. Навмисно НЕ імпортується повний Treasury.sol
 *         (уникнення зайвої залежності — той самий підхід, що з IPriceFeed).
 */
interface ITreasuryTipCredit {
    function creditFromTip(address token, address author, uint256 amount) external returns (uint256 operational);
}

/**
 * @title TipJar
 * @notice Механізм підтримки авторів постів ("Tip") в ERC-20 токенах +
 *         джерело нарахування Influence (Influence).
 *
 * Гео-реформа v6 (оракул + fee-on-transfer + єдиний 50/50):
 *
 *   1) СПЛІТИ. Усі три рівні (COUNCIL / SHIELD / без SBT) тепер мають
 *      ОДНАКОВИЙ дефолт 50% автору / 50% у Support Pool — попередня
 *      диференціація (90/10 для Council, 80/20 для Shield) прибрана.
 *      Межі голосування ДАО лишаються ті самі — податок (частка пулу)
 *      може бути змінений голосуванням у діапазоні [5%; 50%]
 *      (MIN_TAX_BPS/MAX_TAX_BPS, БЕЗ ЗМІН) для кожного рівня незалежно.
 *      Це ОКРЕМИЙ параметр від Treasury.OPERATIONAL_BPS (5%, жорстко
 *      зафіксовано, без голосування) — той стосується вже ІНШОГО кроку
 *      (маршрутизації податку в Treasury), тут не чіпається.
 *
 *   2) FEE-ON-TRANSFER. Точка обліку суми переносена з НАДСИЛАННЯ на
 *      ОТРИМАННЯ на кожному хопі (before/after balanceOf), а не з
 *      номінального параметра `amount`:
 *        - скільки TipJar РЕАЛЬНО отримав від msg.sender (може бути
 *          менше за `amount`, якщо токен спалює % при трансфері);
 *        - скільки автор РЕАЛЬНО отримав зі свого переказу;
 *        - скільки Support Pool РЕАЛЬНО отримав зі свого переказу.
 *      Приклад із специфікації: надіслано 100, токен спалює 2 на
 *      трансфері → TipJar отримує 98 → спліт 50/50 від 98 → автор 49,
 *      пул 49 (сума точно 98, без "втрачених" чи "з повітря" токенів).
 *      Influence нараховується за РЕАЛЬНО отриманою TipJar сумою (98), а не
 *      за заявленою (100).
 *
 *   3) ОРАКУЛ ДЛЯ НЕ-СТЕЙБЛКОЇНІВ. Раніше курс token→$ для Influence
 *      встановлював ДАО вручну (`influencePerUnit`) для КОЖНОГО токена,
 *      включно зі стейблкоїнами. Тепер токен має ОДИН з двох "видів"
 *      (TokenKind):
 *        - STABLE  — долгодоларовий стейблкоїн, курс і надалі $1≈1 токен,
 *          ручний influencePerUnit (БЕЗ оракула — стейблкоїн за визначенням
 *          стабільний, зовнішній фід тут не потрібен і є зайвою точкою
 *          відмови/маніпуляції). Найпопулярніші USD-стейблкоїни
 *          прописуються ЗА ЗАМОВЧУВАННЯМ при деплої (див. script/Deploy.s.sol).
 *        - ORACLE   — будь-яка інша криптовалюта (ETH, WBTC тощо):
 *          вартість у $ рахує Chainlink-сумісний price feed
 *          (`latestRoundData()`), Influence = amount × price / 10^(priceDecimals+tokenDecimals).
 *          Захист від протухлої ціни — maxOracleStaleness (DAO-керований).
 *      Додавання НОВОЇ валюти (будь-якого виду) і ВИДАЛЕННЯ валюти —
 *      і надалі ЛИШЕ голосуванням ДАО (onlyRole(DAO_ROLE), тобто через
 *      DaoGovernor → DaoTimelock) — жодних змін до цього механізму.
 *
 *   - Захист від накрутки Influence НЕ робиться тут (кепи/кулдауни/податок) —
 *     узгоджено, що основний захист — influence^(1/4) на етапі voting power
 *     в InfluenceRegistry. TipJar лишається простим.
 */
contract TipJar is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant DAO_ROLE = keccak256("DAO_ROLE");

    // ── Конфігурація split-ів (basis points, 10000 = 100%) ─────────
    uint256 public constant BPS_DENOMINATOR     = 10_000;

    /// @notice Межі "податку" (частки, що йде в Support Pool) — 5% .. 50%, в bps.
    ///         Застосовується до ВСІХ рівнів (COUNCIL / SHIELD / NONE). Без змін
    ///         у цьому оновленні — лише самі ДЕФОЛТИ спліту нижче змінені на 50/50.
    uint256 public constant MIN_TAX_BPS = 500;   // 5%
    uint256 public constant MAX_TAX_BPS = 5_000; // 50%

    /// @notice Поточні частки автора (bps). Податок = BPS_DENOMINATOR - authorBps.
    ///         Змінюються лише через голосування ДАО (DAO_ROLE), в межах
    ///         [MIN_TAX_BPS, MAX_TAX_BPS] для відповідного податку.
    ///         Оновлення: усі три рівні тепер стартують з ОДНАКОВОГО 50/50
    ///         (раніше Council 90/10, Shield 80/20) — узгоджено, що статус
    ///         Shield/Council сам по собі не повинен впливати на дефолтний
    ///         розподіл tip-ів; голосуванням DAO й надалі можна диференціювати.
    uint256 public councilAuthorBps = 5_000; // 50% автору, 50% в пул (було 90/10)
    uint256 public shieldAuthorBps  = 5_000; // 50% автору, 50% в пул (було 80/20)
    uint256 public noneAuthorBps    = 5_000; // 50% автору, 50% в пул (без змін)

    uint256 private constant RATE_SCALE = 1e18;

    /// @notice Вид токена для конвертації в Influence.
    ///         NONE — токен не в allowlist (дефолт для будь-якої нової адреси).
    ///         STABLE — фіксований ручний курс influencePerUnit, без оракула.
    ///         ORACLE — курс рахує зовнішній price feed (IPriceFeed).
    enum TokenKind { NONE, STABLE, ORACLE }

    ShieldSBT       public immutable shieldSBT;
    CouncilSBT       public immutable councilSBT;
    InfluenceRegistry  public immutable influenceRegistry;

    /// @notice Адреса Support Pool — куди йде "податок" зі спліту tip-ів.
    ///         Після об'єднання Governor'ів і появи окремого Treasury це
    ///         тепер адреса Treasury (rate-ліміти/allowlist Treasury
    ///         застосовуються і до цих коштів, а не лише до основної
    ///         казни) — див. GenesisDeployer._deployTipJarAndWire().
    address public immutable supportPool;

    /// @notice Дозволені ERC-20 токени для tip-ів
    mapping(address => bool) public acceptedTokens;

    /// @notice Вид кожного дозволеного токена (STABLE/ORACLE) — визначає,
    ///         яким шляхом рахується Influence у _valueInInfluence().
    mapping(address => TokenKind) public tokenKind;

    /// @notice Мінімальна сума tip-у на токен (захист від пилу)
    mapping(address => uint256) public minTipAmount;

    /// @notice $-курс токена для нарахування Influence (scaled 1e18) — лише
    ///         для TokenKind.STABLE. DAO-керований, без оракула.
    mapping(address => uint256) public influencePerUnit;

    /// @notice Адреса Chainlink-сумісного price feed — лише для
    ///         TokenKind.ORACLE. Пара ОБОВ'ЯЗКОВО має бути в USD
    ///         (напр. ETH/USD), інакше конвертація в Influence буде хибною.
    mapping(address => address) public priceFeed;

    /// @notice Кількість decimals самого токена (НЕ ціни з фіда) — лише
    ///         для TokenKind.ORACLE, потрібно для правильного масштабування
    ///         (amount токена вже включає decimals токена, а не $).
    mapping(address => uint8) public tokenDecimals;

    /// @notice Максимальний "вік" ціни з оракула (updatedAt), після якого
    ///         tip() у ORACLE-токені ревертає — захист від протухлого/
    ///         зламаного фіда. DAO-керований.
    uint256 public maxOracleStaleness = 1 hours;

    // ── Статистика (для UI / аналітики) ─────────────────────────────
    mapping(address => uint256) public totalReceivedByAuthor;
    uint256 public totalToSupportPool;

    /// @notice ГЕО-РЕФОРМА v14: справедливий, автономний бутстрап без
    ///         ручного засіву Influence деплоєру (див. MIGRATION_NOTES.md,
    ///         розділ "genesis fairness"). Поки Treasury ще не має
    ///         TIPJAR_ROLE (типова ситуація одразу після генезису, до
    ///         першої DAO-пропозиції), пул-частина tip-у НЕ втрачається
    ///         і НЕ віддається автору повністю (це відкрило б Sybil-дірку
    ///         — self-dealing на двох гаманцях стало б безкоштовним) — а
    ///         тимчасово ЗАЛИШАЄТЬСЯ всередині TipJar (escrow), з такою ж
    ///         реальною "ціною" для тіпера, як і в звичайному режимі.
    ///         Щойно Treasury отримує роль — БУДЬ-ХТО (permissionless)
    ///         може викликати sweepEscrowToTreasury() і перенести весь
    ///         накопичений залишок туди одним викликом.
    mapping(address => uint256) public escrowedPool;

    // ── Події ─────────────────────────────────────────────────────
    event PoolEscrowed(address indexed token, address indexed author, uint256 amount);
    event EscrowSwept(address indexed token, uint256 amount);
    event TipSent(
        address indexed from,
        address indexed author,
        address indexed token,
        uint256 receivedAmount,
        uint256 authorAmount,
        uint256 poolAmount,
        uint256 influenceAwarded,
        bytes32 postRef
    );

    event StablecoinConfigured(address indexed token, bool accepted, uint256 minAmount, uint256 influencePerUnit);
    event OracleTokenConfigured(address indexed token, bool accepted, uint256 minAmount, address priceFeed, uint8 tokenDecimals);
    event TokenRemoved(address indexed token);
    event MaxOracleStalenessUpdated(uint256 newStaleness);

    event SplitsUpdated(
        uint256 councilAuthorBps,
        uint256 shieldAuthorBps,
        uint256 noneAuthorBps,
        address indexed updatedBy
    );

    // ── Конструктор ───────────────────────────────────────────────
    /**
     * @param _shieldSBT       Адреса ShieldSBT
     * @param _councilSBT       Адреса CouncilSBT
     * @param _influenceRegistry  Адреса InfluenceRegistry
     * @param _supportPool     Адреса Treasury (Support Pool — куди йде "податок" зі спліту)
     * @param _dao             DaoTimelock — єдиний, хто може міняти allowlist/курс надалі
     * @param initialStableTokens      Початкові СТЕЙБЛКОЇНИ за замовчуванням
     *                                 (напр. [USDC, USDT, DAI, ...]) — щоб не
     *                                 було проблеми курки-яйця (DAO_ROLE без
     *                                 жодного Council на старті).
     * @param initialStableMinAmounts  Мінімальна сума tip-у для кожного initialStableTokens
     * @param initialStableInfluencePerUnit influencePerUnit для кожного initialStableTokens
     */
    constructor(
        address _shieldSBT,
        address _councilSBT,
        address _influenceRegistry,
        address _supportPool,
        address _dao,
        address[] memory initialStableTokens,
        uint256[] memory initialStableMinAmounts,
        uint256[] memory initialStableInfluencePerUnit
    ) {
        require(
            initialStableTokens.length == initialStableMinAmounts.length &&
            initialStableTokens.length == initialStableInfluencePerUnit.length,
            "TipJar: array length mismatch"
        );

        shieldSBT      = ShieldSBT(_shieldSBT);
        councilSBT      = CouncilSBT(_councilSBT);
        influenceRegistry = InfluenceRegistry(_influenceRegistry);
        supportPool    = _supportPool;

        _setRoleAdmin(DAO_ROLE, DAO_ROLE); // DAO_ROLE керує сам собою, без зовнішнього майстер-ключа
        _grantRole(DAO_ROLE, _dao);

        // За замовчуванням реєструються ЛИШЕ стейблкоїни (найпопулярніші
        // доларові — конкретні адреси підставляються в script/Deploy.s.sol
        // під цільову мережу). Не-доларові валюти (ORACLE-вид) ДАО додає
        // окремим голосуванням через setOraclePricedToken() вже після
        // деплою — жодна ORACLE-пара НЕ прописується в конструкторі.
        for (uint256 i = 0; i < initialStableTokens.length; i++) {
            _setStablecoin(initialStableTokens[i], true, initialStableMinAmounts[i], initialStableInfluencePerUnit[i]);
        }
    }

    // ── Основна функція ──────────────────────────────────────────

    /**
     * @notice Відправити tip автору посту.
     * @param author    Адреса автора
     * @param token     Адреса ERC-20 токена (має бути в acceptedTokens)
     * @param amount    Заявлена сума в одиницях токена (для fee-on-transfer
     *                  токенів РЕАЛЬНО отримана сума може бути меншою —
     *                  саме вона й використовується для спліту/Influence,
     *                  див. NatSpec контракту, п. 2).
     * @param postRef   keccak256(lensPostId) — посилання на пост
     */
    function tip(address author, address token, uint256 amount, bytes32 postRef) external {
        require(acceptedTokens[token], "TipJar: token not accepted");
        require(amount >= minTipAmount[token], "TipJar: amount below minimum");
        require(author != address(0), "TipJar: invalid author");
        require(author != msg.sender, "TipJar: cannot tip yourself");

        // ── Точка обліку №1: скільки TipJar РЕАЛЬНО отримав ──────────
        uint256 tipJarBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - tipJarBefore;

        uint256 authorBps    = _authorBps(author);
        uint256 authorAmount = (received * authorBps) / BPS_DENOMINATOR;
        uint256 poolAmount   = received - authorAmount;

        // ── Точка обліку №2 і №3: скільки автор/пул РЕАЛЬНО отримали ──
        if (authorAmount > 0) {
            uint256 authorBefore = IERC20(token).balanceOf(author);
            IERC20(token).safeTransfer(author, authorAmount);
            uint256 authorReceived = IERC20(token).balanceOf(author) - authorBefore;
            totalReceivedByAuthor[author] += authorReceived;
        }
        if (poolAmount > 0) {
            // ⚠️ ВИРІШЕННЯ ПРОГАЛИНИ: раніше тут був звичайний safeTransfer —
            // гроші фізично потрапляли в Treasury, але НІКОЛИ не
            // "закредитовувались" на жоден гексагон (hexBalance), тому
            // withdrawFromHex() для жодного hexController() не мав що
            // виводити з донатів. Тепер — creditFromTip(), яка виконує ТУ
            // САМУ каскадну маршрутизацію по "поверхах", що вже є для
            // прямих депозитів (depositTax), але за ЛОКАЦІЄЮ АВТОРА
            // (не тіпера — тіпер анонімний, локація TipJar-як-контракту
            // не має сенсу).
            //
            // ⚠️ ГЕО-РЕФОРМА v14 (справедливий бутстрап): якщо Treasury
            // ЩЕ не має TIPJAR_ROLE (генезис, до першої DAO-пропозиції),
            // creditFromTip() ревертне — ловимо це через try/catch і
            // ЕСКРОЮЄМО суму всередині самого TipJar (кошти вже фізично
            // тут, з safeTransferFrom вище — просто НЕ виводимо їх далі),
            // замість того, щоб провалити весь tip() чи віддати пул-частку
            // автору (що відкрило б Sybil-дірку самобутстрапу). Реальна
            // "ціна" для тіпера лишається такою самою, як і завжди.
            IERC20(token).forceApprove(supportPool, poolAmount);
            uint256 poolBefore = IERC20(token).balanceOf(supportPool);
            try ITreasuryTipCredit(supportPool).creditFromTip(token, author, poolAmount) {
                uint256 poolReceived = IERC20(token).balanceOf(supportPool) - poolBefore;
                totalToSupportPool += poolReceived;
            } catch {
                IERC20(token).forceApprove(supportPool, 0); // прибрати "висячий" approve
                escrowedPool[token] += poolAmount;
                emit PoolEscrowed(token, author, poolAmount);
            }
        }

        // Influence нараховується за РЕАЛЬНО отриманою TipJar сумою (`received`,
        // ДО спліту, ПІСЛЯ можливого fee-on-transfer), не за заявленим `amount`.
        uint256 influenceAmount = _valueInInfluence(token, received);
        if (influenceAmount > 0) {
            influenceRegistry.award(author, influenceAmount, postRef);
        }

        emit TipSent(msg.sender, author, token, received, authorAmount, poolAmount, influenceAmount, postRef);
    }

    /**
     * @notice Перенести накопичений escrow (пул-частки tip-ів, зроблених
     *         ДО того, як Treasury отримав TIPJAR_ROLE) у сам Treasury —
     *         одним викликом, весь залишок по конкретному токену.
     *         PERMISSIONLESS — будь-хто може викликати, щойно Treasury
     *         реально має роль (перевіряється самою спробою creditFromTip,
     *         не окремим прапорцем стану — немає що "забути" синхронізувати).
     * @dev Атрибуція конкретним оригінальним авторам/локаціям на цьому
     *      етапі вже втрачена (escrow міг накопичитись від багатьох різних
     *      tip-ів різним авторам) — вся сума йде як внесок від імені
     *      самого TipJar (address(this) не має розкритої локації, тож
     *      маршрутизація впаде на EARTH-рівень operational+earmarked
     *      кошик). Прийнятне спрощення для одноразового генезис-випадку.
     */
    function sweepEscrowToTreasury(address token) external {
        uint256 amount = escrowedPool[token];
        require(amount > 0, "TipJar: nothing to sweep");
        escrowedPool[token] = 0;

        IERC20(token).forceApprove(supportPool, amount);
        uint256 poolBefore = IERC20(token).balanceOf(supportPool);
        ITreasuryTipCredit(supportPool).creditFromTip(token, address(this), amount);
        uint256 poolReceived = IERC20(token).balanceOf(supportPool) - poolBefore;
        totalToSupportPool += poolReceived;

        emit EscrowSwept(token, amount);
    }

    // ── Конвертація token → Influence ($1 = 1 Influence) ───────────────────

    /// @dev STABLE — ручний курс (як і раніше). ORACLE — Chainlink-сумісний
    ///      фід, з перевіркою на протухлість і на невалідну (≤0) ціну.
    function _valueInInfluence(address token, uint256 amount) internal view returns (uint256) {
        TokenKind kind = tokenKind[token];

        if (kind == TokenKind.STABLE) {
            return (amount * influencePerUnit[token]) / RATE_SCALE;
        }

        if (kind == TokenKind.ORACLE) {
            IPriceFeed feed = IPriceFeed(priceFeed[token]);
            (, int256 answer, , uint256 updatedAt, ) = feed.latestRoundData();
            require(answer > 0, "TipJar: invalid oracle price");
            require(block.timestamp - updatedAt <= maxOracleStaleness, "TipJar: oracle price stale");

            uint8 priceDecimals = feed.decimals();
            uint8 tDecimals     = tokenDecimals[token];

            // influence = (amount / 10^tokenDecimals) × (price / 10^priceDecimals)
            //        = amount × price / 10^(tokenDecimals + priceDecimals).
            // Жодного додаткового множення на RATE_SCALE тут НЕ потрібно —
            // на відміну від STABLE-гілки (де influencePerUnit сам НЕСЕ в собі
            // масштаб 1e18, тому й ділиться на RATE_SCALE), тут курс береться
            // напряму з оракула у "сирих" одиницях токена/ціни, тож формула
            // одразу дає Influence як цілу кількість доларів, без проміжного
            // 1e18-масштабування. (Виправлено: попередня версія помилково
            // множила ще й на RATE_SCALE, завищуючи Influence у 1e18 разів.)
            return (amount * uint256(answer)) / (10 ** (uint256(priceDecimals) + uint256(tDecimals)));
        }

        return 0; // TokenKind.NONE — сюди не мало дійти (acceptedTokens вже відфільтрував tip()),
                  // але без Influence, а не revert, про всяк випадок (view-функція, previewInfluence теж її викликає).
    }

    // ── Читання для UI ───────────────────────────────────────────

    /**
     * @notice Який % суми отримає автор (для попереднього відображення в UI).
     * @return bps  Кількість basis points
     * @return tier "COUNCIL" / "SHIELD" / "NONE"
     */
    function previewSplit(address author) external view returns (uint256 bps, string memory tier) {
        bps = _authorBps(author);
        if (councilSBT.isCouncilMember(author)) return (bps, "COUNCIL");
        if (shieldSBT.isMember(author))       return (bps, "SHIELD");
        return (bps, "NONE");
    }

    /// @notice Скільки Influence отримає автор за донат заданого розміру в цьому
    ///         токені — orієнтовно для ORACLE-токенів (реальна ціна на момент
    ///         виконання tip() може відрізнятись від ціни на момент виклику
    ///         цієї view-функції).
    function previewInfluence(address token, uint256 amount) external view returns (uint256) {
        return _valueInInfluence(token, amount);
    }

    // ── DAO governance: стейблкоїни (ручний курс, без оракула) ──────

    /**
     * @notice Додати/оновити/прибрати СТЕЙБЛКОЇН (ручний influencePerUnit,
     *         без оракула). Викликається тільки через DaoGovernor →
     *         DaoTimelock (DAO_ROLE) — це tokenomics-параметр.
     */
    function setStablecoin(
        address token,
        bool accepted,
        uint256 minAmount,
        uint256 _influencePerUnit
    ) external onlyRole(DAO_ROLE) {
        _setStablecoin(token, accepted, minAmount, _influencePerUnit);
    }

    /**
     * @notice Додати/оновити НЕ-доларову валюту (ORACLE-вид) — курс
     *         рахуватиме зовнішній Chainlink-сумісний price feed. Пара
     *         ОБОВ'ЯЗКОВО має бути в USD (напр. ETH/USD, WBTC/USD).
     *         Викликається тільки через DaoGovernor → DaoTimelock
     *         (DAO_ROLE) — додавання нової валюти в принципі рішення ДАО.
     * @param token          Адреса ERC-20 токена
     * @param accepted       true — додати/лишити активним; false — деактивувати
     * @param minAmount      Мінімальна сума tip-у в одиницях токена
     * @param feed           Адреса price feed (IPriceFeed, пара X/USD)
     * @param _tokenDecimals decimals() самого токена (НЕ ціни з фіда)
     */
    function setOraclePricedToken(
        address token,
        bool accepted,
        uint256 minAmount,
        address feed,
        uint8 _tokenDecimals
    ) external onlyRole(DAO_ROLE) {
        require(token != address(0), "TipJar: zero token");

        if (accepted) {
            require(feed != address(0), "TipJar: zero price feed");
            // Санітарна перевірка при реєстрації — фід повинен реально
            // відповідати валідною (>0) ціною просто зараз, інакше
            // проголосована конфігурація одразу зробила б tip() непрацездатним.
            (, int256 answer, , , ) = IPriceFeed(feed).latestRoundData();
            require(answer > 0, "TipJar: oracle returned non-positive price");
        }

        acceptedTokens[token] = accepted;
        minTipAmount[token]   = minAmount;
        priceFeed[token]      = feed;
        tokenDecimals[token]  = _tokenDecimals;
        tokenKind[token]      = accepted ? TokenKind.ORACLE : TokenKind.NONE;
        influencePerUnit[token]  = 0; // ORACLE-токен не використовує ручний курс

        emit OracleTokenConfigured(token, accepted, minAmount, feed, _tokenDecimals);
    }

    /**
     * @notice Повністю прибрати валюту з allowlist (незалежно від виду —
     *         STABLE чи ORACLE). Голосування ДАО за видалення валюти.
     */
    function removeAcceptedToken(address token) external onlyRole(DAO_ROLE) {
        acceptedTokens[token] = false;
        tokenKind[token]      = TokenKind.NONE;
        emit TokenRemoved(token);
    }

    /// @notice Змінити максимальний допустимий "вік" ціни з оракула.
    function setMaxOracleStaleness(uint256 newStaleness) external onlyRole(DAO_ROLE) {
        require(newStaleness > 0, "TipJar: zero staleness");
        maxOracleStaleness = newStaleness;
        emit MaxOracleStalenessUpdated(newStaleness);
    }

    /**
     * @notice Змінити частки автора (а отже — "податок" у Support Pool) для всіх
     *         трьох рівнів одночасно. Викликається ТІЛЬКИ через
     *         DaoGovernor → DaoTimelock (DAO_ROLE) — рішення приймається голосуванням.
     * @dev    Податок (частка пулу) для кожного рівня = BPS_DENOMINATOR - authorBps
     *         і має лежати в межах [MIN_TAX_BPS; MAX_TAX_BPS] = [5%; 50%].
     *         Параметри передаються одночасно для всіх рівнів, щоб уникнути
     *         тимчасового неконсистентного стану між пропозиціями.
     * @param newCouncilAuthorBps  Нова частка автора для COUNCIL-рівня (bps)
     * @param newShieldAuthorBps  Нова частка автора для SHIELD-рівня (bps)
     * @param newNoneAuthorBps    Нова частка автора для рівня без SBT (bps)
     */
    function setSplits(
        uint256 newCouncilAuthorBps,
        uint256 newShieldAuthorBps,
        uint256 newNoneAuthorBps
    ) external onlyRole(DAO_ROLE) {
        _validateTax(newCouncilAuthorBps);
        _validateTax(newShieldAuthorBps);
        _validateTax(newNoneAuthorBps);

        councilAuthorBps = newCouncilAuthorBps;
        shieldAuthorBps = newShieldAuthorBps;
        noneAuthorBps   = newNoneAuthorBps;

        emit SplitsUpdated(newCouncilAuthorBps, newShieldAuthorBps, newNoneAuthorBps, msg.sender);
    }

    /// @dev Перевіряє, що bps автора в принципі валідний (<=100%) і відповідний
    ///      податок (частка пулу) лежить у дозволеному діапазоні [5%; 50%].
    function _validateTax(uint256 authorBps) internal pure {
        require(authorBps <= BPS_DENOMINATOR, "TipJar: authorBps > 100%");
        uint256 taxBps = BPS_DENOMINATOR - authorBps;
        require(taxBps >= MIN_TAX_BPS && taxBps <= MAX_TAX_BPS, "TipJar: tax out of [5%,50%] range");
    }

    function _setStablecoin(
        address token,
        bool accepted,
        uint256 minAmount,
        uint256 _influencePerUnit
    ) internal {
        require(token != address(0), "TipJar: zero token");
        acceptedTokens[token] = accepted;
        minTipAmount[token]   = minAmount;
        influencePerUnit[token]  = _influencePerUnit;
        tokenKind[token]      = accepted ? TokenKind.STABLE : TokenKind.NONE;
        priceFeed[token]      = address(0); // стейблкоїн не використовує оракул
        emit StablecoinConfigured(token, accepted, minAmount, _influencePerUnit);
    }

    // ── Внутрішні ────────────────────────────────────────────────

    function _authorBps(address author) internal view returns (uint256) {
        if (councilSBT.isCouncilMember(author)) return councilAuthorBps;
        if (shieldSBT.isMember(author))       return shieldAuthorBps;
        return noneAuthorBps;
    }
}
