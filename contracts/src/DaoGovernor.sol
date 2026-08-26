// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/governance/Governor.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import "@openzeppelin/contracts/governance/utils/IVotes.sol";
import "@openzeppelin/contracts/interfaces/IERC6372.sol";
import "./InfluenceRegistry.sol";
import "./ShieldSBT.sol";
import "./CouncilSBT.sol";
import "./DisciplineModule.sol";
import "./CouncilRankingEpoch.sol";
import "./LocationRegistry.sol";

/**
 * @title DaoGovernor
 * @notice Два статуси участі, Shield (статус «Захисник») і Council (статус
 *         «Консул»):
 *   - Shield і Council голосують ОДНАКОВО — вагою influenceRegistry.
 *     votingPower() (influence^(1/4)). Council не додає ОКРЕМОЇ ваги понад
 *     Shield — Council завжди вимагає активний Shield на момент mint
 *     (CouncilSBT.mint() перевіряє shieldSBT.isMember), тому це той самий
 *     "трек", просто з вищим статусом.
 *   - ⚠️ Вага голосу СНАПШОТИТЬСЯ на момент знімку пропозиції (той самий
 *     timepoint, що й правомочність голосувати) через
 *     InfluenceRegistry.getPastVotingPower() — див. DaoVotesAdapter._weightAt()
 *     нижче. Донати через TipJar ПІСЛЯ створення пропозиції більше НЕ
 *     впливають на вагу голосу в НІЙ (лише на майбутні пропозиції).
 *   - ПРОПОНУВАТИ може лише Council (не Shield). Немає окремого класу
 *     "Policy"-пропозицій — зміна Політики прав людини (ShieldSBT.
 *     setPolicy()/setReacceptGracePeriod(), успадковані з
 *     PolicyConsentGate) проходить через ЗВИЧАЙНЕ голосування, тим самим
 *     кворумом і вагою, що й будь-яка інша пропозиція.
 *
 * ⚠️ КВОРУМ: БАЗА кворуму — ЛИШЕ shieldSBT.totalSupply, НЕ сума
 * Shield+Council. Кожен Council-власник за конструкцією (CouncilSBT.mint())
 * завжди має активний Shield на момент отримання статусу Консула, тобто
 * вже врахований у shieldSBT.totalSupply — додавати councilSBT.totalSupply
 * окремо означало б рахувати ту саму людину двічі в знаменнику кворуму,
 * штучно завищуючи поріг, необхідний для проходження голосування. Єдиний
 * теоретичний контрприклад — учасник, чий Shield спалено через
 * DisciplineModule.burnByDiscipline() НЕЗАЛЕЖНО від Council (санкція типу
 * FullSlash дозволяє спалити Shield і/або Council окремо): такий акаунт
 * далі не враховується в базі кворуму (shieldSBT.totalSupply вже
 * зменшився), хоча formально councilSBT.isCouncilMember() для нього ще
 * true. Це прийнятний, задокументований компроміс — краще трохи занизити
 * знаменник у рідкісному дисциплінарному edge-кейсі, ніж систематично
 * завищувати його для КОЖНОГО Council-власника.
 */
