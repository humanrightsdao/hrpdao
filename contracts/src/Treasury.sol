// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./LocationRegistry.sol";
import "./CouncilRankingEpoch.sol";

/**
 * @title Treasury
 * @notice Основна казна ДАО. Уся логіка захисту зосереджена ТУТ, а не в
 *         DaoTimelock — бо Timelock виконує довільний calldata на
 *         довільну адресу і не має поняття "це виведення X токенів з
 *         казни". Якщо ВСІ кошти фізично лежать у Treasury, а єдиний шлях
 *         їх вивести — withdraw(), ліміти працюють незалежно від того, що
 *         саме "проголосував" DaoGovernor — навіть якщо сам Governor
 *         скомпрометовано.
 *
 * Шари захисту (кожен закриває окремий вектор атаки):
 *   1. minDelay Timelock-у (72г+) — базова затримка ВСІХ рішень ДАО
 *      (це вже є в DaoTimelock, тут не дублюється).
 *   2. perTxCapBps — не більше X% поточного балансу за ОДНЕ виведення.
 *      Захищає від одноразового обнулення казни.
 *   3. rollingCapBps — не більше Y% СУКУПНО за rollingWindow (30 днів
 *      дефолт, DAO-керовано). Захищає від атаки "10 послідовних виведень
 *      по 10%".
 *   4. absoluteCapPerTx — $-стеля на токен, незалежно від %. Захищає від
 *      того, що % від дуже великої казни все одно є величезною сумою.
 *   5. allowlist отримувачів + recipientCooldown (14д дефолт, DAO-керовано) —
 *      виведення можливе лише на заздалегідь відомі адреси, і нова адреса
 *      стає "дійсною" не одразу. Захищає від "додати шкідливу адресу й
 *      одразу вивести туди все в межах того самого голосування".
 *   6. GUARDIAN_ROLE.guardianPause() — незалежний мультисиг може МИТТЄВО
 *      зупинити всі withdraw() без жодної затримки, як тільки помічено
 *      підозрілу активність. Guardian не може рухати кошти й не може сам
 *      зняти паузу (unpause лише через Timelock) — щоб сам guardian не
 *      став точкою постійного контролю.
 *
 * Хто ким керує:
 *   TREASURER_ROLE → DaoTimelock (усі DAO-рішення проходять minDelay)
 *   GUARDIAN_ROLE  → окремий мультисиг, призначається/змінюється ЛИШЕ
 *                     через TREASURER_ROLE (тобто через голосування +
 *                     Timelock, guardian не може сам себе замінити)
 *
 * ── ЕТАП 4 гео-реформи: розширення (додано, стара логіка НЕ змінена
 *    по суті — лише withdraw()/availableToWithdraw() тепер рахують
 *    ліміти від ВІЛЬНОГО балансу, за вирахуванням earmarked-коштів) ──
 *
 *   - depositTax()/depositTaxNative(): 5% (OPERATIONAL_BPS, ЖОРСТКА
 *     константа без шляху зміни — узгоджено явно) → operationalBalance;
 *     залишок 95% розподіляється МИТТЄВО, ПРЯМИМ переказом (за зразком
 *     TipJar.tip() — жодного claim()/офчейн-снапшоту для самих грошей)
 *     по H3-ланцюжку предків платника, лише між РІВНЯМИ, що фактично
 *     активні для його гілки (Варіант Y, CouncilRankingEpoch.
 *     activeLevelsForAccount()) — рівномірно, з дробовим залишком
 *     (dust) на найглибший активний рівень.
 *   - hexBalance / operationalBalance — EARMARKED кошти. totalEarmarked
 *     віднімається від сирого token-балансу при розрахунку лімітів
 *     ЗВИЧАЙНОГO withdraw() — інакше загальний TREASURER_ROLE міг би
 *     випадково зачепити вже розподілені по гексагонах кошти лімітами,
 *     порахованими від "чужого" балансу.
 *   - withdrawFromHex(): витрата coштів КОНКРЕТНОГО вузла (гексагону чи
 *     рівня -1) — дозволено hexController[nodeKey] (якщо явно призначений,
 *     setHexController) АБО TREASURER_ROLE (=daoTimelock) як універсальний
 *     fallback-контролер для БУДЬ-ЯКОГО вузла (⚠️ ВИРІШЕНО, було відкритим
 *     "питанням Етапу 5" — рішення: СПІЛЬНИЙ daoTimelock, "перевірка
 *     вузла" відбувається РАНІШЕ, на етапі голосування, через
 *     DaoGovernor.proposeScoped()/_countVote() — лише мешканці цієї
 *     території можуть проголосувати за пропозицію, що виконує
 *     withdrawFromHex() саме для їхнього вузла; окремий hexController
 *     лишається можливим для гексагонів, яким ДАО хоче дати більшу
 *     автономію — напр. делегувати окремому мультисигу/під-ДАО). Ті самі
 *     % ліміти (perTxCapBps/rollingCapBps/absoluteCapPerTx), але
 *     масштабовані від БАЛАНСУ САМОГО ВУЗЛА, не всієї казни, + окремий
 *     allowlist recipients per-вузол.
 *   - withdrawOperational(): витрата operationalBalance, той самий
 *     TREASURER_ROLE, ті самі % ліміти, масштабовані від
 *     operationalBalance, окрема rolling-історія.
 */
