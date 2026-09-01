// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "./MigrationSnapshotLib.sol";
import "../ShieldSBT.sol";
import "../CouncilSBT.sol";
import "../InfluenceRegistry.sol";

/**
 * @title MigrationClaim
 * @notice Деплоїться на ЦІЛЬОВОМУ чейні (куди мігруємо), РАЗОМ з рештою
 *         звичайного стеку — Deploy.s.sol, БЕЗ ЖОДНИХ ЗМІН, бо
 *         ShieldSBT/CouncilSBT/InfluenceRegistry ВЖЕ мають вбудовані
 *         (і за замовчуванням DORMANT, нікому не видані) MIGRATION_ROLE-
 *         хуки з дня генезису — окремого "vNext"-форку більше не потрібно
 *         (рішення: готовність до міграції — частина базового v1-
 *         функціоналу, а не надбудова на майбутнє).
 *
 * Принцип: PERMISSIONLESS SELF-SERVE CLAIM, не bulk-адмін-мінт. Той самий
 * урок, що вже задокументований у CouncilRankingEpoch/SeatMerkleLib цього
 * проєкту — цикл "адмін у циклі мінтить N акаунтів" масштабується
 * лінійно по газу й одного дня впирається в block gas limit. Замість
 * цього: корінь зберігається ОДИН РАЗ (O(1) сторедж), кожен користувач
 * сам платить газ за свій ОДИН claim() з Merkle-proof — точно так само,
 * як airdrop-паттерн, і так само, як verifySeatLeaf() у CouncilRankingEpoch.
 *
 * Довіра до кореня: `snapshotRoot` копіюється (руками/скриптом деплою,
 * не онлайн-читанням — контракт на чейні B фізично не може прочитати
 * стан чейну A) з ФІНАЛІЗОВАНОГО MigrationRootRegistry.snapshotRoot на
 * вихідному чейні, ПІСЛЯ community-вікна перевірки snapshotURI. Тому
 * будь-хто може незалежно звірити, що `snapshotRoot` тут ідентичний
 * `MigrationRootRegistry(sourceRegistry, sourceChainId).snapshotRoot`
 * (адреса+чейн зберігаються тут лише для АУДИТУ/референсу, не як жива
 * залежність).
 */
