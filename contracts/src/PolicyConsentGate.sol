// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title PolicyConsentGate
 * @notice Гейт "згода з політикою" для контрактів HR DAO.
 *
 * Проблема: текст Політики прав людини (humanrightspolicy.dao) зберігається
 * на децентралізованому домені (Handshake/ENS → IPFS чи подібне) і МОЖЕ
 * змінюватись з часом. Потрібно:
 *   1) прив'язати згоду користувача не до URL (який завжди той самий), а до
 *      КОНКРЕТНОГО ЗМІСТУ документа на момент згоди (content-hash pinning);
 *   2) зберегти on-chain доказ (хто, яку версію, коли погодив) — для аудиту
 *      та юридичної/DAO-звітності;
 *   3) дозволити DAO оновлювати версію політики, не підмінюючи заднім числом
 *      те, з чим уже погодились існуючі учасники;
 *   4) не примушувати передеплой ShieldSBT щоразу, коли міняється текст.
 *
 * Рішення: on-chain зберігається лише keccak256-хеш канонічного тексту
 * політики (+ URI, де його забрати). Фронтенд забирає документ з
 * humanrightspolicy.dao, рахує keccak256 ЛОКАЛЬНО і звіряє з
 * currentPolicyHash — це захищає від підміни контенту на рівні домену чи
 * gateway (compromised DNS, IPFS gateway тощо), бо перевірка відбувається
 * незалежно від того, хто саме роздає файл користувачу.
 *
 * Згода фіксується EIP-712 підписом — гаманець (Metamask/Rabby/...) показує
 * користувачу структуровані дані, до яких він погоджується (не сліпий hex),
 * що дає:
 *   - криптографічний, неспростовний доказ згоди саме на цю версію і час;
 *   - "gasless"/1-tx flow: користувач підписує off-chain, а mint() сам
 *     подає підпис разом із транзакцією (не потрібна окрема approve-tx);
 *   - захист від replay через nonce + deadline.
 */
