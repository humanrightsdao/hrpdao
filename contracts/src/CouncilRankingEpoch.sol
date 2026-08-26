// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "./CouncilSBT.sol";
import "./LocationRegistry.sol";
import "./SeatMerkleLib.sol";

/**
 * @title CouncilRankingEpoch
 * @notice ЕТАП 3 гео-реформи: єдина каскадна модель (місткість 244,
 *         ранжування за силою голосу від рівня -1 до MAX_RESOLUTION
 *         (Гео-реформа v5: піднято 3 → 10, див. LocationRegistry), quorum
 *         по вузлу. Каскад відкривається населеністю гексагонів
 *         (submitNodeStatus, раз в епоху ≈3 місяці), а НЕ самим лімітом —
 *         effectiveHexFor() нижче повертає "найбільш батьківський" код
 *         гексагону серед реально активних рівнів для конкретного акаунта.
 *
 * ОКРЕМИЙ КОНТРАКТ (найскладніший етап) — не змінює CouncilSBT,
 * LocationRegistry чи будь-що з попередніх етапів; лише ЧИТАЄ їх.
 *
 * ⚠️ ВИПРАВЛЕНО ГАЗОВУ ПРОБЛЕМУ (виявлено при обговоренні реального
 * навантаження): попередня версія зберігала Seat КОЖНОГО акаунта в
 * storage (mapping(address => Seat) seatOf) — при submitSeatAssignments()
 * для N кандидатів це ~N нових SSTORE (~20 000 газу кожен), тобто вже
 * при декількох СОТНЯХ кандидатів (не тисячах) одна транзакція стає
 * практично недеплойованою (block gas limit).
 *
 * ПЕРЕВІРЕНО ПЕРЕД ЗМІНОЮ: жоден інший контракт проєкту (DaoGovernor,
 * Treasury) НЕ читає seatOf/isSeatedCouncilMember — Treasury.
 * activeLevelsForAccount() використовує лише nodeOverflowed (стан ВУЗЛА,
 * не акаунта — кількість активних вузлів на порядки менша за кількість
 * кандидатів), а DaoGovernor рахує вагу голосу через
 * councilSBT.isCouncilMember(), не через цей контракт. Тобто per-account
 * seat-статус НІКОЛИ не використовувався іншим кодом — можна прибрати
 * per-account storage ПОВНІСТЮ, без жодного побічного ефекту.
 *
 * НОВА МОДЕЛЬ: submitSeatAssignments() приймає ті самі масиви (вони й
 * лишаються в calldata — це дешево, ~16 газу/байт, і саме через
 * calldata будь-хто пізніше може реконструювати повні дані для доказів),
 * АЛЕ будує Merkle-дерево ОНЧЕЙН із них (дешеві keccak-операції, не
 * SSTORE) і зберігає РІВНО ОДИН bytes32-корінь на епоху — O(1) storage
 * незалежно від кількості кандидатів. Перевірка конкретного запису —
 * verifySeatLeaf() із Merkle-proof, яку хто завгодно рахує сам, читаючи
 * дані з тієї ж транзакції submitSeatAssignments() (це стандартний
 * підхід — дані завжди публічні в calldata/логах, окремого IPFS не
 * потрібно).
 *
 * ── решта NatSpec без змін ──
 *
 *   Populaton-лічильник вузла (nodeCandidateCount) — ОДНА структура
 *   даних, що обслуговує ОБИДВІ мети одночасно (вони й раніше
 *   узгоджені як один і той самий поріг переповнення):
 *     (a) чи "відкриті" глибші рівні для цієї гілки (читає Treasury —
 *         Етап 4 — для розподілу податку, Варіант Y);
 *     (b) чи потрібен рейтинговий каскад — топ-244 лишаються на вузлі,
 *         решта каскадує на дочірній вузол наступної резолюції.
 *   Це — ОКРЕМИЙ, невеликий масив (обмежений кількістю АКТИВНИХ ВУЗЛІВ,
 *   а не кількістю кандидатів — вузлів завжди на порядки менше), тому
 *   submitNodeStatus() лишається як прямий масив, без Merkle — там ця
 *   газова проблема не виникає взагалі.
 *
 * Рівень -1 — EARTH, єдиний глобальний вузол усієї планети (branchId = 0,
 * зарезервовано,
 * ніколи не є валідним H3-індексом на практиці для рівнів 0-MAX_RESOLUTION).
 */
