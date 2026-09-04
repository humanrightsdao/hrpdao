// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import "./InfluenceRegistry.sol";
import "./HumanityGate.sol";
import "./PolicyConsentGate.sol";

/**
 * @title ShieldSBT
 * @notice Soulbound Token (ERC-5192) статусу «Захисник» — базового рівня
 *         участі в HR DAO. Це СТАТУС учасника (непередаваний, прив'язаний
 *         до адреси), а не членство в окремій палаті чи будівлі.
 *
 * Зміни відносно оригінального ShieldSBT:
 *   - VOICE → Influence (InfluenceRegistry замість VoiceScoreRegistry), порядок дії
 *     не змінився: mint дозволено при currentInfluence >= 200 (INFLUENCE_THRESHOLD,
 *     див. нижче).
 *   - World ID → Human Passport → HumanityGate: перевірка людяності тепер
 *     іде через ОКРЕМИЙ, ОДИН РАЗ задеплоєний HumanityGate-контракт
 *     (спільний з CouncilSBT), а не через успадкований PassportGate.
 *     HumanityGate сам тримає керований DAO реєстр провайдерів (Human
 *     Passport, World ID, BrightID, майбутні) — тож заміна/додавання
 *     провайдера більше не вимагає редеплою ShieldSBT взагалі. Статус
 *     Захисника використовує НИЖЧИЙ поріг score (легший бар'єр), ніж
 *     статус Консула (CouncilSBT). Поріг DAO-керований через
 *     setMinHumanityScore() — той самий паттерн, що influencePerUnit у TipJar
 *     (число, не price-оракул).
 *   - Внутрішній slash-механізм (proposeSlash/voteSlash/executeSlash)
 *     винесено в окремий DisciplineModule, бо санкція проходить через
 *     двопалатний процес Shield-голос → veto-вікно 10 днів →
 *     veto-голосування Council (50%+). ShieldSBT натомість надає вузький
 *     хук burnByDiscipline(), який може викликати лише DisciplineModule
 *     (DISCIPLINE_ROLE) після завершення всієї процедури.
 *   - ДОДАНО testMode: для ТЕСТОВОГО деплою (testnet) DAO може встановити
 *     прискорений термін очікування статусу Консула замість 180д/365д/730д,
 *     щоб не чекати реальний час під час тестування. testMode фіксується
 *     ОДНОРАЗОВО в конструкторі (immutable) — неможливо "увімкнути"
 *     заднім числом на контракті, задеплоєному з testMode = false.
 *     ⚠️ На mainnet деплоїти ЗАВЖДИ з testMode = false.
 *
 * Правила:
 *   - Mint: відкритий, якщо currentInfluence >= INFLUENCE_THRESHOLD (200) +
 *     HumanityGate.verifyHuman() проходить (за поточним активним
 *     провайдером/провайдерами і поточним режимом агрегації).
 *   - Transfer: назавжди заблоковано (locked = true).
 *   - 1 адреса = 1 токен.
 *
 * ⚠️ ДЕПЛОЙ: після деплою ShieldSBT governor HumanityGate МАЄ викликати
 * humanityGate.setAuthorizedCaller(address(shieldSBT), true) — інакше
 * mint() завжди revert-не на "HumanityGate: caller not authorized".
 * Повна впорядкована послідовність деплою — див. NatSpec контракту
 * HumanityGate у HumanityGate.sol.
 */
