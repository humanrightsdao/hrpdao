// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ShieldSBT.sol";
import "./CouncilSBT.sol";
import "./InfluenceRegistry.sol";

/**
 * @title DisciplineModule
 * @notice Двопалатний механізм санкцій за "порушення політики прав людини
 *         та етики" (узгоджено в обговоренні токеноміки).
 *
 * Процедура:
 *   1. Будь-який Shield-власник пропонує санкцію на адресу-порушника,
 *      ОБОВ'ЯЗКОВО з посиланням на конкретний пост-доказ (violationPostRef —
 *      keccak256 від Lens post ID, де задокументоване порушення). Пропонент
 *      одразу фіксує КОНКРЕТНИЙ тип санкції (Warning / PartialRestriction /
 *      FullSlash) — голосування НЕ є мультивибором з кількох варіантів
 *      санкції одночасно (узгоджено: мультивибір розмиває голоси між
 *      варіантами і не дозволяє жодному з них набрати кворум, навіть коли
 *      більшість вважає, що якась санкція потрібна; також відкриває
 *      маніпуляцію через навмисне "підсадження" конкуруючих варіантів).
 *   2. Shield-власники голосують SHIELD_VOTING_PERIOD (7 днів), одним із
 *      трьох варіантів: За / Проти / Утримався (узгоджено). Один
 *      Shield-власник = один голос, БЕЗ зважування voting power —
 *      навмисне рішення: дисциплінарне голосування — це каральна функція,
 *      а не розподіл ресурсів, і зважування голосу тут відкрило б шлях до
 *      плутократичного захоплення "суду" (узгоджено).
 *   3. Кворум для проходження — ДВА незалежні пороги одночасно
 *      (узгоджено, замість єдиного "60% від total supply", який при
 *      зростанні спільноти робить санкціонування дедалі важчим навіть
 *      для найлегшої Warning):
 *        а) ЯВКА (participation) — мінімум max(абсолютний флор, X% від
 *           shieldSupplySnapshot) людей мають взагалі проголосувати
 *           (За+Проти+Утримався). Це рахує РЕАЛЬНУ явку на конкретне
 *           голосування, а не оцінку "хто вважається активним" за якесь
 *           календарне вікно (узгоджено: оцінка активності за квартал
 *           дає систематичну похибку — і false positive, і false
 *           negative — тоді як явка в самому голосуванні є точним
 *           ончейн-фактом без оцінок).
 *
 *           ⚠️ ОНОВЛЕНО (вирішення проблеми "неактивна більшість блокує
 *           голосування"): shieldSupplySnapshot ТЕПЕР береться з
 *           shieldSBT.activeSupply(), а не totalSupply(). Це НЕ суперечить
 *           принципу вище — сама ЯВКА (хто реально проголосував) і надалі
 *           точний ончейн-факт, без жодних оцінок. Змінюється лише РОЗМІР
 *           ЗНАМЕННИКА, від якого рахується поріг: раніше він масштабувався
 *           від ВСІХ Shield-власників (включно з роками неактивними
 *           акаунтами), тепер — лише від тих, хто торкався ДАО (донат/
 *           голосування/пропозиція/вето) в межах inactivityWindow (DAO-
 *           керований, дефолт 180 днів). Право голосу в НІКОГО не
 *           забирається — давно неактивний власник Shield може голосувати
 *           будь-коли, автоматично повертаючись у знаменник через
 *           syncActivityStatus(). Детальніше — GEO_REFORM_V8_CHANGES.md.
 *        б) СХВАЛЕННЯ (approval) — серед тих, хто визначився (За+Проти,
 *           БЕЗ урахування Утримався), частка "За" має досягти approval-
 *           порогу. Це ВЖЕ й так рахувалось лише від тих, хто РЕАЛЬНО
 *           проголосував (decided), а не від total/active supply — тому
 *           проблема "неактивна більшість" на approval не впливала.
 *      Обидва пороги — ЯВКА і СХВАЛЕННЯ — зростають разом із тяжкістю
 *      санкції (Warning — м'якші пороги, FullSlash — найсуворіші),
 *      узгоджено з принципом "чим серйозніший наслідок, тим ширша
 *      легітимація потрібна".
 *      Голосувати можуть лише ті, хто вже був Shield-власником ДО
 *      старту пропозиції (memberSince <= createdAt). Нові Shield-власники,
 *      що з'явились ПІД ЧАС голосування, права голосу в НЬОМУ не мають —
 *      інакше сторона під загрозою санкції могла б рекрутувати нових
 *      членів, щоб набрати потрібні голоси чи зірвати кворум. Один раз
 *      відданий голос ЗМІНИТИ НЕЛЬЗЯ (узгоджено: можливість передумати
 *      в останній момент відкриває "vote sniping" — тиск/маніпуляцію
 *      під самий дедлайн).
 *   4. Якщо Shield-голос пройшов — відкривається VETO_WINDOW (10 днів,
 *      узгоджено), протягом якого будь-який Council-власник (що вже БУВ
 *      Council-власником на момент старту цього вікна) може проголосувати
 *      "вето". Апеляційний механізм ЗАЛИШЕНО БЕЗ ЗМІН (узгоджено):
 *      вето — це єдина, бінарна дія (немає "підтвердити", лише
 *      "скасувати"), Council не дублює Shield-голосування, а лише блокує
 *      явно неправомірні випадки; мовчання Council = санкція виконується.
 *   5. Якщо вето набрало БІЛЬШЕ ЗА VETO_QUORUM_BPS (>50%, суворо, після
 *      фіксу — рівно 50% більше НЕ скасовує) від АКТИВНОГО (⚠️
 *      оновлено — councilSBT.activeSupply(), не totalSupply(), той самий
 *      принцип, що й у явці Shield-голосу, п.3а вище) total supply
 *      Council, ЗАФІКСОВАНОГО на момент старту veto-вікна
 *      (councilSupplySnapshot) — санкція СКАСОВУЄТЬСЯ (це і є апеляція,
 *      окремого apellate-флоу не потрібно, узгоджено).
 *   6. Якщо вето не набрало кворуму за 10 днів — санкція виконується
 *      автоматично (будь-хто може викликати execute() після дедлайну).
 *
 * Захист від повторного/спам-голосування (узгоджено, ОНОВЛЕНО):
 * один violationPostRef (один пост-доказ порушення) блокується для
 * подальшого використання ЛИШЕ коли санкція РЕАЛЬНО ВИКОНАНА (Executed) —
 * НЕ в момент пропозиції. Раніше блокування ставилось одразу при
 * proposeSanction(), незалежно від результату голосування — це означало,
 * що одна невдала (наприклад, невиправдано жорстка) пропозиція назавжди
 * "спалювала" доказ, і навіть м'якшу санкцію за той самий задокументований
 * випадок вже ніколи не можна було б запропонувати. Це відкривало вектор
 * зловживання: спільник порушника міг навмисно запропонувати
 * неадекватну санкцію, щоб її провалили і назавжди убезпечити порушника.
 * Якщо пропозиція НЕ пройшла Shield-голосування (Cancelled) — доказ
 * залишається доступним для нової, окремої пропозиції (з іншим типом
 * санкції, зазвичай м'якшим) після REPROPOSAL_COOLDOWN, що запобігає
 * спаму повторними пропозиціями без зміни підходу.
 *
 * Типи санкцій:
 *   Warning            — лише запис у профілі (чорна мітка), без втрати токенів.
 *   PartialRestriction — ТИМЧАСОВЕ призупинення voting power на фіксований
 *                        період (квартал / рік / 5 років — узгоджено, без
 *                        довільних чисел; ⚠️ "назавжди" тут НЕ доступний —
 *                        для постійного наслідку є FullSlash, див. нижче).
 *   FullSlash          — burnByDiscipline() на ShieldSBT і/або CouncilSBT
 *                        (постійний, безповоротний наслідок), залежно від
 *                        того, які токени є у порушника.
 *
 * ⚠️ Політика "що вважається порушенням" — поза кодом (узгоджено: це
 * процедурне/політичне питання, не предмет смартконтракту). Цей контракт
 * лише виконує процедуру голосування й виконання, не визначає матеріальні
 * критерії порушення.
 *
 * ── Re-consent gate ────────────────────────────────────────────
 * Окремо від дисциплінарних санкцій: участь у голосуванні (proposeSanction,
 * voteShield, vetoSanction) вимагає ShieldSBT.isCompliant(msg.sender) — тобто
 * учасник погодив ПОТОЧНУ редакцію Політики прав людини (або ще триває
 * грейс-період після її оновлення). Це НЕ судження про поведінку і тому
 * НЕ проходить через Shield-голос → Council-veto: це об'єктивний on-chain
 * факт (підписав / не підписав), який самообслуговується — учасник
 * відновлює право голосу сам, викликавши acceptPolicy() на ShieldSBT,
 * без будь-якого голосування чи втручання DisciplineModule.
 */