contract CouncilRankingEpoch is AccessControl {
    // (using H3Utils for uint64; прибрано в Гео-реформі v12 — предки
    // тепер читаються вже ZK-перевіреними з LocationRegistry, а не
    // обчислюються тут з сирого hexId)

    bytes32 public constant DAO_ROLE             = keccak256("DAO_ROLE");
    bytes32 public constant EPOCH_SUBMITTER_ROLE = keccak256("EPOCH_SUBMITTER_ROLE");

    /// @notice Місткість одного вузла — узгоджене число 244 (2×122 базові
    ///         комірки H3), однакове для будь-якого рівня, включно з -1.
    uint16 public constant NODE_CAPACITY = 244;

    /// @notice Кворум явки — 20% (орієнтовно), той самий патерн, що
    ///         DaoGovernor.QUORUM_BPS, застосований локально до вузла.
    uint256 public quorumBps = 2_000;

    /// @notice Мінімальний час між початком нових епох — захист від
    ///         надто частого/спамного перерахунку. DAO-керований.
    ///         Гео-реформа v5: дефолт 30 днів → 90 днів (3 місяці) —
    ///         саме з такою каденцією тепер очікується "наповнення"
    ///         гексагонів (submitNodeStatus) і перерахунок населеності,
    ///         що визначає ефективний (активний) рівень гексагону для
    ///         кожного учасника — див. effectiveHexFor() нижче.
    uint256 public minEpochDuration = 90 days;

    /// @notice Ієрархія рівнів (людська назва — перейменовано з "рівень -1"
    ///         на EARTH для зрозумілості, узгоджено):
    ///           EARTH (рівень -1)  — уся планета, єдиний вузол, сентинел.
    ///           рівень 0           — перший реальний рівень гексагонів.
    ///           рівень 1, 2, ... 10 — глибші, дрібніші гексагони.
    ///         EARTH позначається branchId = 0 (сентинел — реальні
    ///         H3-індекси рівнів 0-10 завжди мають ненульові біти mode/
    ///         resolution, тому колізія неможлива).
    uint64 public constant EARTH_BRANCH = 0;
    int8   public constant LEVEL_EARTH  = -1;

    // ── Конфігурація ─────────────────────────────────────────────
    CouncilSBT       public immutable councilSBT;
    LocationRegistry public immutable locationRegistry;

    // ── Стан епохи ────────────────────────────────────────────────
    uint256 public currentEpoch;
    uint256 public currentEpochStartedAt;

    /// @notice Merkle-корінь повного набору seat-присвоєнь поточної
    ///         епохи — О(1) storage, незалежно від кількості кандидатів.
    mapping(uint256 => bytes32) public epochSeatRoot;

    /// @notice Скільки листків (кандидатів) закодовано в epochSeatRoot[epoch]
    ///         — потрібно зовнішнім аудиторам/сабмітерам для звірки
    ///         повноти (напр. проти councilSBT.getPastTotalSupply()).
    mapping(uint256 => uint256) public epochLeafCount;

    /// @notice Кількість присвоєних місць на вузол (ключ — _nodeKey(level,branchId)).
    ///         За визначенням ≤ NODE_CAPACITY, якщо submitter коректно
    ///         реалізував каскад офчейн (контракт цього не перераховує).
    mapping(bytes32 => uint32) public nodeSeatCount;

    /// @notice Чи вузол переповнений (тобто далі каскадно відкриває
    ///         наступну резолюцію для тих, хто сюди потрапляє). Разом з
    ///         nodeSeatCount — подається сабмітером явно (не виводиться
    ///         на контракті), бо основне обчислення офчейн.
    mapping(bytes32 => bool) public nodeOverflowed;

    /// @notice Скільки РЕАЛЬНИХ гексагонів (рівні 0..MAX_RESOLUTION, БЕЗ
    ///         сентинела рівня -1) зараз позначені активними/переповненими
    ///         — живий лічильник для фронтенду ("кількість активних
    ///         гексагонів", Гео-реформа v5). Інкремент/декремент
    ///         відбувається в submitNodeStatus() лише при ЗМІНІ прапорця
    ///         nodeOverflowed конкретного вузла (ідемпотентне повторне
    ///         подання того самого значення лічильник не зсуває).
    uint256 public totalActiveHexagons;

    // ── Події ───────────────────────────────────────────────────
    event EpochStarted(uint256 indexed epoch, uint256 timestamp);
    event SeatRootSubmitted(uint256 indexed epoch, bytes32 root, uint256 leafCount);
    event NodeStatusUpdated(bytes32 indexed nodeKey, int8 level, uint64 branchId, uint32 seatCount, bool overflowed);
    event QuorumBpsUpdated(uint256 newQuorumBps);
    event MinEpochDurationUpdated(uint256 newDuration);

    constructor(address _councilSBT, address _locationRegistry, address dao) {
        require(_councilSBT != address(0), "CouncilRanking: zero councilSBT");
        require(_locationRegistry != address(0), "CouncilRanking: zero locationRegistry");

        councilSBT       = CouncilSBT(_councilSBT);
        locationRegistry = LocationRegistry(_locationRegistry);

        _setRoleAdmin(DAO_ROLE, DAO_ROLE);
        _setRoleAdmin(EPOCH_SUBMITTER_ROLE, DAO_ROLE);
        _grantRole(DAO_ROLE, dao);
        if (msg.sender != dao) {
            _grantRole(DAO_ROLE, msg.sender); // тимчасово, для генезис-вайрингу
        }
    }

    // ── Епохи ───────────────────────────────────────────────────

    /// @notice Почати нову епоху ранжування. Не частіше ніж раз на
    ///         minEpochDuration. Наступні submitSeatAssignments()/
    ///         submitNodeStatus() прив'язуються до нового currentEpoch.
    function beginNewEpoch() external onlyRole(EPOCH_SUBMITTER_ROLE) {
        require(
            currentEpochStartedAt == 0 || block.timestamp - currentEpochStartedAt >= minEpochDuration,
            "CouncilRanking: epoch too soon"
        );
        currentEpoch++;
        currentEpochStartedAt = block.timestamp;
        emit EpochStarted(currentEpoch, block.timestamp);
    }

    /**
     * @notice Подати результат офчейн-ранжування для набору акаунтів.
     *         Масиви передаються В CALLDATA (не зберігаються!) — контракт
     *         будує з них Merkle-дерево ончейн і зберігає лише корінь.
     *         Дані лишаються публічно доступними в самій транзакції
     *         (calldata/логи) — цього достатньо, щоб будь-хто міг
     *         самостійно порахувати Merkle-proof конкретного запису.
     * @dev Листок дерева: keccak256(abi.encode(index, account, hasSeat,
     *      level, branchId)) — index у листку робить кожен запис
     *      унікальним навіть при випадково однакових інших полях і
     *      дозволяє довести дублікат акаунта (однаковий account у двох
     *      різних листках з різним index).
     */
    function submitSeatAssignments(
        address[] calldata accounts,
        bool[] calldata hasSeatFlags,
        int8[] calldata levels,
        uint64[] calldata branchIds
    ) external onlyRole(EPOCH_SUBMITTER_ROLE) {
        uint256 len = accounts.length;
        require(
            len == hasSeatFlags.length && len == levels.length && len == branchIds.length,
            "CouncilRanking: length mismatch"
        );

        bytes32[] memory leaves = new bytes32[](len);
        // Гео-реформа v5: межа рівня більше НЕ хардкодиться (було <= 3) —
        // читається напряму з LocationRegistry.MAX_RESOLUTION(), щоб
        // обидва контракти гарантовано не розійшлися при майбутніх змінах.
        int8 maxLevel = int8(uint8(locationRegistry.MAX_RESOLUTION()));
        for (uint256 i = 0; i < len; i++) {
            require(levels[i] >= LEVEL_EARTH && levels[i] <= maxLevel, "CouncilRanking: level out of range");
            require(
                levels[i] != LEVEL_EARTH || branchIds[i] == EARTH_BRANCH,
                "CouncilRanking: level -1 requires branchId 0"
            );
            leaves[i] = SeatMerkleLib.leafHash(i, accounts[i], hasSeatFlags[i], levels[i], branchIds[i]);
        }

        bytes32 root = SeatMerkleLib.buildRoot(leaves);
        epochSeatRoot[currentEpoch] = root;
        epochLeafCount[currentEpoch] = len;

        emit SeatRootSubmitted(currentEpoch, root, len);
    }

    /// @notice Легкий шлях: прийняти ВЖЕ ПОБУДОВАНИЙ і перевірений корінь
    ///         напряму (без повторної передачі масивів). Використовується
    ///         permissionless-надсилачами на кшталт OptimisticEpochSubmission,
    ///         які самі побудували той самий корінь (SeatMerkleLib з
    ///         ідентичною формулою) під час власного вікна оскарження —
    ///         передавати масиви ЩЕ РАЗ сюди було б зайвим подвоєнням
    ///         calldata-витрат. submitSeatAssignments() вище лишається для
    ///         випадку, коли EPOCH_SUBMITTER_ROLE тримає звичайний
    ///         довірений мультисиг без окремого шару оскарження.
    function submitSeatRoot(bytes32 root, uint256 leafCount) external onlyRole(EPOCH_SUBMITTER_ROLE) {
        epochSeatRoot[currentEpoch] = root;
        epochLeafCount[currentEpoch] = leafCount;
        emit SeatRootSubmitted(currentEpoch, root, leafCount);
    }

    /// @notice Формула листка дерева — делегує в SeatMerkleLib, щоб
    ///         будь-хто міг відтворити той самий хеш локально при
    ///         побудові proof (публічна pure-обгортка для зручності
    ///         зовнішніх викликів — сама бібліотека internal).
    function leafHash(uint256 index, address account, bool hasSeat, int8 level, uint64 branchId)
        public pure returns (bytes32)
    {
        return SeatMerkleLib.leafHash(index, account, hasSeat, level, branchId);
    }

    /// @notice Перевірити конкретний запис проти збереженого кореня епохи
    ///         (Merkle-proof, О(log n) хешів — дешево незалежно від
    ///         загальної кількості кандидатів).
    function verifySeatLeaf(
        uint256 epoch,
        uint256 index,
        address account,
        bool hasSeat,
        int8 level,
        uint64 branchId,
        bytes32[] calldata proof
    ) external view returns (bool) {
        bytes32 leaf = SeatMerkleLib.leafHash(index, account, hasSeat, level, branchId);
        return MerkleProof.verifyCalldata(proof, epochSeatRoot[epoch], leaf);
    }

    /**
     * @notice Пакетно подати стан вузлів (кількість місць і прапорець
     *         переповнення) — читається §5 (Treasury) для маршрутизації
     *         податку між активними рівнями конкретної гілки. НЕ Merkle —
     *         кількість активних вузлів на порядки менша за кількість
     *         кандидатів, газова проблема тут не виникає.
     */
    function submitNodeStatus(
        int8[] calldata levels,
        uint64[] calldata branchIds,
        uint32[] calldata seatCounts,
        bool[] calldata overflowedFlags
    ) external onlyRole(EPOCH_SUBMITTER_ROLE) {
        uint256 len = levels.length;
        require(
            len == branchIds.length && len == seatCounts.length && len == overflowedFlags.length,
            "CouncilRanking: length mismatch"
        );

        for (uint256 i = 0; i < len; i++) {
            bytes32 key = _nodeKey(levels[i], branchIds[i]);
            bool wasOverflowed  = nodeOverflowed[key];
            nodeSeatCount[key]  = seatCounts[i];
            nodeOverflowed[key] = overflowedFlags[i];

            // totalActiveHexagons рахує лише реальні гексагони (рівень
            // -1/EARTH_BRANCH — не гексагон, а EARTH (глобальний сентинел усієї планети), тому
            // виключений) і лише на ЗМІНІ прапорця, щоб повторне подання
            // того самого стану не зсувало лічильник.
            if (levels[i] != LEVEL_EARTH && wasOverflowed != overflowedFlags[i]) {
                if (overflowedFlags[i]) {
                    totalActiveHexagons++;
                } else {
                    totalActiveHexagons--;
                }
            }

            emit NodeStatusUpdated(key, levels[i], branchIds[i], seatCounts[i], overflowedFlags[i]);
        }
    }

    // ── Ключ вузла ───────────────────────────────────────────────

    function _nodeKey(int8 level, uint64 branchId) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(level, branchId));
    }

    // ── Кворум (перевикористання патерну DaoGovernor.QUORUM_BPS) ──

    /// @notice Кворум явки для конкретного вузла: memberCount(вузла) × quorumBps / 10_000.
    function quorumFor(int8 level, uint64 branchId) external view returns (uint256) {
        bytes32 key = _nodeKey(level, branchId);
        return (nodeSeatCount[key] * quorumBps) / 10_000;
    }

    function setQuorumBps(uint256 newQuorumBps) external onlyRole(DAO_ROLE) {
        require(newQuorumBps <= 10_000, "CouncilRanking: bps over 100%");
        quorumBps = newQuorumBps;
        emit QuorumBpsUpdated(newQuorumBps);
    }

    function setMinEpochDuration(uint256 newDuration) external onlyRole(DAO_ROLE) {
        require(newDuration > 0, "CouncilRanking: zero duration");
        minEpochDuration = newDuration;
        emit MinEpochDurationUpdated(newDuration);
    }

    // ── Читання для §5 (Treasury): активні рівні гілки ────────────

    /**
     * @notice Скільки рівнів "активні" для гілки конкретного акаунта —
     *         Варіант Y: 1 (лише -1) + кількість послідовних резолюцій
     *         0..min(deepestRevealedLevel, MAX_RESOLUTION), де ВСІ рівні-
     *         предки вже переповнені (nodeOverflowed == true). ⚠️ Гео-
     *         реформа v12 (ZK-приватність): раніше рахувалось по
     *         ланцюжку H3-предків через H3Utils із СИРОГО hexId (макс.
     *         MAX_RESOLUTION+1 ітерацій). Тепер hexId прихований —
     *         замість обчислення на льоту читаються ВЖЕ ZK-ПЕРЕВІРЕНІ й
     *         закешовані предки з LocationRegistry.revealedAncestorOf
     *         (glibina обмежена не MAX_RESOLUTION, а тим, ЩО САМ
     *         акаунт вирішив розкрити — LocationRegistry.
     *         getDeepestRevealedLevel). Не залежить від per-account
     *         seat-даних узагалі — лише від nodeOverflowed (стан вузла).
     * @param account Акаунт платника
     * @return activeLevels Кількість активних рівнів (1 .. 2+MAX_RESOLUTION,
     *         тобто 1-12 при MAX_RESOLUTION=10, обмежено глибиною розкриття)
     */
    function activeLevelsForAccount(address account) external view returns (uint8 activeLevels) {
        activeLevels = 1; // рівень -1 (EARTH) завжди активний

        // Рівень -1 має бути переповнений, щоб рівень 0 став активним.
        if (!nodeOverflowed[_nodeKey(LEVEL_EARTH, EARTH_BRANCH)]) {
            return activeLevels;
        }

        int8 deepestRevealed = locationRegistry.getDeepestRevealedLevel(account);
        if (deepestRevealed < 0) {
            return activeLevels; // нічого не розкрито (чи навіть комітмент не задано) — лише EARTH
        }

        // Пройти по ланцюжку ВЖЕ РОЗКРИТИХ (ZK-перевірених) предків, від
        // res0 до deepestRevealed включно.
        for (uint8 r = 0; r <= uint8(deepestRevealed); r++) {
            uint64 ancestor = locationRegistry.getRevealedAncestor(account, int8(uint8(r)));
            if (ancestor == 0) break; // не мало б статись у межах deepestRevealed, захист про всяк випадок
            activeLevels++;
            bytes32 key = _nodeKey(int8(uint8(r)), ancestor);
            if (r == uint8(deepestRevealed)) break; // термінальний розкритий рівень — далі нема куди
            if (!nodeOverflowed[key]) break; // цей вузол ще не переповнений — глибші рівні неактивні
        }
    }

    /**
     * @notice Гео-реформа v5 — "визначення локації включено в систему
     *         рейтингів": ЄДИНИЙ ефективний (активний) гексагон акаунта —
     *         "найбільш батьківський" код серед РЕАЛЬНО активних рівнів
     *         цієї гілки. Якщо гексагони населені лише до рівня -1/0 —
     *         повертається рівень -1 (EARTH) чи 0; якщо населеність відкрила каскад
     *         аж до рівня 5 — повертається САМЕ рівень 5 (глибші рівні
     *         6..MAX_RESOLUTION НЕ повертаються і НІКОЛИ не зберігаються
     *         окремо — нічого зайвого рахувати/зберігати не потрібно,
     *         бо це ЧИСТА view-функція над вже наявним станом
     *         nodeOverflowed, без жодного додаткового storage).
     *
     *         Це той самий каскад, що й activeLevelsForAccount(), лише
     *         повертає термінальну пару (level, branchId) замість
     *         кількості рівнів — обидві функції ГАРАНТОВАНО узгоджені,
     *         бо йдуть по ІДЕНТИЧНОМУ ланцюжку nodeOverflowed.
     *
     *         Населеність гексагонів (nodeOverflowed) очікується
     *         оновленою submitNodeStatus() раз в епоху (3 місяці,
     *         minEpochDuration) — тобто "наповнення" гексагонів і є
     *         тим самим епохальним циклом.
     *
     *         ⚠️ Гео-реформа v12 (ZK-приватність): рівень тепер обмежений
     *         НЕ декларованою резолюцією (яка більше НЕ зберігається у
     *         відкритому вигляді), а тим, ЩО акаунт сам вирішив розкрити
     *         через ZK-доказ (LocationRegistry.revealAncestor()) — див.
     *         ZK_PRIVACY_V12_CHANGES.md.
     *
     * @param account Акаунт учасника
     * @return level    Ефективний рівень (-1, якщо локація не задекларована,
     *                   нічого не розкрито, або навіть рівень -1 (EARTH)
     *                   ще не переповнений)
     * @return branchId Ефективний H3-гексагон цього рівня (EARTH_BRANCH
     *                   при level == -1)
     */
    function effectiveHexFor(address account) external view returns (int8 level, uint64 branchId) {
        level    = LEVEL_EARTH;
        branchId = EARTH_BRANCH;

        if (!nodeOverflowed[_nodeKey(LEVEL_EARTH, EARTH_BRANCH)]) {
            return (level, branchId);
        }

        int8 deepestRevealed = locationRegistry.getDeepestRevealedLevel(account);
        if (deepestRevealed < 0) {
            return (level, branchId); // нічого не розкрито — лише EARTH
        }

        // ⚠️ ГЕО-РЕФОРМА v14: беремо розкриття "як воно було на момент
        // початку ПОТОЧНОЇ епохи" (currentEpochStartedAt), а НЕ живе
        // значення — щоб зміна розкриття посеред епохи не впливала на
        // право голосу/маршрутизацію одразу (лише з наступної епохи).
        // deepestRevealed лишається "живим" навмисно — цикл нижче й так
        // природно зупиниться на 0 (getRevealedAncestorAt поверне 0 для
        // всього, розкритого ПІСЛЯ початку епохи), тож окремо
        // "заморожувати" й deepestRevealed не потрібно.
        for (uint8 r = 0; r <= uint8(deepestRevealed); r++) {
            uint64 ancestor = locationRegistry.getRevealedAncestorAt(
                account, int8(uint8(r)), currentEpochStartedAt
            );
            if (ancestor == 0) break;
            level    = int8(uint8(r));
            branchId = ancestor;
            if (r == uint8(deepestRevealed)) break; // термінальний розкритий рівень — далі нема куди
            if (!nodeOverflowed[_nodeKey(level, ancestor)]) break; // цей вузол ще не переповнений — глибші рівні неактивні
        }
    }

    // ── Читання: базові гетери ────────────────────────────────────

    function nodeKeyOf(int8 level, uint64 branchId) external pure returns (bytes32) {
        return _nodeKey(level, branchId);
    }
}