contract ShieldSBT is ERC721, AccessControl, PolicyConsentGate {
    using Checkpoints for Checkpoints.Trace208;

    /// @notice Історія totalSupply у часі (ключ — block.timestamp, ×48 біт).
    ///         Потрібна DaoGovernor-у для кворуму: без цього нові Shield-
    ///         власники, що з'явились ПІСЛЯ старту голосування, могли б
    ///         впливати на знаменник кворуму заднім числом (жива
    ///         totalSupply() відображає стан НА МОМЕНТ читання, а не на
    ///         момент snapshot пропозиції).
    Checkpoints.Trace208 private _totalSupplyCheckpoints;

    /// @notice ⚠️ ВИРІШЕННЯ ПРОБЛЕМИ "неактивна більшість блокує голосування":
    ///         історія activeSupply у часі — той самий Trace208-патерн, що й
    ///         _totalSupplyCheckpoints, але рахує лише членів, що були АКТИВНІ
    ///         (influenceRegistry.lastActivityTimestamp в межах
    ///         inactivityWindow) — тобто якщо в ДАО 100 Shield-власників, але
    ///         реально активних лише 20, пороги явки/схвалення (DisciplineModule,
    ///         DaoGovernor.quorum) рахуються від ЦИХ 20, а не від усіх 100.
    ///         Це НЕ прибирає право голосу неактивних (вони можуть голосувати
    ///         будь-коли, автоматично повертаючись у активні через
    ///         syncActivityStatus()) — лише прибирає їх МОВЧАЗНУ, пасивну
    ///         присутність у ЗНАМЕННИКУ порогів. Див. syncActivityStatus() нижче.
    Checkpoints.Trace208 private _activeSupplyCheckpoints;

    /// @notice Чи акаунт ЗАРАЗ врахований у activeSupply (окремо від самого
    ///         членства — можна бути членом (isMember==true), але вже не
    ///         врахованим в activeSupply, якщо давно неактивний).
    mapping(address => bool) private _countedActive;

    /// @notice Після скількох секунд без активності (донат/голосування/
    ///         пропозиція/вето — будь-що, що чіпає
    ///         influenceRegistry.lastActivityTimestamp) член вважається
    ///         "неактивним" для цілей activeSupply. DAO-керований. Дефолт —
    ///         180 днів (орієнтовно, до підтвердження перед mainnet).
    uint256 public inactivityWindow = 180 days;

    // ── ERC-5192 інтерфейс ──────────────────────────────────────
    event Locked(uint256 tokenId);
    bytes4 private constant _INTERFACE_ID_ERC5192 = 0xb45a3c0e;

    // ── Ролі ────────────────────────────────────────────────────
    /// @notice Адреса DisciplineModule — єдиний, хто може burnByDiscipline().
    bytes32 public constant DISCIPLINE_ROLE = keccak256("DISCIPLINE_ROLE");

    /// @notice DaoTimelock — керує DISCIPLINE_ROLE. Сам собі адмін
    ///         (немає окремого мультисиг-адміна — однакові правила для всіх).
    bytes32 public constant DAO_ROLE = keccak256("DAO_ROLE");

    /// @notice Роль для контрольованої крос-чейн/крос-деплой міграції
    ///         даних (Influence/Shield/Council-статус) — див.
    ///         CROSS_CHAIN_MIGRATION_DESIGN.md. Видається ЛИШЕ контракту
    ///         MigrationClaim через setMigrationClaim(), і ЛИШЕ через
    ///         DAO governance (звичайний propose→vote→queue→execute).
    ///         За замовчуванням НІКОМУ не видана — dormant з дня генезису,
    ///         активується тільки якщо/коли DAO реально вирішить мігрувати
    ///         на новий деплой (той самий чи інший чейн). DAO зобов'язана
    ///         відкликати цю роль одразу після закриття вікна міграції —
    ///         постійно активна MIGRATION_ROLE була б бекдором для
    ///         довільного мінту в обхід перевірок Influence/humanity.
    bytes32 public constant MIGRATION_ROLE = keccak256("MIGRATION_ROLE");

    // ── Конфігурація ─────────────────────────────────────────────
    InfluenceRegistry public immutable influenceRegistry;

    /// @notice Спільний з CouncilSBT реєстр провайдерів людяності.
    HumanityGate public immutable humanityGate;

    uint256 public constant INFLUENCE_THRESHOLD = 200; // було 100, піднято до 200 (currentInfluence() - звичайне ціле число, 1 Influence = $1, НЕ 18-decimal)

    /// @notice Мінімальний score (масштабований на 100, тобто 2000 =
    ///         score 20.00) для mint Shield. Провайдер-агностичний —
    ///         залежить від того, які провайдери зараз активні в
    ///         humanityGate. DAO-керований.
    uint256 public minHumanityScore;

    // ── Термін очікування статусу Консула (фіксується тут, в момент отримання статусу Захисника) ──
    uint256 public constant YEAR1_GRACE_DURATION = 180 days; // ≈6 місяців
    uint256 public constant YEAR2_GRACE_DURATION = 365 days; // ≈12 місяців
    uint256 public constant STANDARD_DURATION    = 730 days; // 2 роки

    /// @notice true лише для testnet-деплою. Дозволяє DAO_ROLE встановити
    ///         testGraceDurationOverride. Immutable — фіксується в
    ///         конструкторі назавжди, не можна перемкнути після деплою.
    ///         На mainnet ЗАВЖДИ false.
    bool public immutable testMode;

    /// @notice Override grace-періоду ТІЛЬКИ для testMode (в секундах).
    ///         0 = override вимкнено, використовується нормальна логіка
    ///         _currentGraceDuration(). Діє лише якщо testMode == true —
    ///         навіть якщо значення тут випадково встановлено на
    ///         mainnet-деплої (testMode=false), воно ігнорується.
    uint256 public testGraceDurationOverride;

    // ── Стан ────────────────────────────────────────────────────
    uint256 private _tokenIdCounter;
    uint256 private _totalSupply;
    uint256 private _activeSupply;

    mapping(address => uint256) public accountToTokenId; // адреса → tokenId (0 = немає)

    /// @notice Час mint-у — точка відліку для терміну очікування статусу Консула.
    mapping(address => uint256) public memberSince;

    /// @notice Поріг терміну до статусу Консула, ЗАФІКСОВАНИЙ у момент
    ///         отримання статусу Захисника (узгоджено: визначається віком
    ///         проекту на момент ПЕРШОГО токена, не на момент спроби mint
    ///         Council).
    mapping(address => uint256) public requiredCouncilDuration;

    // ── Події ───────────────────────────────────────────────────
    event ShieldMinted(address indexed account, uint256 tokenId);
    event Slashed(address indexed account, uint256 tokenId, bytes32 violationPostRef);
    event MinHumanityScoreUpdated(uint256 newMinScore);
    event TestGraceDurationUpdated(uint256 newDuration);
    event ActivityStatusSynced(address indexed account, bool isActive, uint256 newActiveSupply);
    event InactivityWindowUpdated(uint256 newWindow);

    // ── Конструктор ─────────────────────────────────────────────
    /**
     * @param _influenceRegistry    Адреса InfluenceRegistry
     * @param dao                 DaoTimelock (DAO_ROLE) — керує DISCIPLINE_ROLE
     * @param _humanityGate       Адреса ОКРЕМО задеплоєного HumanityGate
     *                            (той самий контракт, що передається в
     *                            CouncilSBT) — ShieldSBT сам провайдерами
     *                            НЕ керує, лише читає/пише через нього
     * @param _minHumanityScore   Мінімальний score (×100) для mint статусу
     *                            Захисника — НИЖЧИЙ за поріг, який буде для
     *                            статусу Консула (CouncilSBT)
     * @param _testMode           true лише для testnet — дозволяє прискорений
     *                            термін очікування; на mainnet передавати false
     * @param _initialPolicyHash  keccak256() поточної редакції Політики прав
     *                            людини (humanrightspolicy.dao) на момент деплою
     * @param _initialPolicyURI   Де забрати текст політики (ipfs://CID або
     *                            https://humanrightspolicy.dao/...)
     */
    constructor(
        address _influenceRegistry,
        address dao,
        address _humanityGate,
        uint256 _minHumanityScore,
        bool _testMode,
        bytes32 _initialPolicyHash,
        string memory _initialPolicyURI
    )
        ERC721("HR DAO Shield", "SHIELD")
        PolicyConsentGate(_initialPolicyHash, _initialPolicyURI)
    {
        require(_humanityGate != address(0), "Shield: zero humanityGate");

        influenceRegistry     = InfluenceRegistry(_influenceRegistry);
        humanityGate        = HumanityGate(_humanityGate);
        minHumanityScore    = _minHumanityScore;
        testMode             = _testMode;

        _setRoleAdmin(DAO_ROLE, DAO_ROLE);
        _setRoleAdmin(POLICY_ADMIN_ROLE, DAO_ROLE);
        _grantRole(DAO_ROLE, dao);
        _grantRole(POLICY_ADMIN_ROLE, dao);
        if (msg.sender != dao) {
            _grantRole(DAO_ROLE, msg.sender); // тимчасово, для генезис-вайрингу
        }
    }

    // ── Mint ────────────────────────────────────────────────────

    /**
     * @notice Отримати SHIELD SBT.
     * Умови: currentInfluence >= 200 + HumanityGate.verifyHuman() проходить
     * + попередньо викликаний acceptPolicy(currentPolicyHash).
     * ⚠️ Юзер має ЗАЗДАЛЕГІДЬ пройти перевірку через один з АКТИВНИХ
     * провайдерів у humanityGate (Human Passport, World ID тощо — див.
     * humanityGate.getActiveProviders()) — інакше mint() revert-не на
     * "HumanityGate: score below threshold".
     * ⚠️ Юзер має ЗАЗДАЛЕГІДЬ викликати acceptPolicy() (2-tx flow) — інакше
     * mint() revert-не на "must accept Human Rights Policy". Для 1-tx flow
     * використовуйте mintWithPolicyConsent().
     */
    function mint() external {
        require(hasAcceptedCurrentPolicy(msg.sender), "Shield: must accept Human Rights Policy");
        _doMint(msg.sender);
    }

    /**
     * @notice Отримати SHIELD SBT і одночасно зафіксувати згоду з поточною
     *         Політикою прав людини — одна транзакція. `signature` — EIP-712
     *         підпис msg.sender над {account, policyHash, nonce, deadline}
     *         (nonce читається з consentNonce(msg.sender)).
     * @param policyHash Хеш редакції політики, яку показував фронтенд юзеру.
     *                    Має збігатись з currentPolicyHash — інакше revert
     *                    (захист від "політику оновили між підписом і tx").
     */
    function mintWithPolicyConsent(
        bytes32 policyHash,
        uint256 deadline,
        bytes calldata signature
    ) external {
        _consentBySignature(msg.sender, policyHash, deadline, signature);
        _doMint(msg.sender);
    }

    /**
     * @notice Мінтить ShieldSBT БЕЗ live-перевірки Influence/humanity — для
     *         контрольованої міграції даних (Merkle-proof уже верифікований
     *         MigrationClaim перед цим викликом, див.
     *         CROSS_CHAIN_MIGRATION_DESIGN.md). Викликається ЛИШЕ адресою
     *         з MIGRATION_ROLE (тобто лише затвердженим DAO контрактом
     *         MigrationClaim, і лише поки DAO не відкликала роль).
     * @param account          Отримувач (та сама адреса, що у знімку джерела).
     * @param originalMintedAt `memberSince` зі знімку джерела — зберігає
     *                          РЕАЛЬНИЙ стаж у статусі Захисника (важливо
     *                          для порогу переходу в Consul: якщо тут
     *                          поставити block.timestamp замість
     *                          оригінального значення, весь стаж хибно
     *                          "згорає" в момент міграції — несправедливо
     *                          для вже давніх, заслужених учасників).
     * @dev requiredCouncilDuration НАВМИСНО рахується заново від
     *      _currentGraceDuration() тут-і-зараз, а не переноситься зі
     *      знімку — grace-період залежить від "віку проєкту"
     *      (projectStartTimestamp в InfluenceRegistry), і поточне значення
     *      цього поля (перенесене окремо, якщо це справжня крос-чейн
     *      міграція) є коректною базою для розрахунку.
     */
    function migrationMint(address account, uint256 originalMintedAt)
        external
        onlyRole(MIGRATION_ROLE)
    {
        require(account != address(0), "Shield: zero account");
        require(accountToTokenId[account] == 0, "Shield: already member");
        require(originalMintedAt > 0 && originalMintedAt <= block.timestamp, "Shield: invalid originalMintedAt");

        _tokenIdCounter++;
        _totalSupply++;
        _activeSupply++;
        uint256 tid = _tokenIdCounter;

        accountToTokenId[account]       = tid;
        memberSince[account]            = originalMintedAt;
        requiredCouncilDuration[account] = _currentGraceDuration();
        _countedActive[account]         = true;
        _mint(account, tid);
        _totalSupplyCheckpoints.push(uint48(block.timestamp), uint208(_totalSupply));
        _activeSupplyCheckpoints.push(uint48(block.timestamp), uint208(_activeSupply));

        emit Locked(tid);
        emit ShieldMinted(account, tid);
    }

    /// @notice Видати/відкликати MIGRATION_ROLE контракту MigrationClaim.
    ///         Той самий принцип, що setDisciplineModule нижче — лише
    ///         DAO_ROLE (тобто через повний governance-цикл), ніколи
    ///         напряму деплоєром. Рекомендація: викликати enabled=false
    ///         (відкликати) окремою DAO-пропозицією одразу після закриття
    ///         заявленого вікна міграції.
    function setMigrationClaim(address claimContract, bool enabled) external onlyRole(DAO_ROLE) {
        require(claimContract != address(0), "Shield: zero migration claim");
        if (enabled) _grantRole(MIGRATION_ROLE, claimContract);
        else _revokeRole(MIGRATION_ROLE, claimContract);
    }

    function _doMint(address account) private {
        require(accountToTokenId[account] == 0, "Shield: already member");
        require(
            influenceRegistry.currentInfluence(account) >= INFLUENCE_THRESHOLD,
            "Shield: need 200+ Influence"
        );

        _tokenIdCounter++;
        _totalSupply++;
        _activeSupply++; // новий член завжди стартує як АКТИВНИЙ (щойно довів Influence)
        uint256 tid = _tokenIdCounter;

        accountToTokenId[account]        = tid;
        memberSince[account]             = block.timestamp;
        requiredCouncilDuration[account]  = _currentGraceDuration();
        _countedActive[account]          = true;
        _mint(account, tid);
        _totalSupplyCheckpoints.push(uint48(block.timestamp), uint208(_totalSupply));
        _activeSupplyCheckpoints.push(uint48(block.timestamp), uint208(_activeSupply));

        emit Locked(tid);
        emit ShieldMinted(account, tid);

        // ── CEI: зовнішній виклик — ОСТАННІМ кроком, після ВСІХ записів
        //    стану й подій. Раніше йшов до запису accountToTokenId —
        //    Slither (reentrancy-no-eth) коректно вказав на порушення
        //    CEI. Якщо verifyHuman() тут revert-не — уся транзакція
        //    відкотиться разом з усіма записами вище, тож поведінка не
        //    змінюється, лише порядок операцій стає безпечнішим.
        humanityGate.verifyHuman(account, minHumanityScore);
    }

    /// @notice Поточний поріг пільгового періоду, залежно від віку проекту
    ///         НА ЦЕЙ МОМЕНТ — викликається лише з mint(), фіксується назавжди.
    ///         В testMode з встановленим override — повертає прискорене
    ///         значення замість 180/365/730 днів.
    function _currentGraceDuration() internal view returns (uint256) {
        if (testMode && testGraceDurationOverride > 0) {
            return testGraceDurationOverride;
        }

        uint256 start = influenceRegistry.projectStartTimestamp();
        if (start == 0) return STANDARD_DURATION;

        uint256 projectAge = block.timestamp - start;
        if (projectAge < 365 days) return YEAR1_GRACE_DURATION;
        if (projectAge < 730 days) return YEAR2_GRACE_DURATION;
        return STANDARD_DURATION;
    }

    // ── ERC-5192: завжди locked ─────────────────────────────────

    function locked(uint256 /*tokenId*/) external pure returns (bool) {
        return true;
    }

    function _update(address to, uint256 tokenId, address auth)
        internal override returns (address)
    {
        address from = _ownerOf(tokenId);
        require(
            from == address(0) || to == address(0),
            "Shield: soulbound, non-transferable"
        );
        return super._update(to, tokenId, auth);
    }

    // ── Дисципліна (виклик лише з DisciplineModule) ─────────────

    /**
     * @notice Спалити статус Захисника після завершення повної процедури
     *         санкції (Shield-голос → veto-вікно → Council veto). Викликається
     *         ТІЛЬКИ DisciplineModule, не безпосередньо голосуванням тут.
     */
    function burnByDiscipline(address account, bytes32 violationPostRef)
        external
        onlyRole(DISCIPLINE_ROLE)
    {
        uint256 tid = accountToTokenId[account];
        require(tid != 0, "Shield: not a member");

        accountToTokenId[account] = 0;
        _totalSupply--;
        if (_countedActive[account]) {
            _activeSupply--;
            _countedActive[account] = false;
            _activeSupplyCheckpoints.push(uint48(block.timestamp), uint208(_activeSupply));
        }
        _burn(tid);
        _totalSupplyCheckpoints.push(uint48(block.timestamp), uint208(_totalSupply));

        emit Slashed(account, tid, violationPostRef);
    }

    /// @notice Призначити DisciplineModule. Лише через DAO governance (DaoTimelock).
    function setDisciplineModule(address module, bool enabled) external onlyRole(DAO_ROLE) {
        require(module != address(0), "Shield: zero address");
        if (enabled) _grantRole(DISCIPLINE_ROLE, module);
        else _revokeRole(DISCIPLINE_ROLE, module);
    }

    // ── DAO governance: гуманіті-поріг + тестовий grace-override ──────

    /// @notice Оновити мінімальний score для mint Shield (провайдер-
    ///         агностичний — стосується будь-якого активного провайдера
    ///         в humanityGate). Викликається тільки через DaoGovernor
    ///         → DaoTimelock (DAO_ROLE). Сам список провайдерів і режим
    ///         агрегації змінюються ОКРЕМО, через governor самого
    ///         humanityGate — не через цей контракт.
    function setMinHumanityScore(uint256 newMinScore) external onlyRole(DAO_ROLE) {
        minHumanityScore = newMinScore;
        emit MinHumanityScoreUpdated(newMinScore);
    }

    /// @notice Встановити прискорений grace-період ЛИШЕ для testMode-деплою.
    ///         На mainnet (testMode == false) виклик завжди revert — навіть
    ///         DAO_ROLE не може це обійти, перевірка на рівні контракту,
    ///         не на рівні процесу голосування.
    function setTestGraceDuration(uint256 newDuration) external onlyRole(DAO_ROLE) {
        require(testMode, "Shield: not a test deployment");
        testGraceDurationOverride = newDuration;
        emit TestGraceDurationUpdated(newDuration);
    }

    /// @notice Змінити вікно неактивності для activeSupply. Лише через DAO
    ///         governance (DaoTimelock). Довше вікно = толерантніше до пауз
    ///         в активності (менше людей "випадає" з activeSupply); коротше
    ///         вікно = менший, "живіший" знаменник, легше досягти порогів.
    function setInactivityWindow(uint256 newWindow) external onlyRole(DAO_ROLE) {
        require(newWindow > 0, "Shield: zero window");
        inactivityWindow = newWindow;
        emit InactivityWindowUpdated(newWindow);
    }

    /**
     * @notice ПЕРМІСІОНЛЕС: звірити статус активності конкретного акаунта з
     *         реальним lastActivityTimestamp в InfluenceRegistry і, за
     *         потреби, скоригувати activeSupply в ОБИДВА боки:
     *           - давно неактивний член, ще врахований як активний → прибрати
     *             з activeSupply (не позбавляє права голосу, лише прибирає
     *             з знаменника порогів явки/схвалення);
     *           - член, якого раніше прибрали, але він знову щось зробив
     *             (задонатив/проголосував/запропонував) → повернути назад.
     *         Викликати може БУДЬ-ХТО (типовий "keeper"-патерн) — функція
     *         лише синхронізує ОБ'ЄКТИВНИЙ факт (порівняння з timestamp),
     *         тому нею не можна штучно виключити активного учасника: вимога
     *         `block.timestamp - lastActivity > inactivityWindow` не
     *         дозволить прибрати того, хто дійсно активний.
     */
    function syncActivityStatus(address account) external {
        require(accountToTokenId[account] != 0, "Shield: not a member");

        uint256 lastActivity = influenceRegistry.lastActivityTimestamp(account);
        bool isActive = lastActivity != 0 && (block.timestamp - lastActivity) <= inactivityWindow;
        bool wasCounted = _countedActive[account];

        if (isActive == wasCounted) return; // уже синхронізовано, немає сенсу писати чекпойнт

        _countedActive[account] = isActive;
        if (isActive) {
            _activeSupply++;
        } else {
            _activeSupply--;
        }
        _activeSupplyCheckpoints.push(uint48(block.timestamp), uint208(_activeSupply));

        emit ActivityStatusSynced(account, isActive, _activeSupply);
    }

    // ── Читання ─────────────────────────────────────────────────

    function totalSupply() external view returns (uint256) {
        return _totalSupply;
    }

    /// @notice Скільки Shield-власників ЗАРАЗ враховані як активні (див.
    ///         inactivityWindow/syncActivityStatus вище).
    function activeSupply() external view returns (uint256) {
        return _activeSupply;
    }

    /// @notice activeSupply станом на минулий момент часу — той самий
    ///         снапшот-патерн, що getPastTotalSupply(), але для АКТИВНОЇ
    ///         явки. Це те, що DaoGovernor.quorum() ФАКТИЧНО використовує
    ///         (замість getPastTotalSupply) для вирішення проблеми
    ///         "неактивна більшість блокує голосування".
    function getPastActiveSupply(uint256 timepoint) external view returns (uint256) {
        require(timepoint < block.timestamp, "Shield: future lookup");
        return _activeSupplyCheckpoints.upperLookupRecent(uint48(timepoint));
    }

    /// @notice totalSupply станом на минулий момент часу (timestamp).
    ///         Використовується DaoGovernor.quorum() для снапшот-кворуму —
    ///         щоб нові mint-и ПІСЛЯ старту голосування не змінювали
    ///         знаменник кворуму заднім числом. timepoint має бути в
    ///         минулому (< block.timestamp).
    function getPastTotalSupply(uint256 timepoint) external view returns (uint256) {
        require(timepoint < block.timestamp, "Shield: future lookup");
        return _totalSupplyCheckpoints.upperLookupRecent(uint48(timepoint));
    }

    function isMember(address account) external view returns (bool) {
        return accountToTokenId[account] != 0;
    }

    /// @notice Найвищий поточний score юзера (масштабований ×100) серед
    ///         усіх активних провайдерів humanityGate, для UI.
    function previewHumanityScore(address account) external view returns (uint256) {
        return humanityGate.bestScore(account);
    }

    // ── ERC-165 ─────────────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId)
        public view override(ERC721, AccessControl) returns (bool)
    {
        return
            interfaceId == _INTERFACE_ID_ERC5192 ||
            super.supportsInterface(interfaceId);
    }
}