contract DaoVotesAdapter is IVotes, IERC6372 {

    InfluenceRegistry   public immutable influenceRegistry;
    ShieldSBT        public immutable shieldSBT;
    CouncilSBT       public immutable councilSBT;
    DisciplineModule public immutable discipline;

    constructor(
        address _influenceRegistry,
        address _shieldSBT,
        address _councilSBT,
        address _discipline
    ) {
        influenceRegistry = InfluenceRegistry(_influenceRegistry);
        shieldSBT      = ShieldSBT(_shieldSBT);
        councilSBT     = CouncilSBT(_councilSBT);
        discipline     = DisciplineModule(_discipline);
    }

    /// @notice Годинник за timestamp — без змін відносно попередньої версії.
    function clock() public view override returns (uint48) {
        return uint48(block.timestamp);
    }

    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }

    function getVotes(address account) external view override returns (uint256) {
        return _weight(account);
    }

    function getPastVotes(address account, uint256 timepoint)
        external view override returns (uint256)
    {
        return _weightAt(account, timepoint);
    }

    /// @notice activeSupply станом на timepoint для БАЗИ кворуму — лише
    ///         shieldSBT (Council ⊆ Shield за конструкцією, див. NatSpec
    ///         контракту вище щодо виправлення подвійного обліку).
    ///         ⚠️ ОНОВЛЕНО (вирішення проблеми "неактивна більшість блокує
    ///         голосування"): раніше тут була totalSupply() — включно з
    ///         роками неактивними Shield-власниками, тому кворум (20% від
    ///         ВСІХ) міг стати недосяжним, якщо реально активна частка
    ///         спільноти давно менша за 20%. Тепер activeSupply() —
    ///         той самий Checkpoints.Trace208-патерн, але рахує лише тих,
    ///         хто торкався ДАО в межах inactivityWindow (ShieldSBT,
    ///         DAO-керований). Право голосу в НІКОГО не забирається — це
    ///         впливає лише на РОЗМІР ЗНАМЕННИКА кворуму, не на те, хто
    ///         може голосувати. Детальніше — GEO_REFORM_V8_CHANGES.md.
    function getPastTotalSupply(uint256 timepoint) external view override returns (uint256) {
        return shieldSBT.getPastActiveSupply(timepoint);
    }

    function delegates(address account) external pure override returns (address) {
        return account;
    }

    function delegate(address /*delegatee*/) external pure override {
        revert("DaoAdapter: delegation not supported");
    }

    function delegateBySig(address, uint256, uint256, uint8, bytes32, bytes32) external pure override {
        revert("DaoAdapter: delegation not supported");
    }

    /// @dev Вага — Shield/Council ОДНАКОВО, обидва через
    ///      influenceRegistry.votingPower(). Використовується для ВСІХ
    ///      пропозицій, включно з Policy — окремого треку немає.
    function _weight(address account) internal view returns (uint256) {
        bool eligible =
            shieldSBT.isMember(account) ||
            councilSBT.isCouncilMember(account);
        if (!eligible) return 0;
        if (!shieldSBT.isCompliant(account)) return 0;
        if (discipline.isRestricted(account)) return 0;
        return influenceRegistry.votingPower(account);
    }

    /// @dev ⚠️ ВИПРАВЛЕНО (аудит голосування): раніше тут викликався ЖИВИЙ
    ///      influenceRegistry.votingPower(account) — тобто сама ВАГА голосу
    ///      бралась на момент voteCast(), а не на момент знімку пропозиції
    ///      (timepoint), хоча ПРАВОМОЧНІСТЬ голосувати (eligible,
    ///      memberSince <= timepoint) уже й так коректно перевірялась
    ///      відносно timepoint. Це залишало вікно маніпуляції: побачивши
    ///      важливу пропозицію, учасник міг за час голосування (дні)
    ///      отримати додаткові донати через TipJar і штучно наростити
    ///      Influence саме перед тим, як голосувати. Тепер вага теж читається
    ///      "замороженою" на timepoint — getPastVotingPower() у
    ///      InfluenceRegistry (той самий Checkpoints.Trace208-патерн, що й
    ///      ShieldSBT.getPastTotalSupply, яким тут вже й так користується
    ///      getPastTotalSupply нижче).
    function _weightAt(address account, uint256 timepoint) internal view returns (uint256) {
        bool eligible =
            (shieldSBT.isMember(account) && shieldSBT.memberSince(account) <= timepoint) ||
            (councilSBT.isCouncilMember(account) && councilSBT.memberSince(account) <= timepoint);
        if (!eligible) return 0;
        if (!shieldSBT.isCompliant(account)) return 0;
        if (discipline.isRestricted(account)) return 0;
        return influenceRegistry.getPastVotingPower(account, timepoint);
    }
}

