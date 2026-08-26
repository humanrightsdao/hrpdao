// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import "./InfluenceRegistry.sol";
import "./ShieldSBT.sol";
import "./HumanityGate.sol";

/**
 * @title CouncilSBT
 * @notice Soulbound Token (ERC-5192) статусу «Консул» — найвищого рівня
 *         участі в HR DAO. Так само, як і статус Захисника (ShieldSBT),
 *         це СТАТУС учасника, не членство в окремій палаті/будівлі.
 *
 * Умови mint (Influence + термін у статусі Захисника + humanity) відповідають
 * узгодженим параметрам: 2 роки стандарт / 6 міс. пільговий період на
 * 1-му році проєкту / 1 рік на 2-му — через ShieldSBT.
 * requiredCouncilDuration() (180д/365д/730д — YEAR1_GRACE_DURATION/
 * YEAR2_GRACE_DURATION/STANDARD_DURATION).
 *
 * CouncilSBT — найвищий рівень статусу в проєкті; окремого, вищого рівня
 * немає.
 *
 * ⚠️ ДЕПЛОЙ: після деплою humanityGate.setAuthorizedCaller(address(councilSBT), true)
 * обов'язковий. Той самий HumanityGate.address МАЄ бути переданий сюди і в ShieldSBT.
 */
