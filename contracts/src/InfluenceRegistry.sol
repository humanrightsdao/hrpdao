// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/structs/Checkpoints.sol";

/// @notice Мінімальний інтерфейс CouncilSBT — лише totalSupply(), потрібний
///         для networkStage() нижче. Навмисно НЕ імпортується повний
///         CouncilSBT.sol (щоб уникнути циклічного імпорту: CouncilSBT.sol
///         сам імпортує InfluenceRegistry.sol).
interface ICouncilSupply {
    function totalSupply() external view returns (uint256);
}

/**
 * @title InfluenceRegistry
 * @notice Реєстр Influence балів репутації для HR DAO (заміна VoiceScoreRegistry).
 *
 * Зміни відносно VoiceScoreRegistry:
 *   - Бали більше НЕ нараховує оракул вручну. Джерело Influence — донати через
 *     TipJar (TIPJAR_ROLE), курс $1 = 1 Influence (БАЗОВИЙ, до
 *     мережевого коефіцієнта — див. п. "Мережева стадія" нижче), лінійно і
 *     кумулятивно на автора.
 *   - Річне затухання 10% (compound) — застосовується ліниво при кожному
 *     award() і при читанні currentInfluence()/votingPower(). DECAY_BPS = 1_000
 *     (10%), складно щороку, НЕ щоквартально (узгоджено: щоквартальний крок
 *     дав би суттєво агресивніший ефект на рік — лишили річний крок).
 *   - Voting Weight = influence^(1/4) = √(√(influence)) — два послідовні
 *     квадратні корені замість одного, застосовані до ЗАТУХЛОГО значення.
 *     Анти-плутократичний захист: ×10 000 Influence → лише ×10 сили голосу.
 *
 * ⚠️ МЕРЕЖЕВА СТАДІЯ (динамічний коефіцієнт $→Influence, узгоджено): курс $1=1 Influence
 * діє лише на СТАДІЇ 0 (< 244 Консулів). Коли кількість власників
 * CouncilSBT (councilSBT.totalSupply()) сягає 244 — тієї самої NODE_CAPACITY,
 * що вже відкриває каскад рівня 0 у CouncilRankingEpoch (EARTH переповнений,
 * той самий поріг, те саме "244" навмисно) — курс падає до $1=0.5 Influence
 * (стадія 1). ⚠️ Свідомо ОБМЕЖЕНО стадією 1 — подальша прогресія (стадія
 * 2+, "рівень 0 гексагонів відкрив рівень 1") НЕ реалізована: на рівні 0
 * вже 122 РІЗНІ гілки (не один вузол, як EARTH), і "чи хоч ОДНА з них
 * реально заповнена" неможливо коректно вивести з глобального
 * totalSupply() — густе місто могло б штучно підняти курс для ВСІХ, навіть
 * якщо жоден конкретний гексагон не переповнений (перевірено на
 * конкретних числах — див. розлогий коментар біля STAGE_THRESHOLD нижче
 * й GEO_REFORM_V10_CHANGES.md). Варіанти для стадії 2+ (потребують
 * рішення ДАО) — там-таки.
 * НЕ прив'язано до жодного КОНКРЕТНОГО гексагону автора чи тіпера —
 * це єдиний ГЛОБАЛЬНИЙ параметр мережі (визначається кількістю Консулів
 * загалом, а не індивідуально), тому дизайн навмисно уникає питання "чий
 * гексагон рахувати". Задум: вхід у проєкт (mint Shield/Council, що
 * вимагає певний Influence) стає "дорожчим" у $ зі зростанням ДАО — однаково для
 * всіх, симетричний ефект (в межах реалізованих стадій 0/1).
 *
 * ⚠️ ВИПРАВЛЕНО (аудит голосування): раніше currentInfluence()/votingPower()
 * були ЄДИНИМ джерелом ваги голосу і завжди рахувались LIVE, від
 * block.timestamp. DaoGovernor знімає ЗНІМОК (snapshot) правомочності
 * голосувати (getPastVotes → memberSince <= timepoint) — але саму ВАГУ
 * голосу брав через живий votingPower(), а не через значення станом на
 * момент знімку пропозиції. Це залишало вікно маніпуляції: побачивши
 * важливу пропозицію, учасник міг під час 2-7-денного вікна голосування
 * отримати додаткові донати через TipJar, щоб штучно наростити Influence і
 * проголосувати з завищеною вагою — саме за той конкретний результат.
 * Тепер award()/touchActivity() ДОДАТКОВО пишуть чекпойнт (той самий
 * патерн Checkpoints.Trace208, що й ShieldSBT.getPastTotalSupply) —
 * getPastInfluence()/getPastVotingPower() повертають ЗАМОРОЖЕНЕ на момент
 * timepoint значення, і DaoVotesAdapter._weightAt() (DaoGovernor.sol)
 * тепер використовує САМЕ ЦЮ снапшотну версію, а не живу votingPower().
 * currentInfluence()/votingPower() лишаються для UI/попереднього перегляду
 * (де live-значення доречне) — на голосування вони більше НЕ впливають.
 *
 * Ролі:
 *   DEFAULT_ADMIN_ROLE — не видається нікому (DAO_ROLE сам собі адмін)
 *   TIPJAR_ROLE        — адреса TipJar-контракту (єдине джерело award())
 */