contract DaoGovernor is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorTimelockControl
{
    ShieldSBT        public immutable shieldSBT;
    CouncilSBT       public immutable councilSBT;
    InfluenceRegistry   public immutable influenceRegistry;
    DisciplineModule public immutable discipline;
    CouncilRankingEpoch public immutable rankingEpoch;
    LocationRegistry public immutable locationRegistry;

    // (using H3Utils for uint64; прибрано в Гео-реформі v12 — territory-
    // перевірка тепер читає вже ZK-перевірені предки з LocationRegistry)

    /// @notice Кворум для ЗВИЧАЙНИХ (EARTH-масштабних) пропозицій — % від
    ///         shieldSBT.activeSupply. Скоуповані пропозиції використовують
    ///         scopedQuorumFloor нижче (інша логіка). ОРІЄНТОВНО, до
    ///         підтвердження перед mainnet.
    uint256 public constant QUORUM_BPS = 2_000; // 20%

    mapping(uint256 => uint256) private _voterCount;

    /// @notice Гео-скоуп пропозиції ("поверх" — термінологія з обговорення: EARTH = найвищий поверх/вхід, level 0..10 —
    ///         щораз нижчі, вужчі поверхи). set=false означає ЗВИЧАЙНУ
    ///         (EARTH-масштабну) пропозицію — голосують усі, без обмежень
    ///         (стандартний propose(), без змін поведінки).
    struct ProposalScope {
        int8   level;
        uint64 branchId;
        bool   set;
    }
    mapping(uint256 => ProposalScope) public proposalScope;

    /// @notice Мінімальна АБСОЛЮТНА явка для СКОУПОВАНИХ (не-EARTH)
    ///         пропозицій — нижня межа поверх rankingEpoch.quorumFor()
    ///         (див. _quorumReached() нижче: max(floor, %)) — захищає
    ///         від протилежного краю (дуже маленький nodeSeatCount →
    ///         дуже маленький % кворум, теоретично 0-1 голос). Це ВСЕ ЩЕ
    ///         не ідеальний territory-aware % кворум (nodeSeatCount —
    ///         дані, заявлені сабмітером, не перевірений ончейн факт
    ///         "хто реально живе в X" — той самий клас довіри, що й
    ///         nodeOverflowed, див. GEO_REFORM_V11_CHANGES.md), але
    ///         прибирає головну діру: раніше ЄДИНИМ порогом було це саме
    ///         число, однакове для будь-якого гексагону незалежно від
    ///         реальної населеності — див. _quorumReached(). DAO-керовано.
    uint256 public scopedQuorumFloor = 3;

    event ProposalScoped(uint256 indexed proposalId, int8 level, uint64 branchId);
    event ScopedQuorumFloorUpdated(uint256 newFloor);

    /// @notice Параметри GovernorSettings, що передаються при деплої —
    ///         НЕ зашиті в тіло контракту, щоб testnet (короткі значення,
    ///         швидкий цикл propose→vote→queue→execute для перевірки) і
    ///         mainnet (реальні значення) використовували ОДИН і той
    ///         самий байткод, лише з різними конструкторними аргументами
    ///         (той самий принцип, що й testMode у ShieldSBT/CouncilSBT).
    ///         proposalThreshold тут НЕ використовується для гейтингу
    ///         пропозицій (це робить require() у _propose() нижче) —
    ///         лишений 0 за замовчуванням, якщо не вказано інше.
    struct GovernorConfig {
        uint48  votingDelay;
        uint32  votingPeriod;
        uint256 proposalThreshold;
    }

    constructor(
        address _influenceRegistry,
        address _shieldSBT,
        address _councilSBT,
        address _discipline,
        address _rankingEpoch,
        TimelockController _timelock,
        GovernorConfig memory gc
    )
        Governor("DaoGovernor")
        GovernorSettings(
            gc.votingDelay,
            gc.votingPeriod,
            gc.proposalThreshold
        )
        GovernorVotes(
            IVotes(address(new DaoVotesAdapter(_influenceRegistry, _shieldSBT, _councilSBT, _discipline)))
        )
        GovernorTimelockControl(_timelock)
    {
        shieldSBT      = ShieldSBT(_shieldSBT);
        councilSBT     = CouncilSBT(_councilSBT);
        influenceRegistry = InfluenceRegistry(_influenceRegistry);
        discipline     = DisciplineModule(_discipline);
        rankingEpoch   = CouncilRankingEpoch(_rankingEpoch);
        locationRegistry = rankingEpoch.locationRegistry();
    }

    /// @notice Кворум для ВСІХ пропозицій — % від shieldSBT.activeSupply
    ///         станом на timepoint (НЕ Shield+Council — див. NatSpec
    ///         контракту щодо виправлення подвійного обліку). ⚠️ Було
    ///         totalSupply — див. коментар біля getPastTotalSupply() вище
    ///         щодо вирішення проблеми "неактивна більшість блокує голосування".
    function quorum(uint256 timepoint) public view override returns (uint256) {
        return (shieldSBT.getPastActiveSupply(timepoint) * QUORUM_BPS) / 10_000;
    }

    /// @notice Пропонувати може лише Council (НЕ Shield). Немає окремого
    ///         класу Policy-пропозицій — зміна Політики прав людини
    ///         (ShieldSBT.setPolicy()/setReacceptGracePeriod()) проходить
    ///         тим самим шляхом, що й будь-яка інша пропозиція.
    function _propose(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description,
        address proposer
    ) internal override(Governor) returns (uint256) {
        require(councilSBT.isCouncilMember(proposer), "DaoGovernor: only Council can propose");

        return super._propose(targets, values, calldatas, description, proposer);
    }

    /**
     * @notice Гео-скоупована пропозиція — той самий propose(), але
     *         прив'язана до конкретного "поверху" (гексагону). Голосувати
     *         зможуть ЛІШЕ ті, чия задекларована локація належить цій
     *         території (level, branchId) чи глибше в ній — див.
     *         _isWithinTerritory() і _countVote() нижче.
     *
     *         Пропонент МАЄ обирати ЛИШЕ з поверхів, доступних ЙОМУ самому
     *         (від EARTH до його власного найглибшого відкритого) — не
     *         довільний H3-індекс. Список актуальних варіантів для UI-
     *         дропдауна формує офчейн-індексер (читає NodeStatusUpdated),
     *         контракт лише ВАЛІДУЄ конкретний вибір при виклику.
     *
     * @param level    EARTH (rankingEpoch.LEVEL_EARTH()) чи 0..MAX_RESOLUTION
     * @param branchId Конкретний гексагон цього рівня (rankingEpoch.EARTH_BRANCH()
     *                 для EARTH)
     * @param seatIndex Індекс листка пропонента в submitSeatAssignments()
     *                  поточної епохи — ІГНОРУЄТЬСЯ, якщо level != EARTH
     *                  (передайте 0).
     * @param seatProof Merkle-доказ, що пропонент реально в топ-244 (місце
     *                  на вузлі EARTH) поточної епохи — ІГНОРУЄТЬСЯ, якщо
     *                  level != EARTH (передайте порожній масив).
     */
    /**
     * @notice Гео-скоупована пропозиція — той самий propose(), але
     *         прив'язана до конкретного "поверху" (гексагону). Голосувати
     *         зможуть ЛІШЕ ті, чия задекларована локація належить цій
     *         території (level, branchId) чи глибше в ній — див.
     *         _isWithinTerritory() і _countVote() нижче.
     *
     *         Пропонент МАЄ обирати ЛИШЕ з поверхів, доступних ЙОМУ самому
     *         (від EARTH до його власного найглибшого відкритого) — не
     *         довільний H3-індекс. Список актуальних варіантів для UI-
     *         дропдауна формує офчейн-індексер (читає NodeStatusUpdated),
     *         контракт лише ВАЛІДУЄ конкретний вибір при виклику.
     *
     * @param level    EARTH (rankingEpoch.LEVEL_EARTH()) чи 0..MAX_RESOLUTION
     * @param branchId Конкретний гексагон цього рівня (rankingEpoch.EARTH_BRANCH()
     *                 для EARTH)
     * @param seatLevel    Рівень, де пропонент РЕАЛЬНО має місце (seat) —
     *                     має бути <= level (можна пропонувати на СВОЄМУ
     *                     рівні чи глибше у власній гілці, НІКОЛИ вище).
     *                     Для EARTH завжди має дорівнювати LEVEL_EARTH.
     *                     Ігнорується, якщо ранжування ще не значуще на
     *                     цій ділянці мережі (див. _validateScopeChoice).
     * @param seatBranchId Гексагон місця пропонента на seatLevel (для
     *                     EARTH — завжди EARTH_BRANCH). Якщо seatLevel==level,
     *                     має дорівнювати branchId.
     * @param seatIndex Індекс листка пропонента в submitSeatAssignments()
     *                  поточної епохи.
     * @param seatProof Merkle-доказ місця (seatLevel, seatBranchId) поточної епохи.
     */
    function proposeScoped(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description,
        int8 level,
        uint64 branchId,
        int8 seatLevel,
        uint64 seatBranchId,
        uint256 seatIndex,
        bytes32[] calldata seatProof
    ) public returns (uint256 proposalId) {
        _validateScopeChoice(_msgSender(), level, branchId, seatLevel, seatBranchId, seatIndex, seatProof);

        proposalId = propose(targets, values, calldatas, description);
        proposalScope[proposalId] = ProposalScope({ level: level, branchId: branchId, set: true });

        emit ProposalScoped(proposalId, level, branchId);
    }

    /// @dev Перевіряє, що (level, branchId) — реально активний вузол
    ///      (nodeOverflowed) і належить власній території пропонента; а
    ///      також — що пропонент реально має МІСЦЕ (seat) на рівні
    ///      seatLevel <= level (в межах ВЛАСНОЇ гілки, від EARTH до
    ///      будь-якого глибшого гексагону, де він "предок").
    ///
    ///      ⚠️ ГЕО-РЕФОРМА v14 ("справедливий рейтинг", узагальнено на
    ///      ВСІ рівні, не лише EARTH): рейтинг реально визначає МІСЦЯ для
    ///      ВСІХ Консулів разом з їхніми активними гексагонами — топ-244
    ///      займають EARTH; наступні 244 з ОДНАКОВИМ батьківським
    ///      гексагоном рівня 0 займають рівень 0 цього гексагону; і так
    ///      каскадно углиб. Консул, чиє місце — рівень 5, НЕ може
    ///      пропонувати на рівнях EARTH..4 (там місця належать іншим,
    ///      вищим у рейтингу) — лише на СВОЄМУ рівні 5 і глибше (6..10) у
    ///      ВЛАСНІЙ гілці, де він "предок" — і лише для гексагонів, що
    ///      реально активні (nodeOverflowed).
    ///
    ///      Ранжування стає ЗНАЧУЩИМ (і місце — обов'язковим) лише коли
    ///      EARTH уже переповнений (244+ кандидатів глобально) — до того
    ///      всі Консули де-факто рівні, і формальний Merkle-доказ місця
    ///      не вимагається на ЖОДНОМУ рівні (інакше виникав би новий
    ///      дедлок бутстрапу: одразу після генезису жоден seat root ще не
    ///      подано, і довести місце не міг би ніхто, включно з першим
    ///      реальним Консулом).
    function _validateScopeChoice(
        address proposer,
        int8 level,
        uint64 branchId,
        int8 seatLevel,
        uint64 seatBranchId,
        uint256 seatIndex,
        bytes32[] calldata seatProof
    ) internal view {
        int8 earthLevel = rankingEpoch.LEVEL_EARTH();
        uint64 earthBranch = rankingEpoch.EARTH_BRANCH();
        bool earthOverflowed = rankingEpoch.nodeOverflowed(rankingEpoch.nodeKeyOf(earthLevel, earthBranch));

        if (level == earthLevel) {
            require(branchId == earthBranch, "DaoGovernor: bad EARTH branch");
            if (earthOverflowed) {
                require(
                    rankingEpoch.verifySeatLeaf(rankingEpoch.currentEpoch(), seatIndex, proposer, true, earthLevel, earthBranch, seatProof),
                    "DaoGovernor: not in EARTH top-244 seat set"
                );
            }
            return;
        }
        require(level >= 0, "DaoGovernor: invalid level");

        bytes32 key = rankingEpoch.nodeKeyOf(level, branchId);
        require(rankingEpoch.nodeOverflowed(key), "DaoGovernor: hexagon not active");
        require(_isWithinTerritory(proposer, level, branchId), "DaoGovernor: outside your own territory");

        if (earthOverflowed) {
            // Ранжування вже значуще на цій ділянці мережі — потрібне
            // реальне місце СЕБЕ САМОГО, не глибше за цільовий рівень.
            require(seatLevel <= level, "DaoGovernor: seat level deeper than proposal level");
            require(
                rankingEpoch.verifySeatLeaf(rankingEpoch.currentEpoch(), seatIndex, proposer, true, seatLevel, seatBranchId, seatProof),
                "DaoGovernor: no seat at or above this level"
            );
            // seatBranchId математично гарантовано є предком branchId на
            // seatLevel (обидва — розкриті значення ОДНОГО й того самого
            // committed hexId пропонента), АЛЕ саму належність seatLevel
            // пропоненту (а не чужий гексагон) все одно треба звірити —
            // інакше можна було б підставити СЕАТ довільного іншого
            // акаунта з тим самим (seatLevel, seatBranchId), не своєї
            // локації.
            require(_isWithinTerritory(proposer, seatLevel, seatBranchId), "DaoGovernor: seat branch not your own territory");
        }
    }

    /// @dev Чи належить `account` території (level, branchId) — тобто чи є
    ///      branchId предком (чи самим) задекларованого гексагону account
    ///      на цьому рівні. EARTH (level<0) — територія всіх, завжди true.
    ///      Без розкритого предка на цьому рівні — територія недоступна
    ///      (false для будь-якого level>=0).
    ///      ⚠️ Гео-реформа v12 (ZK-приватність): раніше рахувалось з
    ///      сирого hexId через H3Utils.ancestorOf(). Тепер hexId
    ///      прихований — territory-перевірка можлива лише для рівнів, які
    ///      account САМ явно розкрив через ZK-доказ (LocationRegistry.
    ///      revealAncestor()). Якщо account ще не розкрив саме цей
    ///      рівень — він не може ні пропонувати, ні голосувати на ньому,
    ///      доки не розкриє (природний стимул: щоб брати участь у
    ///      локальному голосуванні, розкрий свій предок на потрібному
    ///      рівні — не глибше).
    ///      ⚠️ ГЕО-РЕФОРМА v14: тепер читає epoch-aware значення
    ///      (getRevealedAncestorAt на currentEpochStartedAt), а НЕ живе —
    ///      інакше учасник міг би розкрити нову територію прямо перед
    ///      голосуванням і миттєво отримати вплив у "чужому" регіоні
    ///      ("територіальний стрибок"). Право голосу за конкретну
    ///      територію діє лише для розкриттів, що були чинними ще ДО
    ///      початку поточної (90-денної) епохи.
    function _isWithinTerritory(address account, int8 level, uint64 branchId) internal view returns (bool) {
        if (level < 0) return true; // EARTH

        uint64 revealed = locationRegistry.getRevealedAncestorAt(
            account, level, rankingEpoch.currentEpochStartedAt()
        );
        return revealed != 0 && revealed == branchId;
    }

    /// @notice Змінити мінімальну абсолютну явку для скоупованих
    ///         пропозицій (⚠️ інтерим-механізм, див. коментар біля
    ///         scopedQuorumFloor вище). DAO-керовано.
    function setScopedQuorumFloor(uint256 newFloor) external {
        require(_msgSender() == address(timelock()), "DaoGovernor: only via governance");
        require(newFloor > 0, "DaoGovernor: zero floor");
        scopedQuorumFloor = newFloor;
        emit ScopedQuorumFloorUpdated(newFloor);
    }

    /// @notice Рахує голоси звичайною вагою (Shield/Council через
    ///         influenceRegistry.votingPower()) — та сама вага для ВСІХ
    ///         пропозицій, включно з Policy. Для СКОУПОВАНИХ пропозицій
    ///         ДОДАТКОВО перевіряє, що voter належить території пропозиції
    ///         (_isWithinTerritory) — інакше voting reverts (не мовчазний
    ///         weight=0, а явна відмова: голос "не з того під'їзду").
    function _countVote(
        uint256 proposalId,
        address account,
        uint8 support,
        uint256 totalWeight,
        bytes memory params
    ) internal override(Governor, GovernorCountingSimple) returns (uint256) {
        ProposalScope memory scope = proposalScope[proposalId];
        if (scope.set && scope.level >= 0) {
            require(
                _isWithinTerritory(account, scope.level, scope.branchId),
                "DaoGovernor: vote outside proposal's territory"
            );
        }

        uint256 counted = super._countVote(proposalId, account, support, totalWeight, params);

        if (totalWeight > 0) {
            _voterCount[proposalId]++;
            influenceRegistry.touchActivity(account);
        }
        return counted;
    }

    /// @notice Кворум досягнуто. ЗВИЧАЙНІ (EARTH) пропозиції — % від
    ///         shieldSBT.activeSupply(), як і раніше. СКОУПОВАНІ — ⚠️
    ///         ВИПРАВЛЕНО (реальна діра, знайдена через обговорення):
    ///         раніше scopedQuorumFloor був ОДНАКОВИМ фіксованим числом
    ///         (3) для БУДЬ-ЯКОГО гексагону — і густонаселеного, і
    ///         щойно відкритого з мінімальною людністю. Це давало
    ///         експлойт: свідомо задекларувати (і розкрити через ZK)
    ///         локацію саме в щойно відкритому МАЛОлюдному гексагоні й
    ///         продавити локальну пропозицію (напр. withdrawFromHex)
    ///         буквально 3 голосами, непропорційно до реальної
    ///         присутності. Тепер — max(scopedQuorumFloor,
    ///         rankingEpoch.quorumFor(level,branchId)) — той самий
    ///         патерн max(флор, %), що вже є в DisciplineModule
    ///         (WARNING_PARTICIPATION_FLOOR тощо), і перевикористовує
    ///         ВЖЕ ІСНУЮЧУ nodeSeatCount (заявлена сабмітером населеність
    ///         ЦЬОГО КОНКРЕТНОГО вузла) — жодного нового обліку не
    ///         знадобилось, quorumFor() уже був у CouncilRankingEpoch.
    ///         Не ідеально (nodeSeatCount так само залежить від чесності
    ///         сабмітера — той самий клас довіри, що й nodeOverflowed,
    ///         див. GEO_REFORM_V11_CHANGES.md), але прибирає ФІКСОВАНУ,
    ///         завжди-однакову ціль для атаки.
    function _quorumReached(uint256 proposalId)
        internal view override(Governor, GovernorCountingSimple) returns (bool)
    {
        ProposalScope memory scope = proposalScope[proposalId];
        if (scope.set && scope.level >= 0) {
            uint256 nodeQuorum = rankingEpoch.quorumFor(scope.level, scope.branchId);
            uint256 required = nodeQuorum > scopedQuorumFloor ? nodeQuorum : scopedQuorumFloor;
            return _voterCount[proposalId] >= required;
        }
        uint256 snapshot = proposalSnapshot(proposalId);
        return _voterCount[proposalId] >= quorum(snapshot);
    }

    // ── Перевизначення (вирішення конфліктів множинного наслідування) ──

    function votingDelay() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingDelay();
    }

    function votingPeriod() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingPeriod();
    }

    function proposalThreshold() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.proposalThreshold();
    }

    function state(uint256 proposalId)
        public view override(Governor, GovernorTimelockControl) returns (ProposalState)
    {
        return super.state(proposalId);
    }

    function proposalNeedsQueuing(uint256 proposalId)
        public view override(Governor, GovernorTimelockControl) returns (bool)
    {
        return super.proposalNeedsQueuing(proposalId);
    }

    function _queueOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint48) {
        return super._queueOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _executeOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) {
        super._executeOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint256) {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }

    function _executor() internal view override(Governor, GovernorTimelockControl) returns (address) {
        return super._executor();
    }
}
