// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title MigrationRootRegistry
 * @notice Деплоїться на ВИХІДНОМУ чейні (тому, звідки мігруємо), ОКРЕМО
 *         від v1-контрактів (ShieldSBT/CouncilSBT/InfluenceRegistry/
 *         Treasury тощо) — жодного впливу на їхню роботу, жодних змін у
 *         них не потрібно. Єдина мета: дати ОДНЕ канонічне, ончейн-
 *         перевірюване місце, де DAO публікує корінь Merkle-дерева
 *         фінального снепшоту користувацьких даних перед міграцією.
 *
 * Чому це окремий контракт, а не просто пост у Discord/статичний файл:
 *   1. `publishedAt`/`sourceChainId` дають незалежним спостерігачам
 *      (audit, DAO-учасникам) ончейн-доказ МОМЕНТУ фіксації снепшоту —
 *      можна звірити з block explorer, що жодних змін балансів після
 *      цього моменту в розрахунок кореня не потрапило.
 *   2. Корінь публікується ЛИШЕ через DAO_ROLE цього контракту (видану
 *      DaoTimelock — той самий принцип самокерованих ролей, що й у решті
 *      проєкту) — тобто публікація снепшоту проходить через ЗВИЧАЙНИЙ
 *      propose→vote→queue→execute цикл DaoGovernor, а не одноосібне
 *      рішення деплоєра/multisig.
 *   3. `finalize()` робить корінь незмінним НАЗАВЖДИ (навіть DAO не може
 *      підмінити його заднім числом) — критично, бо MigrationClaim на
 *      цільовому чейні довіряє САМЕ цьому кореню.
 *
 * Офчейн-частина (побудова дерева з реальних балансів InfluenceRegistry/
 * ShieldSBT/CouncilSBT/HumanityGate/PolicyConsentGate) виконується
 * скриптом (див. script/migration/ExportMigrationSnapshot.s.sol) за
 * формулою MigrationSnapshotLib.leafHash — публікується разом з коренем
 * (IPFS/арвів CID у `snapshotURI`) для незалежної перевірки будь-ким
 * ДО голосування за publishRoot().
 */
contract MigrationRootRegistry is AccessControl {
    bytes32 public constant DAO_ROLE = keccak256("DAO_ROLE");

    /// @notice Корінь Merkle-дерева снепшоту. bytes32(0) = ще не опубліковано.
    bytes32 public snapshotRoot;

    /// @notice Кількість листків у дереві (для звірки повноти офчейн-скриптом
    ///         проти InfluenceRegistry/ShieldSBT.totalSupply() на момент снепшоту).
    uint256 public leafCount;

    /// @notice CID/URI повних даних снепшоту (IPFS/Arweave) — щоб будь-хто
    ///         міг перебудувати дерево локально й звірити з snapshotRoot
    ///         ДО того, як довіряти MigrationClaim на новому чейні.
    string public snapshotURI;

    /// @notice Ідентифікатор чейну, ДЛЯ якого готується ця міграція
    ///         (напр. новий chain id) — щоб один і той самий снепшот не
    ///         міг бути помилково/зловмисно "переграний" на іншому чейні,
    ///         якщо міграцій буде декілька.
    uint256 public targetChainId;

    uint256 public publishedAt;
    bool    public finalized;

    event RootPublished(bytes32 indexed root, uint256 leafCount, string snapshotURI, uint256 targetChainId, uint256 timestamp);
    event RootFinalized(bytes32 indexed root, uint256 timestamp);

    /// @param dao DaoTimelock — єдиний власник DAO_ROLE (той самий принцип
    ///            самокерованих ролей, що й у решті проєкту).
    constructor(address dao) {
        require(dao != address(0), "MigrationRootRegistry: zero dao");
        _setRoleAdmin(DAO_ROLE, DAO_ROLE);
        _grantRole(DAO_ROLE, dao);
        if (msg.sender != dao) {
            _grantRole(DAO_ROLE, msg.sender); // тимчасово, для генезис-вайрингу цього контракту
        }
    }

    /**
     * @notice Опублікувати/оновити корінь снепшоту. Можна викликати кілька
     *         разів ДО finalize() (напр. якщо в даних знайдено помилку до
     *         фактичного запуску міграції) — кожен виклик перезаписує
     *         попередній корінь і емітить нову подію для прозорості.
     */
    function publishRoot(bytes32 root, uint256 _leafCount, string calldata _snapshotURI, uint256 _targetChainId)
        external
        onlyRole(DAO_ROLE)
    {
        require(!finalized, "MigrationRootRegistry: already finalized");
        require(root != bytes32(0), "MigrationRootRegistry: zero root");
        require(_leafCount > 0, "MigrationRootRegistry: zero leaf count");

        snapshotRoot   = root;
        leafCount      = _leafCount;
        snapshotURI    = _snapshotURI;
        targetChainId  = _targetChainId;
        publishedAt    = block.timestamp;

        emit RootPublished(root, _leafCount, _snapshotURI, _targetChainId, block.timestamp);
    }

    /**
     * @notice Заблокувати корінь НАЗАВЖДИ. Викликати лише після того, як
     *         community мала реальний час (рекомендовано: не менше терміну
     *         одного governance-циклу DaoGovernor) незалежно перевірити
     *         snapshotURI проти публічної on-chain історії InfluenceRegistry/
     *         ShieldSBT/CouncilSBT. Після finalize() MigrationClaim на
     *         цільовому чейні можна безпечно вказувати на цей корінь.
     */
    function finalize() external onlyRole(DAO_ROLE) {
        require(snapshotRoot != bytes32(0), "MigrationRootRegistry: no root published");
        require(!finalized, "MigrationRootRegistry: already finalized");
        finalized = true;
        emit RootFinalized(snapshotRoot, block.timestamp);
    }
}
