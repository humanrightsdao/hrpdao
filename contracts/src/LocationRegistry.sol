// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import "./PolicyConsentGate.sol";

/// @notice Мінімальний інтерфейс до Groth16-верифікатора, згенерованого
///         snarkjs (zk/build/HexAncestryVerifier.sol) — навмисно НЕ
///         імпортується повний файл (він самодостатній, без залежностей,
///         але концептуально належить до "крипто-інфраструктури", не до
///         бізнес-логіки; той самий підхід, що й з IPriceFeed у TipJar).
interface IHexAncestryVerifier {
    function verifyProof(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256[3] calldata _pubSignals
    ) external view returns (bool);
}

/**
 * @title LocationRegistry
 * @notice ЕТАП 2 гео-реформи: локація користувача (H3-гексагон).
 *
 * ⚠️ Гео-реформа v12 (ZK-приватність, узгоджено): раніше зберігався СИРИЙ
 * H3-індекс у відкритому вигляді — публічно читабельний одразу після
 * декларації, НЕЗАЛЕЖНО від того, чи "відкрився" цей рівень каскадом
 * (nodeOverflowed впливає лише на те, який рівень ВИКОРИСТОВУЄТЬСЯ для
 * голосування/Influence, не на видимість). На найглибших рівнях (напр. 10 —
 * ~65-150м) це пряме розкриття фізичного місцезнаходження учасника.
 *
 * Нова модель — commit-and-reveal через ZK-SNARK (Groth16):
 *   1. Користувач ЛОКАЛЬНО (не ончейн) рахує точний hexId і випадковий salt,
 *      публікує лише КОМІТМЕНТ commitment = Poseidon(hexId, salt) —
 *      setLocationCommitment(). Сирий hexId ОНЧЕЙН НІКОЛИ не з'являється.
 *   2. Коли (і ЛИШЕ коли) користувачу потрібно, щоб конкретний рівень-
 *      предок став доступний іншим контрактам (каскад/маршрутизація
 *      податку/голосування) — він генерує ZK-доказ ЛОКАЛЬНО:
 *      "я знаю hexId,salt: Poseidon(hexId,salt)=commitment І
 *      ancestorOf(hexId,level)=branchId" — БЕЗ розкриття hexId — і
 *      викликає revealAncestor(level, branchId, proof). Контракт
 *      перевіряє лише математичний доказ (~200-300k газу, Groth16),
 *      сире значення НІКОЛИ не потрапляє в calldata/стан.
 *   3. revealedAncestorOf[account][level] — це і є те, що читають усі
 *      інші контракти (CouncilRankingEpoch/Treasury/DaoGovernor) замість
 *      колишнього getHexId()+H3Utils.ancestorOf() — тепер результат уже
 *      ЗАВЕРИФІКОВАНИЙ і закешований, а не обчислений на льоту з сирого
 *      значення.
 *
 * Наслідок дизайну (усвідомлений, не побічний ефект): глибина видимості
 * ПОВНІСТЮ під контролем користувача — він розкриває РІВНО ті рівні,
 * які хоче (типово — лише поточний активний рівень каскаду в своєму
 * регіоні), а не все одразу. Найглибше значення (рівень 10) НІКОЛИ не
 * зʼявляється в жодному ончейн полі, доки сам користувач явно не
 * розкриє САМЕ рівень 10 (а типово йому це й не потрібно — досить
 * розкрити до поточного активного рівня).
 *
 * Схема (zk/circuits/HexAncestry.circom), пайплайн і межі — детально
 * задокументовано в ZK_PRIVACY_V12_CHANGES.md і zk/README.md.
 *
 * ⚠️ TRUSTED SETUP: verification key у цьому репозиторії згенерована
 * ЛОКАЛЬНОЮ, ОДНОРАЗОВОЮ, НЕБЕЗПЕЧНОЮ (для продакшн) церемонією —
 * годиться ЛИШЕ для тестового деплою. Перед mainnet ОБОВ'ЯЗКОВО:
 * або (а) провести справжню multi-party Powers-of-Tau церемонію
 * (напр. приєднатися до вже існуючої публічної, як Hermez/PSE), або
 * (б) перейти на PLONK/Halo2 (без per-схемного trusted setup) — обидва
 * варіанти вимагають перегенерації verification key і повторного
 * деплою верифікатора.
 */