contract InfluenceRegistry is AccessControl {
    using Checkpoints for Checkpoints.Trace208;

    bytes32 public constant TIPJAR_ROLE = keccak256("TIPJAR_ROLE");

    /// @notice DaoTimelock — єдиний, хто керує TIPJAR_ROLE. Сам собі адмін
    ///         (без зовнішнього DEFAULT_ADMIN_ROLE/мультисигу) — однакові правила
    ///         для всіх, змінити можна лише через повне голосування DaoGovernor.
    bytes32 public constant DAO_ROLE = keccak256("DAO_ROLE");

    /// @notice Хто може "освіжити" лічильник активності (touchActivity) без
    ///         нарахування Influence — DaoGovernor (голосування) і
    ///         DisciplineModule (голосування за санкції/вето, ініціювання).
    ///         Узгоджено: голосування — основніша ознака активності проти
    ///         decay, ніж самі донати.
    bytes32 public constant ACTIVITY_ROLE = keccak256("ACTIVITY_ROLE");

    uint256 public constant DECAY_BPS       = 1_000;  // 10% річних, складно (compound) — узгоджене значення
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant YEAR            = 365 days;

    /// @notice Поріг кількості Консулів для відкриття СТАДІЇ 1 (курс падає
    ///         з $1=1 Influence до $1=0.5 Influence) — те саме число 244, що вже
    ///         NODE_CAPACITY у CouncilRankingEpoch. Коректно рахувати саме
    ///         від councilSBT.totalSupply() ГЛОБАЛЬНО, бо EARTH — ЄДИНИЙ
    ///         вузол (не 122 різні гілки, як рівень 0) — "244 Консули
    ///         глобально" й "EARTH переповнений" тут буквально ОДНА й та
    ///         сама подія, без жодної двозначності.
    uint256 public constant STAGE_THRESHOLD = 244;

    /// @notice ⚠️ ЧЕСНО ОБМЕЖЕНО стадією 1 (0 або 1, більше нічого) —
    ///         зваживши повторно (аудит): подальша прогресія (стадія 2+,
    ///         "рівень 0 гексагонів відкрив рівень 1") НЕ може коректно
    ///         рахуватись від жодної формули на ГЛОБАЛЬНОМУ totalSupply(),
    ///         бо на рівні 0 вже 122 РІЗНІ гілки (не один вузол, як EARTH) —
    ///         totalSupply()=1708 НІЧОГО не каже про те, чи хоч ОДНА з цих
    ///         122 гілок реально набрала свої 244 (могли розподілитись
    ///         рівномірно, і жодна не переповнена — саме цей сценарій
    ///         показано в GEO_REFORM_V9_CHANGES.md/обговоренні). Попередня
    ///         версія (STAGE_FANOUT=7, помножити поріг і звірити з
    ///         totalSupply()) була цією самою помилкою і прибрана.
    ///
    ///         Правильна перевірка ("чи ЦЕЙ КОНКРЕТНИЙ гексагон рівня 0
    ///         реально заповнений") УЖЕ існує —
    ///         CouncilRankingEpoch.nodeOverflowed(nodeKeyOf(level, branchId)),
    ///         подається сабмітером епохи (submitNodeStatus) саме тому,
    ///         що на кожному рівні ≥0 гілок багато і перелічити їх усі
    ///         ончейн (щоб визначити "чи ХОЧ ОДНА переповнена") неможливо
    ///         без явного подання агрегованого значення — контракт не може
    ///         самостійно "обійти" 122+ гілки, яких навіть не зберігає
    ///         список.
    ///
    ///         Варіанти для стадії 2+ (потребують рішення ДАО, не
    ///         реалізовано, щоб не закодувати щось довільне):
    ///           а) EPOCH_SUBMITTER_ROLE подає стадію явно, РАЗ НА ЕПОХУ,
    ///              як окремий параметр (той самий сабмітер, що вже формує
    ///              nodeOverflowed-масив, тож технічно тривіально — просто
    ///              додається uint256 в submitNodeStatus чи окрема функція);
    ///              правило "коли саме підвищувати" — рішення ДАО (напр.
    ///              "будь-яка гілка рівня 0 переповнена" — просто, але
    ///              відтворює проблему "густе місто підіймає ціну для всіх";
    ///              чи "N% гілок переповнено" — справедливіше, складніше).
    ///           б) Назавжди лишити коефіцієнт на стадії 1 (курс 1:0.5)
    ///              після EARTH — найпростіше, уникає всієї проблематики
    ///              нерівномірного росту ціною втрати подальшої "дорожчої
    ///              з часом" механіки на глибших рівнях.
    ///           в) Зробити коефіцієнт per-гексагон (не глобальним) —
    ///              повертає обговорення "чий гексагон" (автора? тіпера?),
    ///              яке раніше свідомо уникалось.

    /// @notice CouncilSBT — settable ОДИН РАЗ після деплою (циклічна
    ///         залежність: CouncilSBT потребує InfluenceRegistry у
    ///         своєму конструкторі, тому в конструкторі InfluenceRegistry
    ///         адреси CouncilSBT ще просто не існує). Доки не встановлено —
    ///         networkStage() повертає 0 (курс $1=1 Influence), що безпечно за
    ///         замовчуванням (найдорожчий для мережі, найдешевший вхід).
    ICouncilSupply public councilSBT;

    // ── Стан ────────────────────────────────────────────────────
    /// @notice Кумулятивні Influence автора (у $-еквіваленті, лінійно, ДО затухання).
    mapping(address => uint256) public influence;

    /// @notice Час останньої активності (award) — точка відліку затухання.
    mapping(address => uint256) public lastActivityTimestamp;

    /// @notice Дата старту проекту — момент першого award() в історії.
    ///         Використовується для терміну очікування статусу Консула
    ///         (6/12 міс. пільгові періоди, потім 24 міс. стандарт) —
    ///         фактичні межі перевіряються в ShieldSBT.sol
    ///         (_currentGraceDuration()), це поле лише дає точку відліку.
    uint256 public projectStartTimestamp;

    /// @notice Чекпойнти "сирих" (до decay, кумулятивних) Influence — той
    ///         самий патерн, що ShieldSBT._totalSupplyCheckpoints. Пишеться
    ///         РАЗОМ з lastActivityTimestamp у award()/touchActivity()
    ///         (та ж транзакція, той самий block.timestamp-ключ), тому
    ///         ключ _activityCheckpoints у той самий момент завжди дорівнює
    ///         значенню lastActivityTimestamp, що діяло від цього чекпойнта
    ///         до наступного — цього достатньо, щоб getPastInfluence() міг
    ///         коректно застосувати ту саму формулу decay, що й
    ///         _computeDecayed(), але відносно timepoint, а не block.timestamp.
    mapping(address => Checkpoints.Trace208) private _influenceCheckpoints;

    /// @notice Чекпойнти lastActivityTimestamp — потрібні окремо від
    ///         _influenceCheckpoints, бо Checkpoints.Trace208.upperLookupRecent()
    ///         повертає лише ЗНАЧЕННЯ відповідного чекпойнта, не його
    ///         власний ключ (момент, з якого рахувати decay).
    mapping(address => Checkpoints.Trace208) private _activityCheckpoints;

    // ── Події ───────────────────────────────────────────────────
    event InfluenceAwarded(
        address indexed author,
        uint256 amount,        // "сира" сума, передана TipJar (до мережевого коефіцієнта)
        uint256 effectiveAmount, // фактично нараховано (після networkStage-коефіцієнта)
        uint256 newTotal,
        bytes32 postRef // keccak256 від Lens post ID
    );

    event CouncilSBTLinked(address indexed councilSBT);

    // ── Конструктор ─────────────────────────────────────────────
    /**
     * @param dao     DaoTimelock (DAO_ROLE) — керує TIPJAR_ROLE
     * @param tipJar  Адреса TipJar-контракту (TIPJAR_ROLE) — можна 0x0
     *                і виставити пізніше через governance.
     */
    constructor(address dao, address tipJar) {
        _setRoleAdmin(DAO_ROLE, DAO_ROLE);
        _setRoleAdmin(TIPJAR_ROLE, DAO_ROLE);
        _setRoleAdmin(ACTIVITY_ROLE, DAO_ROLE);
        _grantRole(DAO_ROLE, dao);
        // Тимчасово й деплоєру — лише для атомарного генезис-вайрингу
        // (setTipJar() в тій же транзакції), деплоєр МАЄ renounce одразу.
        if (msg.sender != dao) {
            _grantRole(DAO_ROLE, msg.sender);
        }
        if (tipJar != address(0)) {
            _grantRole(TIPJAR_ROLE, tipJar);
        }
    }

    // ── Основна функція ─────────────────────────────────────────

    /**
     * @notice Нарахувати Influence автору за отриманий донат.
     *         Викликається лише TipJar, передається ПОВНА сума донату
     *         в $-еквіваленті (до вирахування спліту автор/пул) — спліт
     *         грошей і нарахування Influence рахуються незалежно.
     * @param author   Адреса автора посту, що отримав донат
     * @param amount   Сума в $-еквіваленті ($1 = 1 Influence лише на стадії 0;
     *                 фактично нараховане може бути МЕНШЕ — див.
     *                 currentStageMultiplierBps()/networkStage() і
     *                 NatSpec контракту вище щодо мережевої стадії)
     * @param postRef  keccak256(lensPostId) — для офчейн-індексації
     */
    function award(address author, uint256 amount, bytes32 postRef)
        external
        onlyRole(TIPJAR_ROLE)
    {
        require(author != address(0), "Influence: zero address");
        require(amount > 0, "Influence: zero amount");

        if (projectStartTimestamp == 0) {
            projectStartTimestamp = block.timestamp;
        }

        // Спочатку застосовуємо затухання за минулі роки, потім додаємо нове
        _applyDecay(author);

        // Мережева стадія (узгоджено): на стадії 0 множник = 100% (без
        // змін). З 244 Консулів і далі — курс $→Influence падає (div 2 на кожну
        // наступну стадію). effectiveAmount — те, що РЕАЛЬНО додається;
        // amount (параметр) лишається "сирим" для події/аудиту.
        uint256 effectiveAmount = (amount * currentStageMultiplierBps()) / BPS_DENOMINATOR;
        require(effectiveAmount > 0, "Influence: amount rounds to zero at current network stage");

        influence[author]        += effectiveAmount;
        lastActivityTimestamp[author] = block.timestamp;

        // Чекпойнт ОДРАЗУ після оновлення — щоб getPastInfluence(timepoint)
        // для будь-якого timepoint ДО цього моменту не бачив нове award()
        // (снапшот "заморожує" вагу голосу рівно на цій межі).
        _influenceCheckpoints[author].push(uint48(block.timestamp), uint208(influence[author]));
        _activityCheckpoints[author].push(uint48(block.timestamp), uint208(block.timestamp));

        emit InfluenceAwarded(author, amount, effectiveAmount, influence[author], postRef);
    }

    /**
     * @notice Одноразово підключити CouncilSBT після його деплою (циклічна
     *         залежність — див. NatSpec біля поля councilSBT вище).
     *         Викликається ЛИШЕ через DAO governance, ЛИШЕ один раз.
     */
    function setCouncilSBT(address _councilSBT) external onlyRole(DAO_ROLE) {
        require(address(councilSBT) == address(0), "Influence: councilSBT already set");
        require(_councilSBT != address(0), "Influence: zero address");
        councilSBT = ICouncilSupply(_councilSBT);
        emit CouncilSBTLinked(_councilSBT);
    }

    /**
     * @notice Поточна "мережева стадія" — 0, поки Консулів < STAGE_THRESHOLD
     *         (244); 1, коли їх ≥ 244; 2, коли ≥ 244×STAGE_FANOUT; і т.д.
     *         Чиста функція від councilSBT.totalSupply() — жодного
     *         окремого голосування/подання епохи не потрібно, стадія
     *         підвищується САМА, щойно 244-й Консул отримує mint.
     */
    /**
     * @notice Поточна "мережева стадія" — ЛИШЕ 0 або 1 (⚠️ свідомо
     *         обмежено, див. розлогий коментар біля STAGE_THRESHOLD вище
     *         щодо того, чому стадія 2+ НЕ реалізована — немає коректного
     *         способу порахувати "чи заповнений конкретний гексагон" з
     *         одного лише глобального councilSBT.totalSupply()).
     *         0, поки Консулів < STAGE_THRESHOLD (244); 1, коли ≥ 244
     *         (EARTH переповнений — тут глобальний підрахунок ТОЧНО
     *         відповідає реальності, бо EARTH сам по собі єдиний вузол).
     */
    function networkStage() public view returns (uint256 stage) {
        if (address(councilSBT) == address(0)) return 0;
        return councilSBT.totalSupply() >= STAGE_THRESHOLD ? 1 : 0;
    }

    /// @notice Множник курсу $→Influence для поточної стадії (bps, 10000=100%).
    ///         Стадія 0→10000 (1:1), 1→5000 (1:0.5) — і поки що більше
    ///         нічого (див. networkStage() вище).
    function currentStageMultiplierBps() public view returns (uint256) {
        return BPS_DENOMINATOR >> networkStage();
    }

    /**
     * @notice Освіжити лічильник активності (наприклад, при голосуванні) —
     *         БЕЗ нарахування Influence. Спочатку застосовує накопичений decay
     *         за старим таймером (як завжди), потім зсуває таймер на зараз.
     *         Узгоджено: голосування — основніша ознака активності, ніж
     *         донати, тому теж захищає від decay.
     */
    function touchActivity(address account) external onlyRole(ACTIVITY_ROLE) {
        _applyDecay(account);
        lastActivityTimestamp[account] = block.timestamp;

        // Навіть якщо _applyDecay() нічого не змінив (< 1 рік з останньої
        // активності), чекпойнт усе одно варто оновити — decay-годинник
        // легітимно скидається на "зараз", і getPastInfluence() для будь-якого
        // timepoint ПІСЛЯ цього моменту має рахувати decay від НЬОГО.
        _influenceCheckpoints[account].push(uint48(block.timestamp), uint208(influence[account]));
        _activityCheckpoints[account].push(uint48(block.timestamp), uint208(block.timestamp));
    }

    /**
     * @notice Примусово застосувати затухання (без нарахування).
     *         Може викликати будь-хто — корисно для синхронізації перед голосуванням.
     */
    function applyDecay(address account) external {
        _applyDecay(account);
    }

    // ── Читання ─────────────────────────────────────────────────

    /// @notice Поточний Influence з урахуванням затухання (view, для порогів 200/500).
    function currentInfluence(address account) external view returns (uint256) {
        return _computeDecayed(account);
    }

    /**
     * @notice Voting Weight = influence^(1/4) = √(√(influence)), від затухлого значення.
     *         Використовується Governor'ами для зважування голосів.
     */
    function votingPower(address account) external view returns (uint256) {
        return _sqrt(_sqrt(_computeDecayed(account)));
    }

    /**
     * @notice Influence акаунта, "заморожений" станом на timepoint — не
     *         реагує на award()/touchActivity() ПІСЛЯ timepoint. Це і є
     *         фікс проти маніпуляції: DaoVotesAdapter._weightAt()
     *         (DaoGovernor.sol) використовує САМЕ цю функцію (через
     *         getPastVotingPower нижче), а не живий currentInfluence().
     * @dev    Читає останній чекпойнт із ключем <= timepoint і застосовує
     *         ТУ САМУ формулу decay, що й _computeDecayed(), але відносно
     *         timepoint замість block.timestamp.
     */
    function getPastInfluence(address account, uint256 timepoint) public view returns (uint256) {
        uint256 snapInfluence   = _influenceCheckpoints[account].upperLookupRecent(uint48(timepoint));
        uint256 snapActivity = _activityCheckpoints[account].upperLookupRecent(uint48(timepoint));

        if (snapActivity == 0 || snapInfluence == 0) return snapInfluence;

        uint256 elapsed = timepoint > snapActivity ? timepoint - snapActivity : 0;
        if (elapsed < YEAR) return snapInfluence;

        uint256 numYears = elapsed / YEAR;
        uint256 score     = snapInfluence;
        for (uint256 i = 0; i < numYears; i++) {
            score = (score * (BPS_DENOMINATOR - DECAY_BPS)) / BPS_DENOMINATOR;
        }
        return score;
    }

    /// @notice Voting Weight, "заморожений" станом на timepoint — те, що
    ///         DaoGovernor ФАКТИЧНО має використовувати для підрахунку
    ///         голосів (див. DaoVotesAdapter._weightAt() у DaoGovernor.sol).
    function getPastVotingPower(address account, uint256 timepoint) external view returns (uint256) {
        return _sqrt(_sqrt(getPastInfluence(account, timepoint)));
    }

    // ── Адмін ───────────────────────────────────────────────────

    /// @notice Призначити/змінити TipJar-адресу. Лише через DAO governance (DaoTimelock).
    function setTipJar(address tipJar, bool enabled) external onlyRole(DAO_ROLE) {
        require(tipJar != address(0), "Influence: zero address");
        if (enabled) _grantRole(TIPJAR_ROLE, tipJar);
        else _revokeRole(TIPJAR_ROLE, tipJar);
    }

    // ── Внутрішні ───────────────────────────────────────────────

    function _applyDecay(address account) internal {
        uint256 last = lastActivityTimestamp[account];
        if (last == 0 || influence[account] == 0) return;

        uint256 elapsed = block.timestamp - last;
        if (elapsed < YEAR) return;

        influence[account] = _computeDecayed(account);
        // lastActivityTimestamp оновлюється викликачем (award) на block.timestamp;
        // applyDecay() (без нарахування) також зсуває точку відліку, щоб не
        // нараховувати decay кілька разів за той самий проміжок:
        lastActivityTimestamp[account] = block.timestamp;
    }

    function _computeDecayed(address account) internal view returns (uint256) {
        uint256 last = lastActivityTimestamp[account];
        if (last == 0 || influence[account] == 0) return influence[account];

        uint256 elapsed = block.timestamp - last;
        if (elapsed < YEAR) return influence[account];

        uint256 numYears = elapsed / YEAR;
        uint256 score    = influence[account];

        // score * (0.90)^numYears — ціло-арифметично, складно (compound)
        for (uint256 i = 0; i < numYears; i++) {
            score = (score * (BPS_DENOMINATOR - DECAY_BPS)) / BPS_DENOMINATOR;
        }
        return score;
    }

    // Babylonian sqrt (ідентичний до VoiceScoreRegistry._sqrt)
    function _sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        uint256 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
        return y;
    }
}