contract MigrationClaim is AccessControl {
    bytes32 public constant DAO_ROLE = keccak256("DAO_ROLE");

    /// @notice Корінь Merkle-дерева снепшоту (копія фіналізованого
    ///         MigrationRootRegistry.snapshotRoot з вихідного чейну).
    bytes32 public immutable snapshotRoot;

    /// @notice Референс на вихідний MigrationRootRegistry — ЛИШЕ для
    ///         аудиту/прозорості (адреса на ІНШОМУ чейні, сюди фізично
    ///         не викликається).
    address public immutable sourceRegistry;
    uint256 public immutable sourceChainId;

    /// @notice Час, після якого claim() більше не працює. DAO ОБОВ'ЯЗКОВО
    ///         відкликає MIGRATION_ROLE у ShieldSBT/CouncilSBT/
    ///         InfluenceRegistry невдовзі після цього моменту (див.
    ///         CROSS_CHAIN_MIGRATION_DESIGN.md, "Закриття вікна") —
    ///         claimDeadline сам по собі НЕ відкликає роль, це лише
    ///         зупиняє ЦЕЙ контракт від подальших спроб виклику.
    uint256 public immutable claimDeadline;

    ShieldSBT           public immutable shieldSBT;
    CouncilSBT           public immutable councilSBT;
    InfluenceRegistry   public immutable influenceRegistry;

    /// @notice Захист від повторного claim того самого акаунта.
    mapping(address => bool) public claimed;

    event Claimed(
        address indexed account,
        uint256 influence,
        bool    hasShield,
        bool    hasCouncil,
        uint256 index
    );

    constructor(
        bytes32 _snapshotRoot,
        address _sourceRegistry,
        uint256 _sourceChainId,
        uint256 _claimDeadline,
        address _shieldSBT,
        address _councilSBT,
        address _influenceRegistry,
        address dao
    ) {
        require(_snapshotRoot != bytes32(0), "Migration: zero root");
        require(_claimDeadline > block.timestamp, "Migration: deadline in past");
        require(
            _shieldSBT != address(0) && _councilSBT != address(0) && _influenceRegistry != address(0),
            "Migration: zero target contract"
        );

        snapshotRoot      = _snapshotRoot;
        sourceRegistry    = _sourceRegistry;
        sourceChainId      = _sourceChainId;
        claimDeadline      = _claimDeadline;
        shieldSBT          = ShieldSBT(_shieldSBT);
        councilSBT          = CouncilSBT(_councilSBT);
        influenceRegistry  = InfluenceRegistry(_influenceRegistry);

        _setRoleAdmin(DAO_ROLE, DAO_ROLE);
        _grantRole(DAO_ROLE, dao);
        if (msg.sender != dao) {
            _grantRole(DAO_ROLE, msg.sender); // тимчасово, для генезис-вайрингу
        }
    }

    /**
     * @notice Claim власних мігрованих даних. ЛИШЕ msg.sender сам за себе —
     *         навмисно немає варіанту "claim за когось іншого", щоб
     *         виключити фронтранінг/спам чужих claim-ів (а не тому, що це
     *         щось захищає: дані публічні в snapshotURI, важлива лише
     *         відсутність можливості когось "заблокувати" повторним
     *         claimed[account]=true від третьої особи).
     * @param index                   Той самий index, що в оригінальному
     *                                 листку (MigrationSnapshotLib.leafHash).
     * @param influence                Influence-баланс зі снепшоту.
     * @param lastActivityTimestamp    Час останньої активності зі снепшоту.
     * @param hasShield                Чи мав ShieldSBT на момент снепшоту.
     * @param shieldMintedAt           Оригінальний час мінту (0, якщо !hasShield).
     * @param hasCouncil                Чи мав CouncilSBT на момент снепшоту.
     * @param councilMintedAt          Оригінальний час мінту (0, якщо !hasCouncil).
     * @param humanityScore             Останній відомий humanity-скор (аудит-трейл,
     *                                   контрактом самим по собі НЕ використовується —
     *                                   нові mint-виклики тут пропускають live-перевірку
     *                                   HumanityGate свідомо, див. NatSpec migrationMint).
     * @param policyConsentVersion      Версія Політики прав людини, з якою
     *                                   погодився акаунт на вихідному чейні
     *                                   (аудит-трейл; ПОВТОРНА згода з
     *                                   ПОТОЧНОЮ версією політики на новому
     *                                   чейні все одно вимагається окремо,
     *                                   якщо акаунт захоче в майбутньому
     *                                   викликати щось, що читає
     *                                   hasAcceptedCurrentPolicy — той
     *                                   гейт цей контракт НЕ обходить).
     * @param proof                     Merkle-proof листка проти snapshotRoot.
     */
    function claim(
        uint256 index,
        uint256 influence,
        uint256 lastActivityTimestamp,
        bool    hasShield,
        uint256 shieldMintedAt,
        bool    hasCouncil,
        uint256 councilMintedAt,
        uint256 humanityScore,
        bytes32 policyConsentVersion,
        bytes32[] calldata proof
    ) external {
        require(block.timestamp <= claimDeadline, "Migration: window closed");
        require(!claimed[msg.sender], "Migration: already claimed");

        bytes32 leaf = MigrationSnapshotLib.leafHash(
            index,
            msg.sender,
            influence,
            lastActivityTimestamp,
            hasShield,
            shieldMintedAt,
            hasCouncil,
            councilMintedAt,
            humanityScore,
            policyConsentVersion
        );
        require(MerkleProof.verifyCalldata(proof, snapshotRoot, leaf), "Migration: invalid proof");

        claimed[msg.sender] = true;

        if (influence > 0 || lastActivityTimestamp > 0) {
            influenceRegistry.migrationSetInfluence(msg.sender, influence, lastActivityTimestamp);
        }
        if (hasShield) {
            shieldSBT.migrationMint(msg.sender, shieldMintedAt);
        }
        if (hasCouncil) {
            // Council вимагає активний Shield (isMember()) — тому hasShield
            // ОБОВ'ЯЗКОВО має бути true в тому самому листку, інакше листок
            // сам по собі був некоректно побудований офчейн-скриптом
            // (це перевіряється ще на етапі побудови дерева, до публікації
            // кореня — див. CROSS_CHAIN_MIGRATION_DESIGN.md).
            councilSBT.migrationMint(msg.sender, councilMintedAt);
        }

        emit Claimed(msg.sender, influence, hasShield, hasCouncil, index);
    }

    /// @notice Немає окремої "closeEarly()" — щоб зупинити прийом нових
    ///         claim() достроково (напр. знайдено помилку в снепшоті),
    ///         DAO викликає setMigrationClaim(address(this), false) на
    ///         ShieldSBT/CouncilSBT/InfluenceRegistry напряму (той самий
    ///         механізм, що й планове закриття вікна після claimDeadline —
    ///         див. CROSS_CHAIN_MIGRATION_DESIGN.md). Це діє МИТТЄВО й не
    ///         потребує додаткового стану в цьому контракті.
}
