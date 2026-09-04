// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "./CouncilSBT.sol";
import "./LocationRegistry.sol";
import "./CouncilRankingEpoch.sol";
import "./SeatMerkleLib.sol";

/**
 * @title OptimisticEpochSubmission
 * @notice Permissionless заміна довіреної EPOCH_SUBMITTER_ROLE: застава +
 *         вікно оскарження (Optimistic Rollup / UMA Oracle патерн).
 *
 * ⚠️⚠️⚠️ v2 — ВИПРАВЛЕНО ГАЗОВУ ПРОБЛЕМУ v1 (виявлено при обговоренні
 * реального навантаження): v1 зберігав ПОВНІ масиви кандидатів у storage
 * (_pendingAccounts тощо) на весь challengePeriod — при N кандидатах це
 * ~N нових SSTORE (~20 000 газу кожен), тобто вже при СОТНЯХ кандидатів
 * (не тисячах) submitEpochResult() ставав практично недеплойованим
 * (block gas limit).
 *
 * НОВА МОДЕЛЬ:
 *   - submitEpochResult() і далі приймає ПОВНІ масиви як CALLDATA (це
 *     дешево, ~16 газу/байт, і саме через calldata дані лишаються
 *     публічно доступними для будь-кого, хто захоче побудувати Merkle-
 *     proof — окремого IPFS не потрібно), АЛЕ будує Merkle-дерево ОНЧЕЙН
 *     із них (SeatMerkleLib — дешеві keccak-операції) і зберігає лише
 *     bytes32-корінь + кількість листків. O(1) storage незалежно від N.
 *   - Усі fraud-proof виклики тепер приймають (account, hasSeat, level,
 *     branchId, index, Merkle-proof) замість індексу в збереженому
 *     масиві — О(log n) перевірка, а не O(1) читання зі storage, але
 *     О(1) storage замість O(n) на submission — саме це й було метою.
 *   - Дані самого подання БІЛЬШЕ НЕ зберігаються в контракті між
 *     submitEpochResult() і finalizeEpoch()/challenge-викликами —
 *     challenger сам відновлює потрібний листок і proof локально
 *     (offchain), читаючи ту саму транзакцію submitEpochResult()
 *     (calldata завжди читне з historical logs/tx — стандартна
 *     властивість будь-якого EVM-вузла/індексера).
 *   - finalizeEpoch() тепер викликає CouncilRankingEpoch.submitSeatRoot()
 *     (новий, легкий метод — просто передає вже готовий корінь), А НЕ
 *     submitSeatAssignments() (який вимагав би масиви ще раз).
 *
 * ЩО ЗМІНИЛОСЬ У НАБОРІ FRAUD-PROOFS ПОРІВНЯНО З v1:
 *   - challengeMissingAccount ВИДАЛЕНО як окрема функція: пряма
 *     Merkle-non-membership перевірка (довести, що X НЕМАЄ в дереві)
 *     значно складніша за перевірку присутності і потребувала б
 *     відсортованого дерева з доказом сусідніх елементів. Натомість
 *     повнота ГАРАНТУЄТЬСЯ КОМБІНАЦІЄЮ трьох інших перевірок:
 *     challengeCountMismatch (кількість листків = councilSBT.
 *     getPastTotalSupply()) + challengeNotCouncilMember (кожен листок —
 *     реальний CouncilSBT-власник) + challengeDuplicateAccount (без
 *     повторів). Якщо всі три проходять — контр-аргументом: N листків,
 *     усі різні, усі реальні Council-власники, і N дорівнює РЕАЛЬНІЙ
 *     загальній кількості Council-власників ⟹ це МАЄ бути ПОВНИЙ набір
 *     (неможливо мати підмножину з рівно стількома різними реальними
 *     членами, скільки їх існує всього, і при цьому когось пропустити).
 *     Якщо зловмисник хоче пропустити X, доведеться "доповнити" кількість
 *     фейковим/дубльованим записом — а це вже ловиться
 *     challengeNotCouncilMember/challengeDuplicateAccount. Оскаржувачу
 *     для цього потрібно ЗНАТИ конкретний "додаток" (не абстрактне X) —
 *     це вимагає читання опублікованих (calldata) даних подання, як і
 *     раніше, просто інструмент інший.
 *   - challengeNodeSeatCountMismatch ПЕРЕРОБЛЕНО: оскаржувач тепер сам
 *     надає до NODE_CAPACITY (244) пар (leaf-дані + proof) для
 *     конкретного вузла — межа природна (не більше 244 місць фізично
 *     може бути присвоєно одному вузлу), тому виклик залишається
 *     обмеженим і не відтворює вихідну проблему.
 */