abstract contract PolicyConsentGate is AccessControl, EIP712 {
    using ECDSA for bytes32;

    /// @notice Роль, що керує версією політики. В ShieldSBT адміном цієї
    ///         ролі призначається DAO_ROLE (DaoTimelock).
    bytes32 public constant POLICY_ADMIN_ROLE = keccak256("POLICY_ADMIN_ROLE");

    // ── Поточна версія політики ────────────────────────────────

    /// @notice keccak256() канонічного (напр. UTF-8 NFC-нормалізованого)
    ///         тексту поточної редакції Політики прав людини.
    ///         Це джерело правди, НЕ policyURI.
    bytes32 public currentPolicyHash;

    /// @notice Де забрати сам текст: ipfs://CID, https://humanrightspolicy.dao/…
    ///         Довідкове поле для UI — контракт йому не довіряє напряму.
    string public policyURI;

    /// @notice Порядковий номер редакції (зручно для UI/аналітики/подій).
    uint256 public policyVersion;

    /// @notice Скільки часу наявні учасники мають на re-consent після
    ///         публікації нової редакції, перш ніж isCompliant() поверне
    ///         false. DAO-керований (POLICY_ADMIN_ROLE), дефолт — 30 днів.
    uint256 public reacceptGracePeriod = 30 days;

    /// @notice Дедлайн re-consent для кожної версії: version => timestamp,
    ///         після якого некомплаєнс-учасники втрачають isCompliant().
    ///         Фіксується один раз у момент публікації версії — заднім
    ///         числом його змінити не можна.
    mapping(uint256 => uint256) public policyDeadline;

    // ── Стан згоди користувачів ────────────────────────────────
    mapping(address => bytes32) public consentedPolicyHash;
    mapping(address => uint256) public consentedVersion;
    mapping(address => uint256) public consentedAt;
    mapping(address => uint256) public consentNonce;

    // ── EIP-712 typed data ─────────────────────────────────────
    // PolicyConsent(address account,bytes32 policyHash,uint256 nonce,uint256 deadline)
    bytes32 private constant POLICY_CONSENT_TYPEHASH = keccak256(
        "PolicyConsent(address account,bytes32 policyHash,uint256 nonce,uint256 deadline)"
    );

    event PolicyUpdated(uint256 indexed version, bytes32 indexed policyHash, string policyURI);
    event PolicyConsented(address indexed account, uint256 indexed version, bytes32 policyHash, uint256 timestamp);
    event ReacceptGracePeriodUpdated(uint256 newPeriod);

    constructor(bytes32 _initialPolicyHash, string memory _initialPolicyURI)
        EIP712("HR DAO Policy Consent", "1")
    {
        require(_initialPolicyHash != bytes32(0), "PolicyConsent: empty hash");
        currentPolicyHash = _initialPolicyHash;
        policyURI = _initialPolicyURI;
        policyVersion = 1;
        // Версія 1 діє з деплою — грейс-період їй не потрібен (немає "наявних
        // членів", які мали б re-consent до першого mint-у), але фіксуємо
        // дедлайн для консистентності мапи (isCompliant працює однаково для
        // всіх версій, включно з першою).
        policyDeadline[1] = block.timestamp;
        emit PolicyUpdated(1, _initialPolicyHash, _initialPolicyURI);
    }

    // ── DAO: публікація нової редакції ─────────────────────────

    /**
     * @notice Опублікувати нову редакцію політики. Контракт зберігає лише
     *         хеш+URI, ніколи не інтерпретує сам текст.
     * @dev Стара згода користувачів (consentedPolicyHash) НЕ стирається —
     *      вона лишається в mapping+подіях як історичний доказ "погодив
     *      версію N станом на T". Але hasAcceptedCurrentPolicy() одразу
     *      почне повертати false для всіх, поки вони не погодять нову
     *      версію (це впливає лише на майбутні дії, що вимагають гейта,
     *      не анулює вже видані Shield-токени заднім числом).
     */
    function setPolicy(bytes32 newHash, string calldata newURI)
        external
        onlyRole(POLICY_ADMIN_ROLE)
    {
        require(newHash != bytes32(0), "PolicyConsent: empty hash");
        require(newHash != currentPolicyHash, "PolicyConsent: same version");
        currentPolicyHash = newHash;
        policyURI = newURI;
        policyVersion++;
        policyDeadline[policyVersion] = block.timestamp + reacceptGracePeriod;
        emit PolicyUpdated(policyVersion, newHash, newURI);
    }

    /// @notice Змінити тривалість грейс-періоду для МАЙБУТНІХ оновлень
    ///         політики. Не впливає заднім числом на вже опубліковані версії
    ///         (policyDeadline для них уже зафіксовано).
    function setReacceptGracePeriod(uint256 newPeriod) external onlyRole(POLICY_ADMIN_ROLE) {
        require(newPeriod > 0, "PolicyConsent: zero grace period");
        reacceptGracePeriod = newPeriod;
        emit ReacceptGracePeriodUpdated(newPeriod);
    }

    // ── Згода: пряма (2-tx flow, msg.sender сам платить газ) ────

    /// @notice Явно погодити ПОТОЧНУ версію політики. `policyHash` передається
    ///         явно (а не читається з currentPolicyHash всередині), щоб
    ///         фронтенд і юзер точно бачили, з чим саме погоджуються, і щоб
    ///         tx ревертнула, якщо політику оновили між showModal() і submit().
    function acceptPolicy(bytes32 policyHash) external {
        _recordConsent(msg.sender, policyHash);
    }

    /**
     * @notice Re-consent (або початкова згода) через EIP-712 підпис, БЕЗ
     *         прив'язки до mint — головний шлях для НАЯВНИХ членів, коли
     *         DAO публікує нову редакцію політики. `account` підписує
     *         типізоване повідомлення у власному гаманці (безкоштовно),
     *         а відправити транзакцію може будь-хто — сам `account`, DAO-
     *         relayer, чи навіть інший учасник спільноти, що хоче
     *         компенсувати газ комусь. Підпис верифікується на account,
     *         тож підставити чужу згоду неможливо.
     */
    function acceptPolicyFor(
        address account,
        bytes32 policyHash,
        uint256 deadline,
        bytes calldata signature
    ) external {
        _consentBySignature(account, policyHash, deadline, signature);
    }

    // ── Згода: через EIP-712 підпис (1-tx flow разом з mint) ────

    /**
     * @dev Дозволяє зафіксувати згоду за підписом у тій самій транзакції,
     *      що й цільова дія (наприклад, mint Shield) — без окремої tx.
     *      Підпис перевіряється проти EIP-712 domain separator цього
     *      контракту, тож його не можна перевикористати на іншому
     *      контракті чи мережі.
     */
    function _consentBySignature(
        address account,
        bytes32 policyHash,
        uint256 deadline,
        bytes calldata signature
    ) internal {
        require(block.timestamp <= deadline, "PolicyConsent: signature expired");

        uint256 nonce = consentNonce[account];
        bytes32 structHash = keccak256(
            abi.encode(POLICY_CONSENT_TYPEHASH, account, policyHash, nonce, deadline)
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = digest.recover(signature);
        require(signer == account, "PolicyConsent: bad signature");

        consentNonce[account] = nonce + 1;
        _recordConsent(account, policyHash);
    }

    function _recordConsent(address account, bytes32 policyHash) private {
        require(policyHash == currentPolicyHash, "PolicyConsent: stale policy version");
        consentedPolicyHash[account] = policyHash;
        consentedVersion[account]    = policyVersion;
        consentedAt[account]         = block.timestamp;
        emit PolicyConsented(account, policyVersion, policyHash, block.timestamp);
    }

    // ── Читання ─────────────────────────────────────────────────

    function hasAcceptedCurrentPolicy(address account) public view returns (bool) {
        return consentedPolicyHash[account] == currentPolicyHash;
    }

    /**
     * @notice Чи "в комплаєнсі" адреса щодо ПОТОЧНОЇ версії політики — з
     *         урахуванням грейс-періоду. На відміну від
     *         hasAcceptedCurrentPolicy(), тут ще є час на роздуми:
     *         - true, якщо вже погодив поточну версію;
     *         - true, якщо погодив стару версію, АЛЕ дедлайн re-consent
     *           для поточної версії ще не настав (щойно опублікували);
     *         - false, якщо дедлайн минув, а нову версію не погодили.
     *         Саме ЦЮ функцію мають викликати модулі, що гейтують участь
     *         (голосування, пропозиції санкцій тощо), а не
     *         hasAcceptedCurrentPolicy() напряму — інакше миттєво після
     *         кожного setPolicy() усі учасники "випадали" б без попередження.
     */
    function isCompliant(address account) public view returns (bool) {
        if (consentedPolicyHash[account] == currentPolicyHash) return true;
        return block.timestamp <= policyDeadline[policyVersion];
    }

    /// @notice Скільки часу лишилось до дедлайну re-consent поточної версії
    ///         (0, якщо вже минув або вже погоджено). Зручно для UI/нотифікацій.
    function reconsentTimeLeft(address account) external view returns (uint256) {
        if (consentedPolicyHash[account] == currentPolicyHash) return 0;
        uint256 deadline = policyDeadline[policyVersion];
        if (block.timestamp >= deadline) return 0;
        return deadline - block.timestamp;
    }
}
