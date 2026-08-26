// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IHumanityVerifier
 * @notice Спільний інтерфейс для БУДЬ-ЯКОГО провайдера proof-of-personhood
 *         (Human Passport, World ID, BrightID, майбутні). ShieldSBT/CouncilSBT
 *         більше не знають, ЯКИЙ конкретно провайдер стоїть за перевіркою —
 *         вони працюють виключно через HumanityGate, а HumanityGate — через
 *         цей інтерфейс.
 *
 * @dev score МАЄ бути в діапазоні 0-10000 (масштабовано ×100, як і в
 *      поточному IPassportDecoder — score "20.00" = 2000), щоб порогові
 *      значення (minScoreScaled) лишались сумісні з тим, що вже задане в
 *      ShieldSBT/CouncilSBT. Бінарні провайдери (напр. World ID:
 *      verified/not) мапляться в 0 або 10000 УСЕРЕДИНІ свого адаптера —
 *      сам HumanityGate і ShieldSBT/CouncilSBT цього не бачать і не мають
 *      знати, що конкретний провайдер бінарний.
 */
interface IHumanityVerifier {
    function getScore(address account) external view returns (uint256);
}

/**
 * @title HumanityGate
 * @notice Заміна PassportGate: замість жорсткої прив'язки до ОДНОГО
 *         decoder-контракту (Human Passport) — керований DAO реєстр
 *         провайдерів людяності. Дозволяє:
 *           - додавати нові провайдери без редеплою ShieldSBT/CouncilSBT;
 *           - прибирати застарілі/скомпрометовані провайдери;
 *           - тримати кілька провайдерів активними ОДНОЧАСНО (перехідний
 *             період) і вирішувати через `mode`, чи достатньо пройти
 *             будь-який один, чи всі, чи набрати сукупний поріг.
 *
 * @dev НАВМИСНО НЕ abstract і НЕ призначений для успадкування — це
 *      ОКРЕМИЙ, ОДИН РАЗ задеплоєний контракт. ShieldSBT і CouncilSBT
 *      тримають на нього посилання (immutable address), так само як
 *      вони вже тримають InfluenceRegistry. Якби кожен з них успадкував
 *      свою власну копію реєстру провайдерів, DAO довелось би
 *      синхронізувати конфігурацію (додав/прибрав провайдера) в ДВОХ
 *      місцях окремо — реальний ризик розсинхронізації. Один спільний
 *      HumanityGate виключає цей клас помилок за конструкцією.
 *
 * ВАЖЛИВО: governor має бути DAO Governor/Timelock, а НЕ EOA-адмін —
 * зміна набору провайдерів має проходити через голосування спільноти,
 * так само як і будь-яке інше рішення DAO. Двоетапна передача governor
 * (propose → accept) — щоб неправильна адреса не забрикала контракт
 * назавжди.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  ПОСЛІДОВНІСТЬ ДЕПЛОЮ (порядок обов'язковий — пізніші кроки
 *  посилаються на адреси, отримані на попередніх):
 * ═══════════════════════════════════════════════════════════════════
 *   1. HumanityGate(governor = DaoTimelock)
 *   2. PassportAdapter(existingPassportDecoderAddress)
 *   3. humanityGate.addProvider(address(passportAdapter))        [governor]
 *   4. ShieldSBT(..., _humanityGate: address(humanityGate), ...)
 *   5. CouncilSBT(..., _humanityGate: address(humanityGate), ...)
 *      — ТА САМА адреса humanityGate, що й у кроці 4. Якщо передати
 *      різні адреси в ShieldSBT і CouncilSBT, пороги/провайдери
 *      розійдуться між статусами — саме той клас помилки, якого весь
 *      цей контракт створений уникати.
 *   6. humanityGate.setAuthorizedCaller(address(shieldSBT), true) [governor]
 *   7. humanityGate.setAuthorizedCaller(address(councilSBT), true) [governor]
 *
 *  Без кроків 6-7 mint() в ОБОХ SBT-контрактах ЗАВЖДИ revert-не на
 *  "HumanityGate: caller not authorized" — це не помилка, а навмисний
 *  захист (див. isAuthorizedCaller нижче), але його легко забути при
 *  деплої, тому винесено сюди окремим пунктом.
 * ═══════════════════════════════════════════════════════════════════
 */