contract OptimisticEpochSubmission is AccessControl, ReentrancyGuard {
    // (using H3Utils for uint64; прибрано в Гео-реформі v12 — location-
    // виклик тепер звіряє вже ZK-перевірені предки з LocationRegistry)

    bytes32 public constant DAO_ROLE      = keccak256("DAO_ROLE");
    /// @notice Окрема від DAO_ROLE роль — той самий принцип, що GUARDIAN_ROLE
    ///         у Treasury: аварійний важіль, доступний і до того, як
    ///         реальне DAO-голосування стане фізично можливим (бутстрап).
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    CouncilSBT           public immutable councilSBT;
    LocationRegistry      public immutable locationRegistry;
    CouncilRankingEpoch   public immutable rankingEpoch;

    int8   public constant LEVEL_EARTH  = -1;
    uint64 public constant EARTH_BRANCH = 0;
    uint16 public constant NODE_CAPACITY = 244; // той самий інваріант, що CouncilRankingEpoch.NODE_CAPACITY

    // ── DAO-керовані параметри ─────────────────────────────────────
    uint256 public requiredBond = 1 ether;
    uint256 public challengeBond = 0.1 ether;
    uint256 public challengePeriod = 3 days;
    uint256 public epochStaleTimeout = 14 days;

    // ── Стан епохи ────────────────────────────────────────────────
    enum EpochStatus { None, Pending, Finalized, Rejected }

    struct Submission {
        address proposer;
        uint256 bond;
        uint256 submittedAt;
        uint256 snapshotAt;   // момент, на який рахувався councilSBT.getPastTotalSupply()
        bytes32 seatRoot;     // Merkle-корінь per-account даних (побудований ончейн при поданні)
        uint256 leafCount;    // кількість листків у дереві — для challengeCountMismatch
        EpochStatus status;
    }

    mapping(uint256 => Submission) public submissions;

    // per-node дані (МАЛЕНЬКИЙ масив, обмежений кількістю АКТИВНИХ вузлів,
    // не кандидатів — тут газової проблеми немає, лишається прямим масивом).
    mapping(uint256 => NodeStatus[]) private _pendingNodeStatuses;

    uint256 public currentEpoch;
    uint256 public currentEpochOpenedAt;

    // ── Події ───────────────────────────────────────────────────────
    event EpochSubmitted(uint256 indexed epoch, address indexed proposer, bytes32 seatRoot, uint256 leafCount, uint256 bond);
    event EpochChallenged(uint256 indexed epoch, address indexed challenger, string reason);
    event EpochFinalized(uint256 indexed epoch, bytes32 seatRoot);
    event EpochRejected(uint256 indexed epoch, address indexed slashedProposer, address indexed rewardedChallenger);
    event ParamsUpdated(uint256 requiredBond, uint256 challengeBond, uint256 challengePeriod, uint256 epochStaleTimeout);

    constructor(
        address _councilSBT,
        address _locationRegistry,
        address _rankingEpoch,
        address dao,
        address[] memory guardians
    ) {
        councilSBT       = CouncilSBT(_councilSBT);
        locationRegistry = LocationRegistry(_locationRegistry);
        rankingEpoch      = CouncilRankingEpoch(_rankingEpoch);

        _setRoleAdmin(DAO_ROLE, DAO_ROLE);
        _setRoleAdmin(GUARDIAN_ROLE, DAO_ROLE);
        _grantRole(DAO_ROLE, dao);
        if (msg.sender != dao) {
            _grantRole(DAO_ROLE, msg.sender); // тимчасово, для генезис-вайрингу
        }
        for (uint256 i = 0; i < guardians.length; i++) {
            _grantRole(GUARDIAN_ROLE, guardians[i]);
        }

        currentEpochOpenedAt = block.timestamp;
    }

    // ── Крок 1: подання (permissionless, будь-хто зі заставою) ─────

    struct NodeStatus {
        int8   level;
        uint64 branchId;
        uint32 seatCount;
        bool   overflowed;
    }

    /**
     * @notice Подати результат епохи. accounts/hasSeatFlags/levels/branchIds
     *         передаються В CALLDATA і НЕ зберігаються — контракт лише
     *         будує з них Merkle-корінь (SeatMerkleLib) і зберігає його.
     *         nodeStatuses (малий масив) зберігається прямо, без Merkle.
     */
    function submitEpochResult(
        address[] calldata accounts,
        bool[] calldata hasSeatFlags,
        int8[] calldata levels,
        uint64[] calldata branchIds,
        NodeStatus[] calldata nodeStatuses
    ) external payable nonReentrant {
        require(msg.value >= requiredBond, "OptEpoch: insufficient bond");
        require(
            submissions[currentEpoch].status == EpochStatus.None ||
            submissions[currentEpoch].status == EpochStatus.Rejected,
            "OptEpoch: submission already pending or finalized"
        );
        uint256 len = accounts.length;
        require(
            len == hasSeatFlags.length && len == levels.length && len == branchIds.length,
            "OptEpoch: length mismatch"
        );

        uint256 bond = requiredBond;

        bytes32[] memory leaves = new bytes32[](len);
        for (uint256 i = 0; i < len; i++) {
            leaves[i] = SeatMerkleLib.leafHash(i, accounts[i], hasSeatFlags[i], levels[i], branchIds[i]);
        }
        bytes32 root = SeatMerkleLib.buildRoot(leaves);

        submissions[currentEpoch] = Submission({
            proposer:    msg.sender,
            bond:        bond,
            submittedAt: block.timestamp,
            snapshotAt:  currentEpochOpenedAt,
            seatRoot:    root,
            leafCount:   len,
            status:      EpochStatus.Pending
        });

        delete _pendingNodeStatuses[currentEpoch];
        NodeStatus[] storage stored = _pendingNodeStatuses[currentEpoch];
        for (uint256 i = 0; i < nodeStatuses.length; i++) {
            stored.push(nodeStatuses[i]);
        }

        emit EpochSubmitted(currentEpoch, msg.sender, root, len, bond);

        // ── CEI: рефанд переплати — ОСТАННІМ кроком, після ВСІХ записів
        //    стану й події. Раніше йшов одразу після requestBond-перевірки
        //    (до запису submissions[currentEpoch]) — Slither (reentrancy-eth)
        //    коректно вказав на порушення CEI. Практичний ризик був
        //    низьким (submitEpochResult має nonReentrant; єдиний
        //    cross-function вектор — forceOpenEpoch() — вимагає вже
        //    скомпрометованої DAO_ROLE/GUARDIAN_ROLE), але виправлення
        //    коштує нуля функціональних змін.
        if (msg.value > bond) {
            _safeSend(msg.sender, msg.value - bond); // рефанд переплати
        }
    }

    // ── Крок 2: fraud-proofs (усі приймають Merkle-proof, не індекс) ─

    /// @notice #1: вузол перевищує NODE_CAPACITY. Оскаржувач надає до
    ///         NODE_CAPACITY+1 (leaf-даних+proof) записів, що належать
    ///         заявленому вузлу — межа природна (фізично не може бути
    ///         більше листків з hasSeat=true на одному вузлі за задумом,
    ///         тож NODE_CAPACITY+1 валідних доказів вже сам по собі є
    ///         достатнім доказом переповнення).
    function challengeNodeOverflow(
        uint256 epoch,
        int8 level,
        uint64 branchId,
        LeafProof[] calldata proofs
    ) external payable nonReentrant {
        Submission storage sub = _requireChallengeable(epoch);
        _takeChallengeBond();

        require(proofs.length > NODE_CAPACITY, "OptEpoch: not enough proofs to demonstrate overflow");
        uint256 seatedCount = _verifyAndCountAtNode(sub.seatRoot, proofs, level, branchId, true);
        require(seatedCount > NODE_CAPACITY, "OptEpoch: node not actually overflowing");

        _rejectEpoch(epoch, sub, msg.sender, "node capacity exceeded");
    }

    /// @notice #2: виключений акаунт має вищу votingPower(), ніж місцевий
    ///         на тому самому вузлі.
    function challengeRankingOrder(
        uint256 epoch,
        LeafData calldata seated,
        bytes32[] calldata seatedProof,
        LeafData calldata excluded,
        bytes32[] calldata excludedProof
    ) external payable nonReentrant {
        Submission storage sub = _requireChallengeable(epoch);
        _takeChallengeBond();

        _requireValidLeaf(sub.seatRoot, seated, seatedProof);
        _requireValidLeaf(sub.seatRoot, excluded, excludedProof);

        require(seated.hasSeat, "OptEpoch: 'seated' has no seat");
        require(!excluded.hasSeat, "OptEpoch: 'excluded' has a seat");
        require(
            seated.level == excluded.level && seated.branchId == excluded.branchId,
            "OptEpoch: not the same node"
        );

        uint256 seatedPower   = councilSBT.influenceRegistry().votingPower(seated.account);
        uint256 excludedPower = councilSBT.influenceRegistry().votingPower(excluded.account);
        require(excludedPower > seatedPower, "OptEpoch: ranking order is correct");

        _rejectEpoch(epoch, sub, msg.sender, "ranking order violated");
    }

    /// @notice #3: акаунт у поданні НЕ є власником CouncilSBT.
    function challengeNotCouncilMember(uint256 epoch, LeafData calldata leaf, bytes32[] calldata proof)
        external payable nonReentrant
    {
        Submission storage sub = _requireChallengeable(epoch);
        _takeChallengeBond();

        _requireValidLeaf(sub.seatRoot, leaf, proof);
        require(!councilSBT.isCouncilMember(leaf.account), "OptEpoch: actually is a council member");

        _rejectEpoch(epoch, sub, msg.sender, "listed account is not a council member");
    }

    /// @notice #4: один акаунт присутній двічі (два різні індекси, той
    ///         самий account) — обидва листки валідні окремо, але
    ///         суперечать вимозі унікальності.
    function challengeDuplicateAccount(
        uint256 epoch,
        LeafData calldata a,
        bytes32[] calldata proofA,
        LeafData calldata b,
        bytes32[] calldata proofB
    ) external payable nonReentrant {
        Submission storage sub = _requireChallengeable(epoch);
        _takeChallengeBond();

        require(a.index != b.index, "OptEpoch: same index, not a duplicate");
        _requireValidLeaf(sub.seatRoot, a, proofA);
        _requireValidLeaf(sub.seatRoot, b, proofB);
        require(a.account == b.account, "OptEpoch: not actually the same account");

        _rejectEpoch(epoch, sub, msg.sender, "duplicate account in submission");
    }

    /// @notice #5: заявлені level/branchId не відповідають РОЗКРИТОМУ
    ///         (ZK-перевіреному) предку акаунта в LocationRegistry.
    ///         ⚠️ Гео-реформа v12 (ZK-приватність): раніше порівнювалось
    ///         з сирого hexId через H3Utils.ancestorOf(). Тепер hexId
    ///         прихований — єдине, з чим можна звірити заявлене
    ///         призначення, це те, що акаунт САМ явно розкрив
    ///         (LocationRegistry.revealAncestor()). Якщо акаунт узагалі
    ///         НІЧОГО не розкрив на цьому рівні (getRevealedAncestor
    ///         повертає 0) — БУДЬ-яке ненульове заявлене призначення на
    ///         цьому рівні для нього апріорі необґрунтоване (сабмітеру
    ///         НЕМА звідки було взяти таке значення) — оскаржується так
    ///         само, як і пряма невідповідність.
    function challengeLocationMismatch(uint256 epoch, LeafData calldata leaf, bytes32[] calldata proof)
        external payable nonReentrant
    {
        Submission storage sub = _requireChallengeable(epoch);
        _takeChallengeBond();
        _requireValidLeaf(sub.seatRoot, leaf, proof);

        if (leaf.level == LEVEL_EARTH) {
            revert("OptEpoch: level -1 is always geographically valid, use a different challenge");
        }
        require(leaf.level >= 0, "OptEpoch: negative non-global level");

        uint64 revealedBranch = locationRegistry.getRevealedAncestor(leaf.account, leaf.level);
        require(revealedBranch != leaf.branchId, "OptEpoch: branch actually matches revealed location");

        _rejectEpoch(epoch, sub, msg.sender, "location/branch mismatch");
    }

    /// @notice #6: O(1) перевірка — кількість поданих листків не
    ///         збігається з councilSBT.getPastTotalSupply(snapshotAt).
    ///         РАЗОМ із #3 і #4 логічно гарантує повноту набору (див.
    ///         NatSpec контракту вище) — окремої #7 "missing account" тут
    ///         більше немає, вона в v1 вимагала повного масиву в storage.
    function challengeCountMismatch(uint256 epoch) external payable nonReentrant {
        Submission storage sub = _requireChallengeable(epoch);
        _takeChallengeBond();

        uint256 expectedCount = councilSBT.getPastTotalSupply(sub.snapshotAt);
        require(sub.leafCount != expectedCount, "OptEpoch: count actually matches");

        _rejectEpoch(epoch, sub, msg.sender, "submitted count mismatch vs CouncilSBT snapshot");
    }

    /// @notice #7 (перероблено з v1): заявлений seatCount вузла не
    ///         збігається з реальним. Оскаржувач сам надає ≤ NODE_CAPACITY
    ///         (leaf+proof) пар — межа природна.
    function challengeNodeSeatCountMismatch(
        uint256 epoch,
        int8 level,
        uint64 branchId,
        uint32 claimedSeatCount,
        LeafProof[] calldata proofs
    ) external payable nonReentrant {
        Submission storage sub = _requireChallengeable(epoch);
        _takeChallengeBond();

        require(proofs.length <= NODE_CAPACITY + 1, "OptEpoch: too many proofs for one node");
        uint256 real = _verifyAndCountAtNode(sub.seatRoot, proofs, level, branchId, true);
        require(real != claimedSeatCount, "OptEpoch: node seat count actually matches");

        _rejectEpoch(epoch, sub, msg.sender, "node seat count mismatch");
    }

    // ── Дані листка/proof (винесено в структури, щоб уникнути "stack too deep") ──

    struct LeafData {
        uint256 index;
        address account;
        bool hasSeat;
        int8 level;
        uint64 branchId;
    }

    struct LeafProof {
        LeafData leaf;
        bytes32[] proof;
    }

    function _requireValidLeaf(bytes32 root, LeafData calldata leaf, bytes32[] calldata proof) private pure {
        bytes32 h = SeatMerkleLib.leafHash(leaf.index, leaf.account, leaf.hasSeat, leaf.level, leaf.branchId);
        require(MerkleProof.verifyCalldata(proof, root, h), "OptEpoch: invalid merkle proof");
    }

    /// @dev Перевіряє КОЖЕН наданий (leaf,proof) проти кореня, і рахує,
    ///      скільки з них дійсно належать заявленому (level,branchId) із
    ///      hasSeat == requireSeated. Усі надані листки мають бути
    ///      валідними proof-ами — інакше revert (не можна підмішати
    ///      вигадані записи для інфляції підрахунку).
    function _verifyAndCountAtNode(
        bytes32 root,
        LeafProof[] calldata proofs,
        int8 level,
        uint64 branchId,
        bool requireSeated
    ) private pure returns (uint256 count) {
        for (uint256 i = 0; i < proofs.length; i++) {
            LeafData calldata leaf = proofs[i].leaf;
            bytes32 h = SeatMerkleLib.leafHash(leaf.index, leaf.account, leaf.hasSeat, leaf.level, leaf.branchId);
            require(MerkleProof.verifyCalldata(proofs[i].proof, root, h), "OptEpoch: invalid merkle proof in set");
            if (leaf.level == level && leaf.branchId == branchId && leaf.hasSeat == requireSeated) {
                count++;
            }
        }
    }

    // ── Внутрішні допоміжні ────────────────────────────────────────

    function _requireChallengeable(uint256 epoch) private view returns (Submission storage sub) {
        sub = submissions[epoch];
        require(sub.status == EpochStatus.Pending, "OptEpoch: not pending");
        require(block.timestamp <= sub.submittedAt + challengePeriod, "OptEpoch: challenge window closed");
    }

    function _takeChallengeBond() private {
        require(msg.value >= challengeBond, "OptEpoch: insufficient challenge bond");
        if (msg.value > challengeBond) {
            _safeSend(msg.sender, msg.value - challengeBond);
        }
    }

    function _rejectEpoch(uint256 epoch, Submission storage sub, address challenger, string memory reason) private {
        sub.status = EpochStatus.Rejected;
        uint256 proposerBond = sub.bond;
        sub.bond = 0;

        emit EpochChallenged(epoch, challenger, reason);
        emit EpochRejected(epoch, sub.proposer, challenger);

        _safeSend(challenger, proposerBond + challengeBond);
    }

    // ── Крок 3: фіналізація — легкий виклик submitSeatRoot() ────────

    function finalizeEpoch(uint256 epoch) external nonReentrant {
        Submission storage sub = submissions[epoch];
        require(sub.status == EpochStatus.Pending, "OptEpoch: not pending");
        require(block.timestamp > sub.submittedAt + challengePeriod, "OptEpoch: challenge window still open");

        sub.status = EpochStatus.Finalized;

        rankingEpoch.beginNewEpoch();
        rankingEpoch.submitSeatRoot(sub.seatRoot, sub.leafCount);

        NodeStatus[] storage nodes = _pendingNodeStatuses[epoch];
        uint256 nlen = nodes.length;
        int8[] memory nLevels = new int8[](nlen);
        uint64[] memory nBranches = new uint64[](nlen);
        uint32[] memory nCounts = new uint32[](nlen);
        bool[] memory nOverflow = new bool[](nlen);
        for (uint256 i = 0; i < nlen; i++) {
            nLevels[i] = nodes[i].level;
            nBranches[i] = nodes[i].branchId;
            nCounts[i] = nodes[i].seatCount;
            nOverflow[i] = nodes[i].overflowed;
        }
        rankingEpoch.submitNodeStatus(nLevels, nBranches, nCounts, nOverflow);
        delete _pendingNodeStatuses[epoch];

        _safeSend(sub.proposer, sub.bond);
        emit EpochFinalized(epoch, sub.seatRoot);

        currentEpoch++;
        currentEpochOpenedAt = block.timestamp;
    }

    /**
     * @notice Аварійний важіль, якщо ніхто не подав результат протягом
     *         epochStaleTimeout. ⚠️ Свідомо доступний і GUARDIAN_ROLE, не
     *         лише DAO_ROLE: якщо DAO_ROLE веде на DaoTimelock, а
     *         пропонувати в DaoGovernor може лише Council (якого може не
     *         існувати місяцями після запуску ДАО — бутстрап-дедлок
     *         "курка-яйце"), то без GUARDIAN_ROLE цей аварійний
     *         механізм був би недосяжний саме тоді, коли він єдино
     *         потрібен. Той самий принцип, що вже прийнятий у Treasury.
     */
    function forceOpenEpoch() external {
        require(hasRole(DAO_ROLE, msg.sender) || hasRole(GUARDIAN_ROLE, msg.sender), "OptEpoch: not authorized");
        require(
            submissions[currentEpoch].status == EpochStatus.None ||
            submissions[currentEpoch].status == EpochStatus.Rejected,
            "OptEpoch: submission exists, use normal flow"
        );
        require(block.timestamp > currentEpochOpenedAt + epochStaleTimeout, "OptEpoch: not stale yet");

        currentEpoch++;
        currentEpochOpenedAt = block.timestamp;
    }

    function _safeSend(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "OptEpoch: transfer failed");
    }

    // ── DAO governance: параметри ────────────────────────────────────

    function setParams(
        uint256 newRequiredBond,
        uint256 newChallengeBond,
        uint256 newChallengePeriod,
        uint256 newStaleTimeout
    ) external onlyRole(DAO_ROLE) {
        require(newChallengePeriod > 0, "OptEpoch: zero challenge period");
        requiredBond = newRequiredBond;
        challengeBond = newChallengeBond;
        challengePeriod = newChallengePeriod;
        epochStaleTimeout = newStaleTimeout;
        emit ParamsUpdated(newRequiredBond, newChallengeBond, newChallengePeriod, newStaleTimeout);
    }
}