contract DisciplineModule {

    enum SanctionType { Warning, PartialRestriction, FullSlash }
    enum Status { Pending, VetoWindow, Executed, Cancelled }
    // ⚠️ ВИПРАВЛЕНО: "Permanent" прибрано з RestrictionPeriod. PartialRestriction
    // за визначенням ЧАСТКОВА й ТИМЧАСОВА санкція (тимчасове призупинення
    // voting power на фіксований період) — "назавжди" суперечить самій
    // назві/суті "часткового" обмеження і смішує його з FullSlash, який
    // ВЖЕ Є санкцією "назавжди" (спалює SBT безповоротно). Якщо ситуація
    // вимагає постійного наслідку — для цього є FullSlash, окремий,
    // суворіший тип санкції (вищі пороги явки/схвалення, SLASH_*_BPS),
    // а не PartialRestriction із періодом Permanent, який обходив би ці
    // суворіші пороги для того самого практичного результату.
    enum RestrictionPeriod { Quarter, Year, FiveYears }
    enum VoteChoice { For, Against, Abstain }

    struct Proposal {
        address target;
        bytes32 violationPostRef;   // пост-доказ порушення (keccak256 lensPostId)
        SanctionType sType;
        RestrictionPeriod period;   // лише для PartialRestriction
        uint256 createdAt;          // момент proposeSanction — межа "старий/новий" Shield-власник
        uint256 shieldSupplySnapshot; // shieldSBT.totalSupply() зафіксований у createdAt
        uint256 shieldVoteDeadline;
        uint256 shieldForVotes;     // 1 Shield-власник = 1 голос (не influence-weighted)
        uint256 shieldAgainstVotes;
        uint256 shieldAbstainVotes;
        mapping(address => bool) shieldVoted;
        uint256 vetoWindowOpenedAt;  // момент старту veto-вікна — межа "старий/новий" Council-власник
        uint256 councilSupplySnapshot; // councilSBT.totalSupply() зафіксований у vetoWindowOpenedAt
        uint256 vetoDeadline;
        uint256 vetoForVotes;       // 1 Council-власник = 1 голос
        mapping(address => bool) councilVoted;
        Status status;
    }

    ShieldSBT public immutable shieldSBT;
    CouncilSBT public immutable councilSBT;
    InfluenceRegistry public immutable influenceRegistry;

    uint256 public constant SHIELD_VOTING_PERIOD  = 7 days;
    uint256 public constant VETO_WINDOW           = 10 days; // узгоджено
    uint256 public constant VETO_QUORUM_BPS       = 5_000;   // >50% (суворо; узгоджено, апеляція без змін по суті, лише fix нічиєї)
    uint256 public constant BPS_DENOMINATOR       = 10_000;

    /// @notice Cooldown перед повторною пропозицією за тим самим доказом
    ///         після провалу попередньої (узгоджено — захист від спаму,
    ///         водночас доказ не втрачається назавжди).
    uint256 public constant REPROPOSAL_COOLDOWN = 14 days;

    // ── Тьєровані пороги кворуму за тяжкістю санкції (узгоджено) ──────
    // Явка (participation): max(floor, PCT% від shieldSupplySnapshot).
    // Схвалення (approval): частка "За" серед тих, хто визначився
    // (За+Проти, без Утримався).

    uint256 public constant WARNING_PARTICIPATION_BPS = 1_500; // 15%
    uint256 public constant WARNING_PARTICIPATION_FLOOR = 5;
    uint256 public constant WARNING_APPROVAL_BPS = 5_000;      // >50% (суворо; рівно 50% більше НЕ проходить)

    uint256 public constant RESTRICTION_PARTICIPATION_BPS = 2_500; // 25%
    uint256 public constant RESTRICTION_PARTICIPATION_FLOOR = 8;
    uint256 public constant RESTRICTION_APPROVAL_BPS = 5_500;      // >55%

    uint256 public constant SLASH_PARTICIPATION_BPS = 4_000; // 40%
    uint256 public constant SLASH_PARTICIPATION_FLOOR = 12;
    uint256 public constant SLASH_APPROVAL_BPS = 6_600;       // >66% (кваліфікована)

    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;

    /// @notice Кожен пост-доказ блокується для повторного використання
    ///         ЛИШЕ після реального виконання санкції (Executed), не при
    ///         пропозиції — див. пояснення у NatSpec контракту вище.
    mapping(bytes32 => bool) public violationPostUsed;

    /// @notice Момент останньої провальної (Cancelled) спроби по цьому
    ///         доказу — для розрахунку REPROPOSAL_COOLDOWN.
    mapping(bytes32 => uint256) public lastFailedAttempt;

    /// @notice Активні часові обмеження voting power через PartialRestriction.
    mapping(address => uint256) public restrictedUntil;

    /// @notice Кількість "чорних міток" (Warning), отриманих профілем — видимо on-chain.
    mapping(address => uint256) public blackMarks;

    event SanctionProposed(uint256 indexed id, address indexed target, SanctionType sType, bytes32 violationPostRef);
    event ShieldVoted(uint256 indexed id, address indexed voter, VoteChoice choice);
    event VetoWindowOpened(uint256 indexed id, uint256 deadline);
    event CouncilVetoed(uint256 indexed id, address indexed voter);
    event SanctionExecuted(uint256 indexed id);
    event SanctionCancelled(uint256 indexed id);

    constructor(address _shieldSBT, address _councilSBT, address _influenceRegistry) {
        shieldSBT = ShieldSBT(_shieldSBT);
        councilSBT = CouncilSBT(_councilSBT);
        influenceRegistry = InfluenceRegistry(_influenceRegistry);
    }

    // ── Крок 1: пропозиція ──────────────────────────────────────

    /**
     * @param target            Адреса порушника
     * @param violationPostRef  keccak256(lensPostId) посту-доказу. Обов'язковий,
     *                          не bytes32(0), і не заблокований попереднім
     *                          виконанням санкції; якщо остання спроба по
     *                          ньому провалилась (Cancelled) — має пройти
     *                          REPROPOSAL_COOLDOWN.
     * @param sType             Конкретний тип санкції, який пропонується
     *                          (НЕ мультивибір — Shield голосує За/Проти/
     *                          Утримався саме за цей варіант).
     * @param period            Період обмеження (лише для PartialRestriction,
     *                          ігнорується для інших типів)
     */
    function proposeSanction(
        address target,
        bytes32 violationPostRef,
        SanctionType sType,
        RestrictionPeriod period
    ) external returns (uint256 id) {
        require(
            shieldSBT.isMember(msg.sender) || councilSBT.isCouncilMember(msg.sender),
            "Discipline: proposer must be Shield or Council member"
        );
        // isCompliant() перевіряється лише через ShieldSBT: Council-власники за
        // визначенням завжди тримають і Shield (Council — надбудова, не
        // паралельна гілка), тож один спільний PolicyConsentGate на ShieldSBT
        // покриває re-consent-вимогу для обох рівнів. Якщо ця умова колись
        // перестане виконуватись (Council зможе існувати без Shield), сюди
        // треба додати паралельну перевірку councilSBT.isCompliant(msg.sender).
        require(shieldSBT.isCompliant(msg.sender), "Discipline: must re-accept current Human Rights Policy");
        require(
            shieldSBT.isMember(target) || councilSBT.isCouncilMember(target),
            "Discipline: target has no membership to sanction"
        );
        require(violationPostRef != bytes32(0), "Discipline: violation post required");
        require(!violationPostUsed[violationPostRef], "Discipline: this violation already adjudicated");
        require(
            block.timestamp >= lastFailedAttempt[violationPostRef] + REPROPOSAL_COOLDOWN,
            "Discipline: reproposal cooldown active"
        );

        id = ++proposalCount;
        Proposal storage p = proposals[id];
        p.target             = target;
        p.violationPostRef   = violationPostRef;
        p.sType              = sType;
        p.period             = period;
        p.createdAt          = block.timestamp;
        p.shieldSupplySnapshot = shieldSBT.activeSupply(); // ⚠️ activeSupply(), НЕ totalSupply() — див. п.5 нижче
        p.shieldVoteDeadline  = block.timestamp + SHIELD_VOTING_PERIOD;
        p.status             = Status.Pending;

        emit SanctionProposed(id, target, sType, violationPostRef);
        influenceRegistry.touchActivity(msg.sender);
    }

    // ── Крок 2: голосування Shield (За / Проти / Утримався) ──────

    function voteShield(uint256 id, VoteChoice choice) external {
        Proposal storage p = proposals[id];
        require(p.status == Status.Pending, "Discipline: not in Shield voting phase");
        require(block.timestamp <= p.shieldVoteDeadline, "Discipline: Shield voting closed");
        require(shieldSBT.isMember(msg.sender), "Discipline: not a Shield member");
        // Захист від маніпуляції кворумом: голосувати може лише той, хто
        // вже був Shield-власником НА МОМЕНТ пропозиції (createdAt), а не
        // хтось, хто заминтив Shield ПІСЛЯ того, як почалось голосування —
        // інакше сторона під загрозою санкції могла б рекрутувати нових
        // членів під час 7-денного вікна, щоб набрати потрібні голоси
        // чи, навпаки, роздути знаменник і зірвати кворум.
        require(shieldSBT.memberSince(msg.sender) <= p.createdAt, "Discipline: joined after proposal, cannot vote");
        require(shieldSBT.isCompliant(msg.sender), "Discipline: must re-accept current Human Rights Policy");
        require(!p.shieldVoted[msg.sender], "Discipline: already voted");

        p.shieldVoted[msg.sender] = true;
        if (choice == VoteChoice.For) {
            p.shieldForVotes++;
        } else if (choice == VoteChoice.Against) {
            p.shieldAgainstVotes++;
        } else {
            p.shieldAbstainVotes++;
        }

        emit ShieldVoted(id, msg.sender, choice);
        influenceRegistry.touchActivity(msg.sender);
    }

    /// @notice Пороги явки за тяжкістю санкції: max(флор, % від снепшоту).
    function _participationRequired(SanctionType t, uint256 supplySnapshot) internal pure returns (uint256) {
        uint256 pctBps;
        uint256 floor;
        if (t == SanctionType.Warning) {
            pctBps = WARNING_PARTICIPATION_BPS;
            floor  = WARNING_PARTICIPATION_FLOOR;
        } else if (t == SanctionType.PartialRestriction) {
            pctBps = RESTRICTION_PARTICIPATION_BPS;
            floor  = RESTRICTION_PARTICIPATION_FLOOR;
        } else {
            pctBps = SLASH_PARTICIPATION_BPS;
            floor  = SLASH_PARTICIPATION_FLOOR;
        }
        uint256 pctValue = (supplySnapshot * pctBps) / BPS_DENOMINATOR;
        return pctValue > floor ? pctValue : floor;
    }

    /// @notice Поріг схвалення (частка "За" серед визначених) за тяжкістю санкції.
    function _approvalRequiredBps(SanctionType t) internal pure returns (uint256) {
        if (t == SanctionType.Warning) return WARNING_APPROVAL_BPS;
        if (t == SanctionType.PartialRestriction) return RESTRICTION_APPROVAL_BPS;
        return SLASH_APPROVAL_BPS;
    }

    /**
     * @notice Закрити фазу Shield-голосування. Потрібні ОБИДВА пороги:
     *         явка (participation) від зафіксованого снепшоту, і
     *         схвалення (approval) серед тих, хто визначився (За+Проти).
     *         Якщо досягнуто — відкривається veto-вікно 10 днів. Інакше —
     *         пропозиція скасована, і починається REPROPOSAL_COOLDOWN.
     */
    function finalizeShieldVote(uint256 id) external {
        Proposal storage p = proposals[id];
        require(p.status == Status.Pending, "Discipline: wrong status");
        require(block.timestamp > p.shieldVoteDeadline, "Discipline: voting still open");

        // Знаменник — totalSupply, ЗАФІКСОВАНИЙ у момент пропозиції
        // (shieldSupplySnapshot), а не поточний totalSupply(). Live-значення
        // тут неприпустиме: нові mint-и під час 7-денного вікна голосування
        // або зменшили б, або дозволили б штучно вплинути на пороги.
        uint256 totalShield = p.shieldSupplySnapshot;
        uint256 totalVoted  = p.shieldForVotes + p.shieldAgainstVotes + p.shieldAbstainVotes;
        uint256 decided     = p.shieldForVotes + p.shieldAgainstVotes; // без Утримався

        bool participationOk = totalShield > 0 &&
            totalVoted >= _participationRequired(p.sType, totalShield);

        // ⚠️ ВИПРАВЛЕНО: було ">=", тобто РІВНО 50% "За" (нічия 50/50 серед
        // визначених) уже проходила — при WARNING_APPROVAL_BPS=5000 (50%)
        // це означало, що звичайна нічия санкціонує людину. Тепер строго
        // ">" — потрібна СПРАВЖНЯ більшість (50%+1 голос і вище), нічия
        // санкцію НЕ проводить. Для вищих порогів (55%/66%) це та сама
        // зміна ">= X%" → "> X%" — на практиці майже завжди байдуже (точне
        // влучення в X% при цілочисельних голосах — рідкісний збіг), але
        // семантика тепер послідовна для ВСІХ трьох рівнів тяжкості.
        bool approvalOk = decided > 0 &&
            (p.shieldForVotes * BPS_DENOMINATOR) / decided > _approvalRequiredBps(p.sType);

        bool quorumReached = participationOk && approvalOk;

        if (!quorumReached) {
            p.status = Status.Cancelled;
            lastFailedAttempt[p.violationPostRef] = block.timestamp;
            emit SanctionCancelled(id);
            return;
        }

        p.status = Status.VetoWindow;
        p.vetoWindowOpenedAt = block.timestamp;
        p.councilSupplySnapshot = councilSBT.activeSupply(); // ⚠️ activeSupply(), НЕ totalSupply() — див. п.5 нижче
        p.vetoDeadline = block.timestamp + VETO_WINDOW;

        emit VetoWindowOpened(id, p.vetoDeadline);
    }

    // ── Крок 3: вето Council (= апеляція, БЕЗ ЗМІН) ────────────────

    function vetoSanction(uint256 id) external {
        Proposal storage p = proposals[id];
        require(p.status == Status.VetoWindow, "Discipline: not in veto window");
        require(block.timestamp <= p.vetoDeadline, "Discipline: veto window closed");
        require(councilSBT.isCouncilMember(msg.sender), "Discipline: not a Council member");
        // Той самий захист від маніпуляції кворумом, що й у voteShield:
        // лише Council-власники, що вже були членами НА МОМЕНТ старту
        // veto-вікна (vetoWindowOpenedAt), можуть накладати вето.
        require(councilSBT.memberSince(msg.sender) <= p.vetoWindowOpenedAt, "Discipline: joined after veto window opened, cannot vote");
        require(shieldSBT.isCompliant(msg.sender), "Discipline: must re-accept current Human Rights Policy");
        require(!p.councilVoted[msg.sender], "Discipline: already vetoed");

        p.councilVoted[msg.sender] = true;
        p.vetoForVotes++;

        emit CouncilVetoed(id, msg.sender);

        // Знаменник — councilSupplySnapshot, зафіксований на старті
        // veto-вікна, а не живий totalSupply() (та сама логіка, що й
        // shieldSupplySnapshot вище).
        // ⚠️ Той самий фікс, що й у finalizeShieldVote(): було ">=", тобто
        // РІВНО 50% голосів Council уже скасовувало санкцію. Тепер строго
        // ">" — потрібна справжня більшість Council, нічия НЕ скасовує.
        uint256 totalCouncil = p.councilSupplySnapshot;
        if (totalCouncil > 0 &&
            (p.vetoForVotes * BPS_DENOMINATOR) / totalCouncil > VETO_QUORUM_BPS)
        {
            p.status = Status.Cancelled;
            emit SanctionCancelled(id);
        }

        // ── CEI: зовнішній виклик — ОСТАННІМ кроком, після ВСІХ записів
        //    стану й подій (включно з умовним p.status = Cancelled вище).
        //    Раніше йшов у середині функції, до цього умовного запису —
        //    Slither (reentrancy-no-eth) коректно вказав на порушення
        //    CEI. Якщо touchActivity() тут revert-не — уся транзакція
        //    відкотиться разом з усіма записами вище, тож поведінка не
        //    змінюється, лише порядок операцій стає безпечнішим.
        influenceRegistry.touchActivity(msg.sender);
    }

    // ── Крок 4/5: виконання після завершення veto-вікна ──────────

    function execute(uint256 id) external {
        Proposal storage p = proposals[id];
        require(p.status == Status.VetoWindow, "Discipline: wrong status");
        require(block.timestamp > p.vetoDeadline, "Discipline: veto window still open");

        p.status = Status.Executed;
        // Доказ блокується для повторного використання ЛИШЕ тепер, при
        // реальному виконанні санкції — не раніше (див. NatSpec контракту).
        violationPostUsed[p.violationPostRef] = true;

        if (p.sType == SanctionType.Warning) {
            blackMarks[p.target]++;
        } else if (p.sType == SanctionType.PartialRestriction) {
            restrictedUntil[p.target] = _restrictionEnd(p.period);
        } else if (p.sType == SanctionType.FullSlash) {
            if (shieldSBT.isMember(p.target)) {
                shieldSBT.burnByDiscipline(p.target, p.violationPostRef);
            }
            if (councilSBT.isCouncilMember(p.target)) {
                councilSBT.burnByDiscipline(p.target, p.violationPostRef);
            }
        }

        emit SanctionExecuted(id);
    }

    /// @notice Фіксовані періоди обмеження — без довільних чисел (узгоджено).
    ///         Лише три значення (Quarter/Year/FiveYears) — "назавжди" тут
    ///         більше НЕ доступний (див. коментар біля enum RestrictionPeriod
    ///         вище); для постійного наслідку є окремий тип санкції FullSlash.
    function _restrictionEnd(RestrictionPeriod period) internal view returns (uint256) {
        if (period == RestrictionPeriod.Quarter) return block.timestamp + 90 days;
        if (period == RestrictionPeriod.Year)    return block.timestamp + 365 days;
        return block.timestamp + 1825 days; // FiveYears (єдиний інший можливий варіант)
    }

    // ── Читання ─────────────────────────────────────────────────

    function isRestricted(address account) external view returns (bool) {
        return block.timestamp < restrictedUntil[account];
    }

    /// @notice Зручний getter для UI: скільки голосів потрібно набрати
    ///         (явка) для конкретної вже створеної пропозиції.
    function participationRequired(uint256 id) external view returns (uint256) {
        Proposal storage p = proposals[id];
        return _participationRequired(p.sType, p.shieldSupplySnapshot);
    }

    /// @notice Зручний getter для UI: поточна явка (За+Проти+Утримався).
    function currentTurnout(uint256 id) external view returns (uint256) {
        Proposal storage p = proposals[id];
        return p.shieldForVotes + p.shieldAgainstVotes + p.shieldAbstainVotes;
    }
}