contract HumanityGate {
    constructor(address _governor) {
        require(_governor != address(0), "HumanityGate: zero governor");
        governor = _governor;
    }

    // ─────────────────────────────────────────────────────────
    //  Governor (DAO/Timelock) — двоетапна зміна, без миттєвого ризику
    // ─────────────────────────────────────────────────────────

    address public governor;
    address public pendingGovernor;

    event GovernorProposed(address indexed newGovernor);
    event GovernorAccepted(address indexed newGovernor);

    modifier onlyGovernor() {
        require(msg.sender == governor, "HumanityGate: not governor");
        _;
    }

    /// @notice Крок 1: поточний governor пропонує наступного.
    function proposeGovernor(address newGovernor) external onlyGovernor {
        require(newGovernor != address(0), "HumanityGate: zero governor");
        pendingGovernor = newGovernor;
        emit GovernorProposed(newGovernor);
    }

    /// @notice Крок 2: НОВИЙ governor сам підтверджує перехід.
    /// Захищає від помилки в адресі — якщо в proposeGovernor вказали
    /// не той контракт, він просто ніколи не викличе accept.
    function acceptGovernor() external {
        require(msg.sender == pendingGovernor, "HumanityGate: not pending governor");
        governor = pendingGovernor;
        pendingGovernor = address(0);
        emit GovernorAccepted(governor);
    }

    // ─────────────────────────────────────────────────────────
    //  Авторизовані споживачі — хто може писати verifiedVia/epoch
    // ─────────────────────────────────────────────────────────

    /// @notice Лише ці адреси (ShieldSBT, CouncilSBT, ...) можуть викликати
    /// verifyHuman(). Без цього обмеження будь-хто міг би викликати
    /// verifyHuman(account, 0) (поріг 0 завжди проходить) і штучно
    /// "освіжити" verifiedAtEpoch/verifiedVia акаунту, зробивши
    /// needsReverification() оманливо false для СПРАВЖНЬОГО, вищого
    /// порогу, який насправді вимагає ShieldSBT/CouncilSBT.
    mapping(address => bool) public isAuthorizedCaller;

    event AuthorizedCallerSet(address indexed caller, bool enabled);

    modifier onlyAuthorizedCaller() {
        require(isAuthorizedCaller[msg.sender], "HumanityGate: caller not authorized");
        _;
    }

    function setAuthorizedCaller(address caller, bool enabled) external onlyGovernor {
        require(caller != address(0), "HumanityGate: zero caller");
        isAuthorizedCaller[caller] = enabled;
        emit AuthorizedCallerSet(caller, enabled);
    }

    // ─────────────────────────────────────────────────────────
    //  Реєстр провайдерів
    // ─────────────────────────────────────────────────────────

    address[] public providerList;
    mapping(address => bool) public isActiveProvider;
    /// @notice Чи адреса КОЛИСЬ була додана в providerList (незалежно від
    ///         поточного isActiveProvider). Потрібно, щоб addProvider() не
    ///         штовхав ДРУГИЙ запис у providerList при повторному додаванні
    ///         раніше видаленого провайдера — інакше isActiveProvider[p]
    ///         лишається одним булом на адресу, але providerList містив би
    ///         ту саму адресу двічі, і в Mode.THRESHOLD_SCORE її score
    ///         рахувався б у середньому ДВІЧІ (реальний баг, знайдений і
    ///         виправлений при тестуванні: remove+re-add одного провайдера
    ///         спотворював середнє на користь цього провайдера).
    mapping(address => bool) private _everListed;

    /// @notice Епоха зростає при КОЖНІЙ зміні набору провайдерів або
    /// режиму агрегації. Використовується нижче для needsReverification —
    /// щоб SBT-контракти могли (за бажанням) перевірити, чи верифікація
    /// конкретного акаунту "застаріла" відносно поточної конфігурації.
    uint256 public epoch;

    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event ModeChanged(Mode oldMode, Mode newMode);

    function addProvider(address provider) external onlyGovernor {
        require(provider != address(0), "HumanityGate: zero provider");
        require(!isActiveProvider[provider], "HumanityGate: already active");
        if (!_everListed[provider]) {
            providerList.push(provider);
            _everListed[provider] = true;
        }
        isActiveProvider[provider] = true;
        epoch++;
        emit ProviderAdded(provider);
    }

    /// @notice М'яке видалення: провайдер перестає рахуватись у нових
    /// перевірках, але запис лишається в providerList (для історії /
    /// needsReverification). Фізично з масиву не прибираємо — це
    /// невеликий список (одиниці елементів), економія газу на
    /// реіндексації того не варта.
    function removeProvider(address provider) external onlyGovernor {
        require(isActiveProvider[provider], "HumanityGate: not active");
        isActiveProvider[provider] = false;
        epoch++;
        emit ProviderRemoved(provider);
    }

    function getActiveProviders() external view returns (address[] memory active) {
        uint256 count;
        for (uint256 i = 0; i < providerList.length; i++) {
            if (isActiveProvider[providerList[i]]) count++;
        }
        active = new address[](count);
        uint256 j;
        for (uint256 i = 0; i < providerList.length; i++) {
            if (isActiveProvider[providerList[i]]) {
                active[j] = providerList[i];
                j++;
            }
        }
    }

    // ─────────────────────────────────────────────────────────
    //  Режим агрегації — компроміс "суворість перевірки" vs "зручність"
    // ─────────────────────────────────────────────────────────

    enum Mode {
        ANY_ONE, // досить пройти БУДЬ-ЯКИЙ один активний провайдер
        ALL_REQUIRED, // треба пройти ВСІ активні провайдери одночасно
        THRESHOLD_SCORE // середній score серед активних провайдерів >= порогу
    }

    Mode public mode;

    function setMode(Mode newMode) external onlyGovernor {
        emit ModeChanged(mode, newMode);
        mode = newMode;
        epoch++;
    }

    // ─────────────────────────────────────────────────────────
    //  Основна перевірка
    // ─────────────────────────────────────────────────────────

    /// @notice Провайдер, через який конкретний акаунт востаннє успішно
    /// пройшов verifyHuman у режимі ANY_ONE. address(0), якщо ще не
    /// верифікувався або верифікувався в режимі ALL_REQUIRED/
    /// THRESHOLD_SCORE (там немає єдиного "того самого" провайдера).
    mapping(address => address) public verifiedVia;
    /// @notice Епоха конфігурації на момент останньої успішної верифікації.
    mapping(address => uint256) public verifiedAtEpoch;

    /// @notice Read-only перевірка (для прев'ю на фронтенді ДО транзакції
    /// mint — той самий патерн, що previewSplit/previewInfluence у TipJar).
    /// Нічого не пише в стан — безпечна для викликів з фронтенду без tx.
    function isHuman(address account, uint256 minScoreScaled) public view returns (bool) {
        if (mode == Mode.ANY_ONE) {
            for (uint256 i = 0; i < providerList.length; i++) {
                address p = providerList[i];
                if (!isActiveProvider[p]) continue;
                if (IHumanityVerifier(p).getScore(account) >= minScoreScaled) return true;
            }
            return false;
        }

        if (mode == Mode.ALL_REQUIRED) {
            bool anyActive;
            for (uint256 i = 0; i < providerList.length; i++) {
                address p = providerList[i];
                if (!isActiveProvider[p]) continue;
                anyActive = true;
                if (IHumanityVerifier(p).getScore(account) < minScoreScaled) return false;
            }
            return anyActive; // якщо активних провайдерів взагалі немає — не пройдено
        }

        // Mode.THRESHOLD_SCORE
        uint256 total;
        uint256 count;
        for (uint256 i = 0; i < providerList.length; i++) {
            address p = providerList[i];
            if (!isActiveProvider[p]) continue;
            total += IHumanityVerifier(p).getScore(account);
            count++;
        }
        return count > 0 && (total / count) >= minScoreScaled;
    }

    /// @notice Найвищий score серед активних провайдерів — для UI
    /// (замінює колишній previewPassportScore у ShieldSBT/CouncilSBT,
    /// узагальнено на будь-яку кількість провайдерів).
    function bestScore(address account) external view returns (uint256 best) {
        for (uint256 i = 0; i < providerList.length; i++) {
            address p = providerList[i];
            if (!isActiveProvider[p]) continue;
            uint256 s = IHumanityVerifier(p).getScore(account);
            if (s > best) best = s;
        }
    }

    /// @notice Викликається ТІЛЬКИ авторизованими SBT-контрактами (не
    /// напряму юзером) з mint()-подібних функцій. На успіх фіксує, яким
    /// провайдером (у режимі ANY_ONE) і на якій epoch пройдено перевірку,
    /// для needsReverification нижче. На неуспіх — revert, той самий
    /// ефект, що й старий _verifyHuman() у PassportGate.
    function verifyHuman(address account, uint256 minScoreScaled) external onlyAuthorizedCaller {
        if (mode == Mode.ANY_ONE) {
            for (uint256 i = 0; i < providerList.length; i++) {
                address p = providerList[i];
                if (!isActiveProvider[p]) continue;
                if (IHumanityVerifier(p).getScore(account) >= minScoreScaled) {
                    verifiedVia[account] = p;
                    verifiedAtEpoch[account] = epoch;
                    return;
                }
            }
            revert("HumanityGate: score below threshold");
        }

        require(isHuman(account, minScoreScaled), "HumanityGate: score below threshold");
        verifiedVia[account] = address(0); // ALL_REQUIRED/THRESHOLD_SCORE — немає єдиного провайдера
        verifiedAtEpoch[account] = epoch;
    }

    /// @notice Чи "застаріла" верифікація акаунту відносно поточної
    /// конфігурації провайдерів/режиму. НЕ виконує жодних дій сама —
    /// ShieldSBT/CouncilSBT (чи окрема maintenance-функція) вирішують, що
    /// робити з застарілими членами: вимагати re-verify, призупинити
    /// votingPower тощо. Це навмисно залишено як опційний важіль, а не
    /// автоматичний burn — щоб уникнути несподіваної втрати членства.
    function needsReverification(address account) external view returns (bool) {
        if (verifiedAtEpoch[account] == 0 && verifiedVia[account] == address(0)) {
            return false; // ще не верифікувався взагалі — не "застаріле", а "відсутнє"
        }
        if (verifiedAtEpoch[account] < epoch) return true;

        address usedProvider = verifiedVia[account];
        if (usedProvider != address(0) && !isActiveProvider[usedProvider]) return true;

        return false;
    }
}