contract Treasury is AccessControl, Pausable {
    using SafeERC20 for IERC20;
    // (using H3Utils for uint64; прибрано в Гео-реформі v12 — предки
    // тепер читаються вже ZK-перевіреними з LocationRegistry)

    bytes32 public constant TREASURER_ROLE = keccak256("TREASURER_ROLE"); // = DaoTimelock
    bytes32 public constant GUARDIAN_ROLE  = keccak256("GUARDIAN_ROLE");  // незалежний мультисиг

    /// @notice ⚠️ ВИРІШЕННЯ ПРОГАЛИНИ: "спільнотна" (community/pool) частка
    ///         донату з TipJar раніше йшла в Treasury ЗВИЧАЙНИМ ERC-20-
    ///         трансфером, НІКОЛИ не торкаючись hexBalance/_routeTax —
    ///         тобто гроші від донатів фізично лежали в Treasury, але
    ///         жоден hexController() не міг їх вивести через withdrawFromHex(),
    ///         бо formально вони НЕ були "закредитовані" на жоден вузол.
    ///         TIPJAR_ROLE — новий, окремий від TREASURER_ROLE/GUARDIAN_ROLE
    ///         дозвіл лише на creditFromTip() нижче.
    bytes32 public constant TIPJAR_ROLE = keccak256("TIPJAR_ROLE");

    /// @notice Умовне позначення нативного ETH (не ERC-20).
    address public constant NATIVE = address(0);

    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Довжина rolling-вікна для rollingCapBps (секунди). Було
    ///         жорсткою константою (30 днів) без шляху зміни — тепер
    ///         DAO-керований параметр, як perTxCapBps/rollingCapBps.
    ///         Встановлюється в конструкторі (14/30 днів для mainnet,
    ///         короткі значення для testnet — той самий принцип, що
    ///         GovernorConfig у DaoGovernor), і надалі змінюється лише
    ///         через setRollingWindow() (TREASURER_ROLE).
    uint256 public rollingWindow;

    /// @notice Затримка між додаванням адреси в allowlist і першою
    ///         можливістю на неї вивести кошти (секунди). Було жорсткою
    ///         константою (14 днів) — тепер DAO-керований параметр з тих
    ///         самих причин, що й rollingWindow вище.
    uint256 public recipientCooldown;

    /// @notice Верхні межі для setRollingWindow()/setRecipientCooldown() —
    ///         захист від випадкового встановлення абсурдно довгого
    ///         значення через governance-помилку (сама наявність сеттера
    ///         не повинна означати необмежену свободу).
    uint256 public constant MAX_ROLLING_WINDOW     = 365 days;
    uint256 public constant MAX_RECIPIENT_COOLDOWN = 365 days;

    /// @notice Максимум % поточного балансу за ОДНЕ виведення (bps). DAO-керовано.
    uint256 public perTxCapBps = 1_000;   // 10% — дефолт за вашою пропозицією

    /// @notice Максимум % поточного балансу СУКУПНО за rollingWindow (bps). DAO-керовано.
    uint256 public rollingCapBps = 2_500; // 25% за 30 днів — дефолт

    /// @notice $-стеля на ОДНЕ виведення, per token (0 = стелі немає, діє лише %).
    mapping(address => uint256) public absoluteCapPerTx;

    struct Withdrawal { uint256 timestamp; uint256 amount; }
    /// @notice Історія виведень per token — для обрахунку rolling-window
    ///         ЗАГАЛЬНОГО (вільного) балансу.
    mapping(address => Withdrawal[]) private _withdrawals;

    /// @notice Дозволені отримувачі (загальний, DAO-рівень). Виведення на
    ///         будь-яку іншу адресу — revert.
    mapping(address => bool) public allowedRecipient;
    /// @notice Час додавання в allowlist — для recipientCooldown.
    mapping(address => uint256) public recipientAddedAt;

    event Deposited(address indexed token, address indexed from, uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount, address indexed executedBy);
    event RecipientAllowlisted(address indexed recipient, bool allowed, uint256 cooldownEndsAt);
    event PerTxCapUpdated(uint256 newBps);
    event RollingCapUpdated(uint256 newBps);
    event AbsoluteCapUpdated(address indexed token, uint256 newCap);
    event GuardianPaused(address indexed guardian);
    event RollingWindowUpdated(uint256 newWindow);
    event RecipientCooldownUpdated(uint256 newCooldown);

    /**
     * @param timelock   DaoTimelock — єдиний TREASURER_ROLE
     * @param guardians  Незалежний мультисиг(и) — GUARDIAN_ROLE (emergency pause)
     * @param _locationRegistry  Етап 2 — джерело hexId платника
     * @param _rankingEpoch      Етап 3 — activeLevelsForAccount() для Варіанту Y
     * @param _rollingWindow     Початкове rolling-вікно (секунди). Рекомендовано
     *                           30 днів на mainnet, короткі значення (хвилини)
     *                           на testnet для швидкого тестового циклу.
     * @param _recipientCooldown Початковий cooldown нового отримувача (секунди).
     *                           Рекомендовано 14 днів на mainnet, короткі
     *                           значення на testnet.
     */
    constructor(
        address timelock,
        address[] memory guardians,
        address _locationRegistry,
        address _rankingEpoch,
        uint256 _rollingWindow,
        uint256 _recipientCooldown
    ) {
        require(timelock != address(0), "Treasury: zero timelock");
        require(_locationRegistry != address(0), "Treasury: zero locationRegistry");
        require(_rankingEpoch != address(0), "Treasury: zero rankingEpoch");
        require(_rollingWindow > 0 && _rollingWindow <= MAX_ROLLING_WINDOW, "Treasury: invalid rolling window");
        require(_recipientCooldown <= MAX_RECIPIENT_COOLDOWN, "Treasury: invalid recipient cooldown");

        locationRegistry = LocationRegistry(_locationRegistry);
        rankingEpoch      = CouncilRankingEpoch(_rankingEpoch);
        rollingWindow     = _rollingWindow;
        recipientCooldown = _recipientCooldown;

        _grantRole(TREASURER_ROLE, timelock);
        _setRoleAdmin(TREASURER_ROLE, TREASURER_ROLE); // самокероване, як інші DAO-ролі в проєкті
        _setRoleAdmin(GUARDIAN_ROLE, TREASURER_ROLE);  // лише DAO може призначати/змінювати guardians
        _setRoleAdmin(TIPJAR_ROLE, TREASURER_ROLE);    // лише DAO може підключити/відключити TipJar

        for (uint256 i = 0; i < guardians.length; i++) {
            _grantRole(GUARDIAN_ROLE, guardians[i]);
        }
        // DEFAULT_ADMIN_ROLE нікому не видається — узгоджено з рештою архітектури.
    }

    /// @notice Змінити довжину rolling-вікна. TREASURER_ROLE (тобто через
    ///         DAO-голосування + Timelock). Дозволяє, зокрема, тестовому
    ///         деплою пришвидшити повний цикл withdraw-тестів, а mainnet —
    ///         скоригувати вікно пізніше без редеплою всього Treasury.
    function setRollingWindow(uint256 newWindow) external onlyRole(TREASURER_ROLE) {
        require(newWindow > 0 && newWindow <= MAX_ROLLING_WINDOW, "Treasury: invalid rolling window");
        rollingWindow = newWindow;
        emit RollingWindowUpdated(newWindow);
    }

    /// @notice Змінити cooldown нового отримувача. TREASURER_ROLE.
    function setRecipientCooldown(uint256 newCooldown) external onlyRole(TREASURER_ROLE) {
        require(newCooldown <= MAX_RECIPIENT_COOLDOWN, "Treasury: invalid recipient cooldown");
        recipientCooldown = newCooldown;
        emit RecipientCooldownUpdated(newCooldown);
    }

    /// @notice Підключити/відключити TipJar. TREASURER_ROLE (тобто через
    ///         голосування ДАО + Timelock) — той самий патерн, що
    ///         InfluenceRegistry.setTipJar() раніше.
    function setTipJarRole(address tipJar, bool enabled) external onlyRole(TREASURER_ROLE) {
        if (enabled) _grantRole(TIPJAR_ROLE, tipJar);
        else _revokeRole(TIPJAR_ROLE, tipJar);
    }

    // ── Депозити (загальні, БЕЗ гео-маршрутизації) ──────────────────

    receive() external payable {
        emit Deposited(NATIVE, msg.sender, msg.value);
    }

    /// @notice Внести довільний ERC-20 у вільний баланс казни (без гео-
    ///         маршрутизації, без earmarking). Рахує РЕАЛЬНУ дельту
    ///         балансу контракту (before/after), а не номінальний `amount`
    ///         — токени з комісією за трансфер (fee-on-transfer) чи
    ///         ребейзингом інакше розсинхронізували б облік із реальним
    ///         балансом. Для звичайних ERC-20 (як MockERC20) received == amount.
    function depositERC20(address token, uint256 amount) external {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        emit Deposited(token, msg.sender, received);
    }

    // ── Виведення (єдиний шлях коштів З казни) ─────────────────────

    /**
     * @notice Вивести кошти із ВІЛЬНОГО (не earmarked) балансу. Викликається
     *         ЛИШЕ DaoTimelock — тобто вже пройшло голосування + minDelay.
     *         Ліміти нижче застосовуються ДОДАТКОВО й незалежно від того,
     *         що затвердив Timelock.
     * @param token address(0) для ETH, або адреса ERC-20.
     */
    function withdraw(address token, address to, uint256 amount)
        external
        onlyRole(TREASURER_ROLE)
        whenNotPaused
    {
        require(allowedRecipient[to], "Treasury: recipient not allowlisted");
        require(
            block.timestamp >= recipientAddedAt[to] + recipientCooldown,
            "Treasury: recipient still in cooldown"
        );

        uint256 balance = _freeBalance(token);
        require(balance > 0, "Treasury: empty balance");

        uint256 perTxCap = (balance * perTxCapBps) / BPS_DENOMINATOR;
        uint256 absCap = absoluteCapPerTx[token];
        if (absCap > 0 && absCap < perTxCap) perTxCap = absCap;
        require(amount <= perTxCap, "Treasury: exceeds per-tx cap");

        uint256 rollingCap = (balance * rollingCapBps) / BPS_DENOMINATOR;
        require(_rollingWindowUsed(token) + amount <= rollingCap, "Treasury: exceeds rolling-window cap");

        _withdrawals[token].push(Withdrawal({ timestamp: block.timestamp, amount: amount }));

        _payOut(token, to, amount);

        emit Withdrawn(token, to, amount, msg.sender);
    }

    /// @dev Вільний (не earmarked під hex/operational) баланс токена —
    ///      саме від нього рахуються ліміти звичайного withdraw().
    function _freeBalance(address token) internal view returns (uint256) {
        uint256 raw = token == NATIVE ? address(this).balance : IERC20(token).balanceOf(address(this));
        uint256 earmarked = totalEarmarked[token];
        return raw > earmarked ? raw - earmarked : 0;
    }

    function _payOut(address token, address to, uint256 amount) private {
        if (token == NATIVE) {
            (bool ok, ) = to.call{value: amount}("");
            require(ok, "Treasury: native transfer failed");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    /// @dev Сума виведень за останні rollingWindow секунд для токена.
    ///      Масив хронологічний (push у кінець) — ітеруємо з кінця й
    ///      зупиняємось на першому елементі поза вікном.
    ///      ⚠️ Gas-примітка: при дуже частих дрібних виведеннях (сотні за
    ///      30 днів) цикл дорожчає. Для типової казни (рідкі великі
    ///      транзакції) це не проблема; якщо профіль використання
    ///      зміниться — розглянути checkpoint-структуру замість масиву.
    function _rollingWindowUsed(address token) internal view returns (uint256 total) {
        Withdrawal[] storage list = _withdrawals[token];
        uint256 cutoff = block.timestamp > rollingWindow ? block.timestamp - rollingWindow : 0;
        for (uint256 i = list.length; i > 0; i--) {
            Withdrawal storage w = list[i - 1];
            if (w.timestamp < cutoff) break;
            total += w.amount;
        }
    }

    // ── Guardian: emergency circuit breaker ────────────────────────

    /// @notice Миттєва пауза БЕЗ затримки — єдина дія guardian виконує
    ///         самостійно. Не рухає кошти, лише блокує withdraw().
    function guardianPause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
        emit GuardianPaused(msg.sender);
    }

    /// @notice Зняти паузу може ЛИШЕ TREASURER_ROLE (тобто звичайна
    ///         governance-процедура з minDelay) — guardian свідомо НЕ може
    ///         розблокувати сам, інакше він перетворюється на постійну
    ///         точку контролю над казною замість екстреного гальма.
    function unpause() external onlyRole(TREASURER_ROLE) {
        _unpause();
    }

    // ── DAO governance: ліміти й allowlist (лише через Timelock) ───

    /// @notice perTxCapBps не може перевищувати rollingCapBps — симетрична
    ///         перевірка до тієї, що вже була в setRollingCapBps() (яка
    ///         вимагає newBps >= perTxCapBps). Без цього можна було
    ///         встановити perTxCapBps > rollingCapBps окремим викликом,
    ///         порушуючи очікуваний інваріант "perTx ≤ rolling" (не
    ///         вразливість — обидва ліміти й так перевіряються незалежно
    ///         на кожному виведенні — але невірний інваріант для тих, хто
    ///         на нього покладається).
    function setPerTxCapBps(uint256 newBps) external onlyRole(TREASURER_ROLE) {
        require(newBps > 0 && newBps <= rollingCapBps, "Treasury: must be <= rollingCapBps");
        perTxCapBps = newBps;
        emit PerTxCapUpdated(newBps);
    }

    function setRollingCapBps(uint256 newBps) external onlyRole(TREASURER_ROLE) {
        require(newBps >= perTxCapBps && newBps <= BPS_DENOMINATOR, "Treasury: must be >= perTxCapBps");
        rollingCapBps = newBps;
        emit RollingCapUpdated(newBps);
    }

    function setAbsoluteCapPerTx(address token, uint256 newCap) external onlyRole(TREASURER_ROLE) {
        absoluteCapPerTx[token] = newCap;
        emit AbsoluteCapUpdated(token, newCap);
    }

    /**
     * @notice Додати/прибрати адресу з allowlist отримувачів. Додавання
     *         запускає recipientCooldown (14д дефолт, DAO-керовано) — навіть якщо пропозиція
     *         "додати адресу X і вивести туди Y" пройшла весь Timelock за
     *         одне голосування, реальне виведення стане можливим лише
     *         через 14 днів після додавання адреси. Прибирання діє одразу.
     */
    function setAllowedRecipient(address recipient, bool allowed) external onlyRole(TREASURER_ROLE) {
        require(recipient != address(0), "Treasury: zero recipient");
        allowedRecipient[recipient] = allowed;
        uint256 cooldownEndsAt;
        if (allowed) {
            recipientAddedAt[recipient] = block.timestamp;
            cooldownEndsAt = block.timestamp + recipientCooldown;
        }
        emit RecipientAllowlisted(recipient, allowed, cooldownEndsAt);
    }

    // ── Читання (загальне) ──────────────────────────────────────

    function rollingWindowUsed(address token) external view returns (uint256) {
        return _rollingWindowUsed(token);
    }

    /// @notice Скільки максимум можна вивести ЗАРАЗ із ВІЛЬНОГО балансу
    ///         (мінімум з усіх лімітів).
    function availableToWithdraw(address token) external view returns (uint256) {
        uint256 balance = _freeBalance(token);

        uint256 perTxCap = (balance * perTxCapBps) / BPS_DENOMINATOR;
        uint256 absCap = absoluteCapPerTx[token];
        if (absCap > 0 && absCap < perTxCap) perTxCap = absCap;

        uint256 rollingCap = (balance * rollingCapBps) / BPS_DENOMINATOR;
        uint256 used = _rollingWindowUsed(token);
        uint256 rollingRemaining = used >= rollingCap ? 0 : rollingCap - used;

        return perTxCap < rollingRemaining ? perTxCap : rollingRemaining;
    }

    // ════════════════════════════════════════════════════════════
    // ЕТАП 4: гео-маршрутизація податку (депозит) + per-hex/operational
    // withdraw
    // ════════════════════════════════════════════════════════════

    LocationRegistry     public immutable locationRegistry;
    CouncilRankingEpoch  public immutable rankingEpoch;

    /// @notice Операційний відсоток — ЖОРСТКА КОНСТАНТА (узгоджено явно:
    ///         без шляху зміни через голосування; зміна можлива лише
    ///         повним редеплоєм/апгрейдом цього контракту).
    uint256 public constant OPERATIONAL_BPS = 500; // 5%

    int8   private constant _LEVEL_EARTH  = -1;
    uint64 private constant _EARTH_BRANCH = 0;

    /// @notice EARMARKED баланс кожного вузла (рівень -1..3, за branchId).
    ///         Ключ — _nodeKey(level, branchId), той самий алгоритм, що й
    ///         у CouncilRankingEpoch.
    mapping(address => mapping(bytes32 => uint256)) public hexBalance;

    /// @notice EARMARKED операційний баланс (5% з кожного depositTax).
    mapping(address => uint256) public operationalBalance;

    /// @notice Сума ВСІХ earmarked-коштів (hexBalance + operationalBalance)
    ///         per token — віднімається від сирого балансу для лімітів
    ///         звичайного withdraw().
    mapping(address => uint256) public totalEarmarked;

    /// @notice Адреса, уповноважена розпоряджатись коштами конкретного
    ///         вузла (withdrawFromHex + власний allowlist). 0 = ще не
    ///         призначено — кошти вузла просто накопичуються безпечно, без
    ///         можливості виведення, доки DAO не призначить контролера.
    mapping(bytes32 => address) public hexController;

    mapping(bytes32 => mapping(address => bool))    public hexAllowedRecipient;
    mapping(bytes32 => mapping(address => uint256)) public hexRecipientAddedAt;
    mapping(address => mapping(bytes32 => Withdrawal[])) private _hexWithdrawals;

    mapping(address => Withdrawal[]) private _operationalWithdrawals;

    event TaxDeposited(address indexed token, address indexed from, uint256 amount, uint256 operationalCut);
    event TipCredited(address indexed token, address indexed author, uint256 amount, uint256 operationalCut);
    event HexCredited(address indexed token, bytes32 indexed nodeKey, int8 level, uint64 branchId, uint256 amount);
    event HexWithdrawn(address indexed token, bytes32 indexed nodeKey, address indexed to, uint256 amount, address executedBy);
    event OperationalWithdrawn(address indexed token, address indexed to, uint256 amount, address indexed executedBy);
    event HexControllerUpdated(bytes32 indexed nodeKey, address indexed controller);
    event HexRecipientAllowlisted(bytes32 indexed nodeKey, address indexed recipient, bool allowed, uint256 cooldownEndsAt);

    // ── Депозит податку з гео-маршрутизацією ───────────────────────

    /**
     * @notice Внести ERC-20 "податок" з автоматичною маршрутизацією:
     *         5% (OPERATIONAL_BPS) → operationalBalance; залишок 95% —
     *         миттєвим прямим кредитом (не claim!) по H3-ланцюжку
     *         предків msg.sender, лише між рівнями, активними для його
     *         гілки (CouncilRankingEpoch.activeLevelsForAccount).
     *         Якщо msg.sender не задекларував локацію — 100% залишку
     *         йде в рівень -1 (fallback, узгоджено раніше).
     */
    function depositTax(address token, uint256 amount) external {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        uint256 operational = _routeTax(token, msg.sender, received);
        emit TaxDeposited(token, msg.sender, received, operational);
    }

    /// @notice Той самий флоу, для нативного ETH.
    function depositTaxNative() external payable {
        uint256 operational = _routeTax(NATIVE, msg.sender, msg.value);
        emit TaxDeposited(NATIVE, msg.sender, msg.value, operational);
    }

    /**
     * @notice Внести "спільнотну" (community/pool) частку донату з TipJar
     *         — та сама каскадна маршрутизація по гексагонах, що вже й так
     *         є в depositTax()/_routeTax(), АЛЕ явним параметром `author`
     *         (чия ЛОКАЦІЯ визначає розподіл по поверхах — не msg.sender:
     *         TipJar як контракт не має "локації", а тіпер (реальний
     *         відправник донату) анонімний і НЕ повинен впливати на
     *         маршрутизацію — узгоджено).
     *
     *         Токени тягнуться від msg.sender (TipJar) через safeTransferFrom
     *         — той самий патерн, що depositTax(), включно з balance-diff
     *         (fee-on-transfer-безпечно), тому TipJar має спершу approve()
     *         Treasury на суму `amount`.
     *
     *         5% OPERATIONAL_BPS застосовується і тут — ЖОДНОГО окремого
     *         "безподаткового" шляху для tip-коштів немає, щоб не
     *         створювати другий, неузгоджений з рештою Treasury канал.
     */
    function creditFromTip(address token, address author, uint256 amount)
        external
        onlyRole(TIPJAR_ROLE)
        returns (uint256 operational)
    {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;

        operational = _routeTax(token, author, received);
        emit TipCredited(token, author, received, operational);
    }

    function _routeTax(address token, address payer, uint256 amount) private returns (uint256 operational) {
        operational = (amount * OPERATIONAL_BPS) / BPS_DENOMINATOR;
        uint256 remaining = amount - operational;

        operationalBalance[token] += operational;
        totalEarmarked[token]     += operational;

        uint8 activeLevels = rankingEpoch.activeLevelsForAccount(payer);
        uint256 share = remaining / activeLevels;
        uint256 dust  = remaining - (share * uint256(activeLevels));

        // ⚠️ Гео-реформа v12 (ZK-приватність): раніше тут читався сирий
        // hexId і резолюція, і предки рахувались через H3Utils.ancestorOf().
        // Тепер hexId прихований (LocationRegistry зберігає лише
        // комітмент) — замість обчислення читаються ВЖЕ ZK-перевірені й
        // закешовані предки (LocationRegistry.getRevealedAncestor()),
        // узгоджені з activeLevels вище (обидва йдуть по ІДЕНТИЧНОМУ
        // ланцюжку nodeOverflowed, тому branchId тут гарантовано
        // ненульовий для r < activeLevels-1).
        bool onlyGlobal = (activeLevels == 1);
        _creditHex(token, _LEVEL_EARTH, _EARTH_BRANCH, share + (onlyGlobal ? dust : 0));

        for (uint8 r = 0; r + 1 < activeLevels; r++) {
            uint64 branchId = locationRegistry.getRevealedAncestor(payer, int8(uint8(r)));
            bool isLast = (r + 2 == activeLevels);
            _creditHex(token, int8(uint8(r)), branchId, share + (isLast ? dust : 0));
        }
    }

    function _creditHex(address token, int8 level, uint64 branchId, uint256 amount) private {
        if (amount == 0) return;
        bytes32 key = _nodeKey(level, branchId);
        hexBalance[token][key] += amount;
        totalEarmarked[token]  += amount;
        emit HexCredited(token, key, level, branchId, amount);
    }

    function _nodeKey(int8 level, uint64 branchId) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(level, branchId));
    }

    // ── Виведення з конкретного вузла (Council/-1) ──────────────────

    /**
     * @notice Призначити/змінити контролера вузла. Лише TREASURER_ROLE
     *         (тобто через DAO-голосування + Timelock). ОПЦІЙНО — daoTimelock
     *         і так уже може withdrawFromHex() для БУДЬ-ЯКОГО вузла напряму
     *         (див. NatSpec контракту вище) через гео-скоуповані пропозиції
     *         DaoGovernor; setHexController() потрібен лише якщо ДАО хоче
     *         делегувати КОНКРЕТНИЙ гексагон окремому контролеру
     *         (мультисиг, під-ДАО тощо) в обхід звичайного governance-флоу.
     */
    function setHexController(int8 level, uint64 branchId, address controller)
        external
        onlyRole(TREASURER_ROLE)
    {
        bytes32 key = _nodeKey(level, branchId);
        hexController[key] = controller;
        emit HexControllerUpdated(key, controller);
    }

    /// @notice Керувати allowlist отримувачів вузла може або сам його
    ///         контролер, або DAO напряму (TREASURER_ROLE, override).
    function setHexAllowedRecipient(int8 level, uint64 branchId, address recipient, bool allowed) external {
        bytes32 key = _nodeKey(level, branchId);
        require(
            msg.sender == hexController[key] || hasRole(TREASURER_ROLE, msg.sender),
            "Treasury: not authorized for this node"
        );
        require(recipient != address(0), "Treasury: zero recipient");

        hexAllowedRecipient[key][recipient] = allowed;
        uint256 cooldownEndsAt;
        if (allowed) {
            hexRecipientAddedAt[key][recipient] = block.timestamp;
            cooldownEndsAt = block.timestamp + recipientCooldown;
        }
        emit HexRecipientAllowlisted(key, recipient, allowed, cooldownEndsAt);
    }

    /**
     * @notice Вивести кошти конкретного вузла (гексагону чи рівня -1).
     *         Ті самі % ліміти, що й загальний withdraw(), але масштабовані
     *         від балансу САМОГО ВУЗЛА, не всієї казни.
     */
    function withdrawFromHex(int8 level, uint64 branchId, address token, address to, uint256 amount)
        external
        whenNotPaused
    {
        bytes32 key = _nodeKey(level, branchId);
        // ⚠️ ВИРІШЕННЯ "Етапу 4/5" (див. NatSpec контракту вище): замість
        // окремого per-hex Timelock — СПІЛЬНИЙ daoTimelock (TREASURER_ROLE)
        // як універсальний fallback-контролер для БУДЬ-ЯКОГО вузла, в
        // доповнення до (не замість) явно призначеного hexController[key].
        // "Перевірка вузла" (чи справді ЦЕЙ гексагон уповноважив витрату)
        // вже відбулась РАНІШЕ, на етапі голосування —
        // DaoGovernor.proposeScoped()/_countVote() дозволяють голосувати
        // за пропозицію, що виконує withdrawFromHex(level, branchId, ...),
        // ЛИШЕ мешканцям САМЕ цієї території (чи глибше в ній). Коли така
        // пропозиція успішно проходить і виконується через daoTimelock —
        // довіра вже встановлена самим governance-процесом, так само, як
        // і для будь-якої іншої дії, що виконує daoTimelock. Явно
        // призначений hexController[key] (setHexController) лишається
        // можливим — напр. якщо ДАО хоче делегувати конкретний гексагон
        // окремому мультисигу/під-ДАО для більшої автономії.
        require(
            msg.sender == hexController[key] || hasRole(TREASURER_ROLE, msg.sender),
            "Treasury: not hex controller"
        );
        require(hexAllowedRecipient[key][to], "Treasury: recipient not allowlisted for node");
        require(
            block.timestamp >= hexRecipientAddedAt[key][to] + recipientCooldown,
            "Treasury: recipient still in cooldown"
        );

        uint256 bal = hexBalance[token][key];
        require(bal > 0, "Treasury: empty node balance");

        uint256 perTxCap = (bal * perTxCapBps) / BPS_DENOMINATOR;
        uint256 absCap = absoluteCapPerTx[token];
        if (absCap > 0 && absCap < perTxCap) perTxCap = absCap;
        require(amount <= perTxCap, "Treasury: exceeds per-tx cap");

        uint256 rollingCap = (bal * rollingCapBps) / BPS_DENOMINATOR;
        require(
            _hexRollingWindowUsed(token, key) + amount <= rollingCap,
            "Treasury: exceeds rolling-window cap"
        );

        _hexWithdrawals[token][key].push(Withdrawal({ timestamp: block.timestamp, amount: amount }));
        hexBalance[token][key] -= amount;
        totalEarmarked[token]  -= amount;

        _payOut(token, to, amount);

        emit HexWithdrawn(token, key, to, amount, msg.sender);
    }

    function _hexRollingWindowUsed(address token, bytes32 key) internal view returns (uint256 total) {
        Withdrawal[] storage list = _hexWithdrawals[token][key];
        uint256 cutoff = block.timestamp > rollingWindow ? block.timestamp - rollingWindow : 0;
        for (uint256 i = list.length; i > 0; i--) {
            Withdrawal storage w = list[i - 1];
            if (w.timestamp < cutoff) break;
            total += w.amount;
        }
    }

    // ── Виведення операційного фонду ───────────────────────────────

    /// @notice Витрата operationalBalance — TREASURER_ROLE, ті самі %
    ///         ліміти, масштабовані від operationalBalance[token].
    function withdrawOperational(address token, address to, uint256 amount)
        external
        onlyRole(TREASURER_ROLE)
        whenNotPaused
    {
        require(allowedRecipient[to], "Treasury: recipient not allowlisted");
        require(
            block.timestamp >= recipientAddedAt[to] + recipientCooldown,
            "Treasury: recipient still in cooldown"
        );

        uint256 bal = operationalBalance[token];
        require(bal > 0, "Treasury: empty operational balance");

        uint256 perTxCap = (bal * perTxCapBps) / BPS_DENOMINATOR;
        uint256 absCap = absoluteCapPerTx[token];
        if (absCap > 0 && absCap < perTxCap) perTxCap = absCap;
        require(amount <= perTxCap, "Treasury: exceeds per-tx cap");

        uint256 rollingCap = (bal * rollingCapBps) / BPS_DENOMINATOR;
        require(
            _operationalRollingWindowUsed(token) + amount <= rollingCap,
            "Treasury: exceeds rolling-window cap"
        );

        _operationalWithdrawals[token].push(Withdrawal({ timestamp: block.timestamp, amount: amount }));
        operationalBalance[token] -= amount;
        totalEarmarked[token]     -= amount;

        _payOut(token, to, amount);

        emit OperationalWithdrawn(token, to, amount, msg.sender);
    }

    function _operationalRollingWindowUsed(address token) internal view returns (uint256 total) {
        Withdrawal[] storage list = _operationalWithdrawals[token];
        uint256 cutoff = block.timestamp > rollingWindow ? block.timestamp - rollingWindow : 0;
        for (uint256 i = list.length; i > 0; i--) {
            Withdrawal storage w = list[i - 1];
            if (w.timestamp < cutoff) break;
            total += w.amount;
        }
    }

    // ── Читання (гео-розширення) ────────────────────────────────

    function nodeKeyOf(int8 level, uint64 branchId) external pure returns (bytes32) {
        return _nodeKey(level, branchId);
    }

    function hexRollingWindowUsed(address token, int8 level, uint64 branchId) external view returns (uint256) {
        return _hexRollingWindowUsed(token, _nodeKey(level, branchId));
    }

    function operationalRollingWindowUsed(address token) external view returns (uint256) {
        return _operationalRollingWindowUsed(token);
    }

    /// @notice Скільки максимум можна вивести ЗАРАЗ із балансу конкретного
    ///         вузла (мінімум з усіх лімітів, за зразком availableToWithdraw()).
    function hexAvailableToWithdraw(address token, int8 level, uint64 branchId) external view returns (uint256) {
        bytes32 key = _nodeKey(level, branchId);
        uint256 bal = hexBalance[token][key];

        uint256 perTxCap = (bal * perTxCapBps) / BPS_DENOMINATOR;
        uint256 absCap = absoluteCapPerTx[token];
        if (absCap > 0 && absCap < perTxCap) perTxCap = absCap;

        uint256 rollingCap = (bal * rollingCapBps) / BPS_DENOMINATOR;
        uint256 used = _hexRollingWindowUsed(token, key);
        uint256 rollingRemaining = used >= rollingCap ? 0 : rollingCap - used;

        return perTxCap < rollingRemaining ? perTxCap : rollingRemaining;
    }
}