contract LocationRegistry is AccessControl, PolicyConsentGate {
    using Checkpoints for Checkpoints.Trace208;

    bytes32 public constant DAO_ROLE = keccak256("DAO_ROLE");

    /// @notice Мінімальний час між змінами КОМІТМЕНТУ одного акаунта.
    /// ⚠️ ГЕО-РЕФОРМА v14: раніше було 365 днів (жорсткий річний лок) —
    /// визнано несправедливим і таким, що не відповідає бажаній моделі
    /// "міняй коли завгодно, але для голосування/маршрутизації діє лише
    /// значення на МОМЕНТ ПОЧАТКУ поточної епохи" (90 днів,
    /// CouncilRankingEpoch.minEpochDuration). Сам захист від зловживання
    /// територією тепер робить НЕ це поле, а checkpoint-и нижче
    /// (revealedAncestorOf epoch-aware lookup) — це значення лишається
    /// суто анти-спам-запобіжником проти зайвого розбухання storage.
    uint256 public constant CHANGE_COOLDOWN = 1 hours;

    /// @notice Максимальна дозволена резолюція H3 (найдрібніша, найточніша) —
    ///         лише "стеля", яку дозволено доводити через ZK-доказ.
    uint8 public constant MAX_RESOLUTION = 10;

    /// @notice Рівень EARTH (глобальний сентинел) — той самий, що й
    ///         CouncilRankingEpoch.LEVEL_EARTH, повторений тут як
    ///         константа, щоб уникнути циклічного імпорту.
    int8 public constant LEVEL_EARTH = -1;

    IHexAncestryVerifier public immutable verifier;

    struct Commitment {
        uint256 value;  // Poseidon(hexId, salt); 0 = не задекларовано
        uint256 setAt;  // timestamp останньої зміни
    }
    mapping(address => Commitment) public commitmentOf;

    /// @notice Розкритий предок акаунта на конкретному рівні (0..10) —
    ///         0, якщо ЩЕ не розкрито (реальний branchId ніколи не є 0
    ///         для валідного H3-індексу на резолюціях 0..10, тож 0
    ///         однозначно означає "не розкрито", без колізій).
    ///         ⚠️ Це ЖИВЕ (останнє) значення — для UI/довідки. Контракти,
    ///         що приймають рішення про право голосу/маршрутизацію
    ///         (DaoGovernor, CouncilRankingEpoch), МАЮТЬ використовувати
    ///         getRevealedAncestorAt() нижче (epoch-aware), НЕ це поле
    ///         напряму — інакше зміна розкриття посеред епохи миттєво
    ///         впливала б на голосування ("територіальний стрибок").
    mapping(address => mapping(int8 => uint64)) public revealedAncestorOf;

    /// @notice Історія розкриттів за часом (checkpoint), щоб можна було
    ///         запитати "яке значення діяло НА МОМЕНТ X" — саме так
    ///         CouncilRankingEpoch.effectiveHexFor()/DaoGovernor
    ///         _isWithinTerritory() визначають чинну територію: як
    ///         значення на currentEpochStartedAt (початок ПОТОЧНОЇ, а не
    ///         НАЙНОВІШОЇ, епохи) — зміна розкриття посеред епохи реально
    ///         впливає на право голосу лише з НАСТУПНОЇ епохи.
    mapping(address => mapping(int8 => Checkpoints.Trace208)) private _revealedAncestorHistory;

    /// @notice Найглибший рівень, розкритий акаунтом дотепер.
    ///         LEVEL_EARTH (-1) = нічого не розкрито (лише EARTH, як і
    ///         для акаунта без комітменту взагалі).
    mapping(address => int8) public deepestRevealedLevel;

    /// @notice Скільки акаунтів МАЮТЬ комітмент (аналог totalDeclaredLocations
    ///         з попередньої версії) — для фронтенду.
    uint256 public totalDeclaredLocations;

    event CommitmentSet(address indexed account, uint256 commitment, uint256 timestamp);
    event AncestorRevealed(address indexed account, int8 level, uint64 branchId);

    constructor(
        address dao,
        address _verifier,
        bytes32 _initialNoticeHash,
        string memory _initialNoticeURI
    )
        PolicyConsentGate(_initialNoticeHash, _initialNoticeURI)
    {
        require(_verifier != address(0), "Location: zero verifier");
        verifier = IHexAncestryVerifier(_verifier);

        _setRoleAdmin(DAO_ROLE, DAO_ROLE);
        _setRoleAdmin(POLICY_ADMIN_ROLE, DAO_ROLE);
        _grantRole(DAO_ROLE, dao);
        _grantRole(POLICY_ADMIN_ROLE, dao);
        if (msg.sender != dao) {
            _grantRole(DAO_ROLE, msg.sender); // тимчасово, для генезис-вайрингу
        }
    }

    // ── Встановлення комітменту ───────────────────────────────────

    /**
     * @notice Задекларувати/оновити КОМІТМЕНТ локації (Poseidon(hexId,salt),
     *         пораховано локально, у фронтенді/гаманці — див.
     *         zk/README.md). Вимагає попередньої згоди на "Повідомлення
     *         про розкриття локації".
     * @param commitment Poseidon(hexId, salt); 0 — "скинути" (не
     *                    задекларовано, розкриті раніше рівні НЕ
     *                    стираються автоматично — приватність все одно
     *                    вже втрачена для того, що було розкрито раніше).
     */
    function setLocationCommitment(uint256 commitment) external {
        require(hasAcceptedCurrentPolicy(msg.sender), "Location: must accept disclosure notice");
        _setCommitment(msg.sender, commitment);
    }

    function setLocationCommitmentWithConsent(
        uint256 commitment,
        bytes32 noticeHash,
        uint256 deadline,
        bytes calldata signature
    ) external {
        _consentBySignature(msg.sender, noticeHash, deadline, signature);
        _setCommitment(msg.sender, commitment);
    }

    function _setCommitment(address account, uint256 commitment) private {
        Commitment storage c = commitmentOf[account];

        if (c.setAt != 0) {
            require(block.timestamp - c.setAt >= CHANGE_COOLDOWN, "Location: change cooldown active");
        }

        bool wasDeclared = c.value != 0;
        bool nowDeclared = commitment != 0;
        if (wasDeclared != nowDeclared) {
            if (nowDeclared) totalDeclaredLocations++;
            else totalDeclaredLocations--;
        }

        c.value = commitment;
        c.setAt = block.timestamp;

        emit CommitmentSet(account, commitment, block.timestamp);
    }

    // ── Розкриття конкретного рівня-предка (ZK) ──────────────────

    /**
     * @notice Довести й розкрити предка на рівні `level` — ZK-доказ
     *         (Groth16, схема zk/circuits/HexAncestry.circom) того, що
     *         `branchId` дійсно є предком прихованого hexId, що стоїть
     *         за поточним комітментом msg.sender, БЕЗ розкриття hexId.
     *
     *         Типовий сценарій: розкривати ЛИШЕ до поточного активного
     *         рівня каскаду в своєму регіоні (effectiveHexFor) — глибші
     *         рівні розкривати немає сенсу (нічого не змінять у
     *         маршрутизації/голосуванні, доки там немає активності), і
     *         НЕ рекомендується (зайве розкриття точності).
     *
     * @param level    0..MAX_RESOLUTION
     * @param branchId Заявлений предок (перевіряється лише математично —
     *                 чи ВІН АКТИВНИЙ у каскаді, перевіряє
     *                 CouncilRankingEpoch окремо, не цей контракт)
     */
    function revealAncestor(
        int8 level,
        uint64 branchId,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external {
        require(level >= 0 && uint8(level) <= MAX_RESOLUTION, "Location: invalid level");
        require(branchId != 0, "Location: invalid branch");

        uint256 commitment = commitmentOf[msg.sender].value;
        require(commitment != 0, "Location: no commitment set");

        uint256[3] memory publicSignals = [commitment, uint256(uint8(level)), uint256(branchId)];
        require(verifier.verifyProof(a, b, c, publicSignals), "Location: invalid ZK proof");

        revealedAncestorOf[msg.sender][level] = branchId;
        _revealedAncestorHistory[msg.sender][level].push(uint48(block.timestamp), uint208(branchId));
        if (level > deepestRevealedLevel[msg.sender]) {
            deepestRevealedLevel[msg.sender] = level;
        }

        emit AncestorRevealed(msg.sender, level, branchId);
    }

    // ── Читання ─────────────────────────────────────────────────

    function hasDeclaredHex(address account) external view returns (bool) {
        return commitmentOf[account].value != 0;
    }

    function getCommitment(address account) external view returns (uint256) {
        return commitmentOf[account].value;
    }

    /// @notice Розкритий предок акаунта на рівні `level`; 0, якщо ще не
    ///         розкрито (той самий контракт-споживач має розглядати 0 як
    ///         "інформація недоступна", НЕ як валідний branchId).
    ///         ⚠️ ЖИВЕ значення — для UI. Для рішень про право голосу/
    ///         маршрутизацію використовуйте getRevealedAncestorAt().
    function getRevealedAncestor(address account, int8 level) external view returns (uint64) {
        return revealedAncestorOf[account][level];
    }

    /// @notice Те саме, що getRevealedAncestor(), але значення "як воно
    ///         було на момент timepoint" (unix timestamp) — саме це МАЄ
    ///         використовувати будь-яка governance-логіка (голосування,
    ///         маршрутизація податку), передаючи
    ///         rankingEpoch.currentEpochStartedAt() як timepoint, щоб
    ///         зміна розкриття посеред епохи не впливала на поточну.
    function getRevealedAncestorAt(address account, int8 level, uint256 timepoint)
        external
        view
        returns (uint64)
    {
        return uint64(_revealedAncestorHistory[account][level].upperLookupRecent(uint48(timepoint)));
    }

    /// @notice Найглибший розкритий рівень; LEVEL_EARTH (-1), якщо
    ///         нічого не розкрито (чи навіть комітмент не задано).
    function getDeepestRevealedLevel(address account) external view returns (int8) {
        return deepestRevealedLevel[account];
    }

    /// @notice Скільки часу лишилось до можливості наступної зміни
    ///         комітменту (0 — можна змінювати зараз чи ще не було
    ///         жодної декларації).
    function timeUntilNextChangeAllowed(address account) external view returns (uint256) {
        uint256 setAt = commitmentOf[account].setAt;
        if (setAt == 0) return 0;
        uint256 unlockAt = setAt + CHANGE_COOLDOWN;
        if (block.timestamp >= unlockAt) return 0;
        return unlockAt - block.timestamp;
    }
}