contract CouncilSBT is ERC721, AccessControl {
    using Checkpoints for Checkpoints.Trace208;

    /// @notice Історія totalSupply у часі — той самий механізм, що в ShieldSBT
    ///         (снапшот-кворум DaoGovernor).
    Checkpoints.Trace208 private _totalSupplyCheckpoints;

    /// @notice Той самий механізм активної явки, що й у ShieldSBT (див.
    ///         детальний коментар там) — для Council veto-кворуму
    ///         (DisciplineModule.vetoSanction).
    Checkpoints.Trace208 private _activeSupplyCheckpoints;
    mapping(address => bool) private _countedActive;
    uint256 public inactivityWindow = 180 days;

    // ── ERC-5192 інтерфейс ──────────────────────────────────────
    event Locked(uint256 tokenId);
    bytes4 private constant _INTERFACE_ID_ERC5192 = 0xb45a3c0e;

    // ── Ролі ────────────────────────────────────────────────────
    bytes32 public constant DISCIPLINE_ROLE = keccak256("DISCIPLINE_ROLE");

    /// @notice DaoTimelock (виконавчий Timelock ДАО) — керує DISCIPLINE_ROLE,
    ///         сам собі адмін.
    bytes32 public constant DAO_ROLE = keccak256("DAO_ROLE");

    // ── Конфігурація ─────────────────────────────────────────────
    InfluenceRegistry public immutable influenceRegistry;
    ShieldSBT      public immutable shieldSBT;

    /// @notice Той самий контракт, що й у ShieldSBT.humanityGate —
    ///         ОБОВ'ЯЗКОВО передавати ідентичну адресу при деплої.
    HumanityGate public immutable humanityGate;

    uint256 public constant INFLUENCE_THRESHOLD = 500; // було 1000 — розрив 200(Shield)→1000(Council) визнано завеликим, звужено до 500

    /// @notice Мінімальний score (×100, тобто 4000 = score 40.00) для
    ///         mint Council. ВИЩИЙ за ShieldSBT.minHumanityScore.
    ///         Провайдер-агностичний. DAO-керований.
    uint256 public minHumanityScore;

    // ── Стан ────────────────────────────────────────────────────
    uint256 private _tokenIdCounter;
    uint256 private _totalSupply;
    uint256 private _activeSupply;

    mapping(address => uint256) public accountToTokenId;
    mapping(address => uint256) public memberSince;

    // ── Події ───────────────────────────────────────────────────
    event CouncilMinted(address indexed account, uint256 tokenId);
    event Slashed(address indexed account, uint256 tokenId, bytes32 violationPostRef);
    event MinHumanityScoreUpdated(uint256 newMinScore);
    event ActivityStatusSynced(address indexed account, bool isActive, uint256 newActiveSupply);
    event InactivityWindowUpdated(uint256 newWindow);

    // ── Конструктор ─────────────────────────────────────────────
    /**
     * @param _influenceRegistry    Адреса InfluenceRegistry
     * @param _shieldSBT          Адреса ShieldSBT
     * @param dao                 DaoTimelock (DAO_ROLE)
     * @param _humanityGate       Адреса HumanityGate — МАЄ БУТИ ТА САМА
     *                            адреса, що передана в конструктор ShieldSBT
     * @param _minHumanityScore   Мінімальний score (×100), ВИЩИЙ за
     *                            ShieldSBT.minHumanityScore
     */
    constructor(
        address _influenceRegistry,
        address _shieldSBT,
        address dao,
        address _humanityGate,
        uint256 _minHumanityScore
    )
        ERC721("HR DAO Council", "COUNCIL")
    {
        require(_humanityGate != address(0), "Council: zero humanityGate");

        influenceRegistry    = InfluenceRegistry(_influenceRegistry);
        shieldSBT         = ShieldSBT(_shieldSBT);
        humanityGate       = HumanityGate(_humanityGate);
        minHumanityScore   = _minHumanityScore;

        _setRoleAdmin(DAO_ROLE, DAO_ROLE);
        _grantRole(DAO_ROLE, dao);
        if (msg.sender != dao) {
            _grantRole(DAO_ROLE, msg.sender); // тимчасово, для генезис-вайрингу
        }
    }

    // ── Mint ────────────────────────────────────────────────────

    /**
     * @notice Отримати COUNCIL SBT.
     * Умови: 500+ Influence + достатній термін членства в Shield (залежно
     * від пільгового періоду, визначеного ShieldSBT) + HumanityGate.
     * verifyHuman() проходить за ВИЩИМ порогом, ніж у Shield.
     */
    function mint() external {
        require(accountToTokenId[msg.sender] == 0, "Council: already member");
        require(
            influenceRegistry.currentInfluence(msg.sender) >= INFLUENCE_THRESHOLD,
            "Council: need 500+ Influence"
        );
        require(shieldSBT.isMember(msg.sender), "Council: Shield must be active");

        uint256 shieldSince = shieldSBT.memberSince(msg.sender);
        uint256 required    = shieldSBT.requiredCouncilDuration(msg.sender);
        require(
            block.timestamp - shieldSince >= required,
            "Council: membership duration not met"
        );

        humanityGate.verifyHuman(msg.sender, minHumanityScore);

        _tokenIdCounter++;
        _totalSupply++;
        _activeSupply++;
        uint256 tid = _tokenIdCounter;

        accountToTokenId[msg.sender] = tid;
        memberSince[msg.sender]      = block.timestamp;
        _countedActive[msg.sender]   = true;
        _mint(msg.sender, tid);
        _totalSupplyCheckpoints.push(uint48(block.timestamp), uint208(_totalSupply));
        _activeSupplyCheckpoints.push(uint48(block.timestamp), uint208(_activeSupply));

        emit Locked(tid);
        emit CouncilMinted(msg.sender, tid);
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
            "Council: soulbound, non-transferable"
        );
        return super._update(to, tokenId, auth);
    }

    // ── Дисципліна (виклик лише з DisciplineModule) ─────────────

    function burnByDiscipline(address account, bytes32 violationPostRef)
        external
        onlyRole(DISCIPLINE_ROLE)
    {
        uint256 tid = accountToTokenId[account];
        require(tid != 0, "Council: not a member");

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

    /// @notice Призначити DisciplineModule. Лише через DAO governance.
    function setDisciplineModule(address module, bool enabled) external onlyRole(DAO_ROLE) {
        require(module != address(0), "Council: zero address");
        if (enabled) _grantRole(DISCIPLINE_ROLE, module);
        else _revokeRole(DISCIPLINE_ROLE, module);
    }

    // ── DAO governance: гуманіті-поріг ───────────────────────────

    /// @notice Оновити мінімальний score для mint Council (провайдер-
    ///         агностичний). Викликається тільки через DaoGovernor →
    ///         DaoTimelock (DAO_ROLE). Список провайдерів і режим
    ///         агрегації змінюються ОКРЕМО, через governor самого humanityGate.
    function setMinHumanityScore(uint256 newMinScore) external onlyRole(DAO_ROLE) {
        minHumanityScore = newMinScore;
        emit MinHumanityScoreUpdated(newMinScore);
    }

    /// @notice Той самий механізм, що ShieldSBT.setInactivityWindow() — див. коментар там.
    function setInactivityWindow(uint256 newWindow) external onlyRole(DAO_ROLE) {
        require(newWindow > 0, "Council: zero window");
        inactivityWindow = newWindow;
        emit InactivityWindowUpdated(newWindow);
    }

    /// @notice Той самий механізм, що ShieldSBT.syncActivityStatus() — див. детальний коментар там.
    function syncActivityStatus(address account) external {
        require(accountToTokenId[account] != 0, "Council: not a member");

        uint256 lastActivity = influenceRegistry.lastActivityTimestamp(account);
        bool isActive = lastActivity != 0 && (block.timestamp - lastActivity) <= inactivityWindow;
        bool wasCounted = _countedActive[account];

        if (isActive == wasCounted) return;

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

    function totalSupply() external view returns (uint256) { return _totalSupply; }

    /// @notice Скільки Council-власників ЗАРАЗ враховані як активні.
    function activeSupply() external view returns (uint256) { return _activeSupply; }

    /// @notice activeSupply станом на минулий момент часу — те, що
    ///         DisciplineModule.vetoSanction() ФАКТИЧНО використовує як
    ///         знаменник (councilSupplySnapshot), замість totalSupply().
    function getPastActiveSupply(uint256 timepoint) external view returns (uint256) {
        require(timepoint < block.timestamp, "Council: future lookup");
        return _activeSupplyCheckpoints.upperLookupRecent(uint48(timepoint));
    }

    /// @notice totalSupply станом на минулий момент часу — див. пояснення
    ///         в ShieldSBT.getPastTotalSupply().
    function getPastTotalSupply(uint256 timepoint) external view returns (uint256) {
        require(timepoint < block.timestamp, "Council: future lookup");
        return _totalSupplyCheckpoints.upperLookupRecent(uint48(timepoint));
    }

    function isCouncilMember(address account) external view returns (bool) {
        return accountToTokenId[account] != 0;
    }

    /// @notice Найвищий поточний score юзера (×100) серед усіх активних
    ///         провайдерів humanityGate, для UI.
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
