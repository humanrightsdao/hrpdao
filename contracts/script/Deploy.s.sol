// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/DaoTimelock.sol";
import "../src/HumanityGate.sol";
import "../src/PassportAdapter.sol";
import "../src/MockHumanityProvider.sol";
import "../src/LocationRegistry.sol";
import "../src/HexAncestryVerifier.sol";
import "../src/MockHexAncestryVerifier.sol";
import "../src/InfluenceRegistry.sol";
import "../src/ShieldSBT.sol";
import "../src/CouncilSBT.sol";
import "../src/CouncilRankingEpoch.sol";
import "../src/Treasury.sol";
import "../src/DisciplineModule.sol";
import "../src/TipJar.sol";
import "../src/DaoGovernor.sol";
import "../src/MockERC20.sol";

/**
 * @title Deploy
 * @notice Foundry-скрипт деплою HR DAO (Підхід Б — див. розділ 14
 *         Tokenomics: forge script виконує кожен `new X(...)` як ОКРЕМУ
 *         транзакцію, тому ліміт EIP-3860 на init code рахується для
 *         кожного контракту незалежно й жодного розбиття на on-chain-стадії
 *         не потрібно — це єдиний деплой-шлях у проєкті. Історичний
 *         5-стадійний on-chain деплоєр GenesisDeployerStage1-5.sol існував
 *         як workaround під обмеження Lens Testnet і видалений при міграції
 *         на Arbitrum разом з рештою Lens-специфічних конфігів).
 *
 * НОВИЙ скрипт під поточну (Shield/Council, без Senate/коду країни)
 * архітектуру — попереднього Deploy_testnet_s.sol серед вхідних файлів
 * НЕ було (він посилався на найстарішу, до-гео-реформену версію), тому
 * написаний з нуля за реальними конструкторами контрактів у цьому репо.
 *
 * Компроміс, як і в оригінальному підході: деплоєр (msg.sender/broadcaster)
 * тимчасово тримає DAO_ROLE/governor на кількох контрактах між кроками
 * ЦЬОГО скрипту (коротке вікно в межах одного forge script run), доки
 * _finalizeRoles() наприкінці все не прибере. Кожен контракт, що потребує
 * подальшого генезис-вайрингу, вже сам підтримує це у власному
 * конструкторі — грант і на `dao` (фінальний адресат), і, якщо відрізняється,
 * тимчасово на msg.sender (див. ShieldSBT/CouncilSBT/InfluenceRegistry/
 * LocationRegistry/CouncilRankingEpoch) — тому deploy.dao передається
 * ОДРАЗУ як адреса DaoTimelock, без окремих "expectedStageN"-передбачень
 * за nonce, які були потрібні лише on-chain стадійному деплою.
 *
 * ⚠️ ПЕРЕД ЗАПУСКОМ:
 *   - forge install foundry-rs/forge-std (пришпилено v1.16.2, див. foundry.lock)
 *   - forge install OpenZeppelin/openzeppelin-contracts --no-commit
 *     (пришпилено v5.7.0 — стандартний EVM/Cancun, сумісний з Arbitrum;
 *     див. foundry.lock/foundry.toml)
 *   - Змінні середовища: PRIVATE_KEY, і за потреби TESTNET=true для
 *     прискорених термінів/testMode (див. DeployConfig нижче).
 *   - Для Arbitrum: PASSPORT_DECODER — адреса Human Passport Decoder на
 *     Arbitrum One (mainnet); на Arbitrum Sepolia, якщо офіційного деплою
 *     Decoder ще немає, лишити address(0)/testMode із MockHumanityProvider.
 *   - GUARDIAN_MULTISIG — Safe (чи інший мультисиг), розгорнутий САМЕ на
 *     цільовій мережі Arbitrum; адреса з Lens НЕ переноситься автоматично.
 *   - USDC_ADDRESS / USDT_ADDRESS / DAI_ADDRESS (Гео-реформа v6) — реальні
 *     адреси стейблкоїнів на цільовій мережі, реєструються в TipJar ЗА
 *     ЗАМОВЧУВАННЯМ як TokenKind.STABLE. address(0)/не задано — пропустити.
 *     Не-доларові валюти (ORACLE-вид) сюди НЕ передаються — додаються
 *     ОКРЕМИМ голосуванням ДАО вже після деплою (TipJar.setOraclePricedToken()).
 *
 * Запуск (Arbitrum Sepolia — testnet, chain id 421614):
 *   forge script script/Deploy.s.sol:Deploy --rpc-url arbitrum_sepolia --broadcast --verify -vvvv
 *
 * Запуск (Arbitrum One — mainnet, chain id 42161):
 *   forge script script/Deploy.s.sol:Deploy --rpc-url arbitrum_one --broadcast --verify -vvvv
 *
 * Запуск (інша стандартна EVM-мережа, напр. Ethereum Sepolia):
 *   forge script script/Deploy.s.sol:Deploy --rpc-url sepolia --broadcast --verify -vvvv
 */
contract Deploy is Script {
    // ── Результати деплою (публічні, для читання з тестів/інших скриптів) ──
    DaoTimelock          public daoTimelock;
    HumanityGate         public humanityGate;
    PassportAdapter      public passportAdapter;
    MockHumanityProvider public mockHumanityProvider; // лише testMode
    LocationRegistry     public locationRegistry;
    InfluenceRegistry       public influenceRegistry;
    ShieldSBT             public shieldSBT;
    CouncilSBT           public councilSBT;
    CouncilRankingEpoch  public rankingEpoch;
    Treasury             public treasury;
    DisciplineModule     public discipline;
    TipJar                public tipJar;
    DaoGovernor          public daoGovernor;
    MockERC20            public mockToken; // лише testMode

    /// @notice Усі параметри деплою в одному місці — щоб testnet/mainnet
    ///         відрізнялись ЛИШЕ значеннями тут, а не окремими гілками коду.
    struct DeployConfig {
        bool    testMode;
        uint256 timelockMinDelay;      // mainnet: 72+ год; testnet: 60–300с
        uint256 shieldMinHumanityScore;
        uint256 councilMinHumanityScore;
        uint256 shieldGraceDuration;   // testMode: секунди; інакше ігнорується
        uint256 rollingWindow;         // mainnet: 30 днів; testnet: хвилини
        uint256 recipientCooldown;     // mainnet: 14 днів; testnet: секунди/0
        uint48  votingDelay;
        uint32  votingPeriod;
        address passportDecoder;       // Human Passport Decoder (mainnet); mock на testnet — можна address(0)
        // Гео-реформа v6: адреси найпопулярніших USD-стейблкоїнів на
        // цільовій мережі — реєструються в TipJar ЗА ЗАМОВЧУВАННЯМ як
        // TokenKind.STABLE (ручний курс, без оракула). address(0) =
        // пропустити (напр. якщо на конкретній тестовій мережі якогось
        // з них ще немає). Не-доларові валюти (ORACLE-вид, Chainlink-
        // сумісний фід) сюди НЕ додаються — це окреме голосування ДАО
        // вже ПІСЛЯ деплою, через TipJar.setOraclePricedToken().
        address usdcAddress;
        address usdtAddress;
        address daiAddress;
    }

    function run() external {
        DeployConfig memory cfg = _loadConfig();

        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        _deployCore(cfg, deployer);
        _deploySBTs(cfg, deployer);
        _deployGeoAndTreasury(cfg, deployer);
        _deployGovernanceLayer(cfg, deployer);
        _finalizeRoles(deployer);

        vm.stopBroadcast();

        _logSummary();
    }

    // ── Крок 1: Timelock + людяність + локація ──────────────────────
    function _deployCore(DeployConfig memory cfg, address deployer) internal {
        address[] memory noProposers = new address[](0);
        address[] memory anyExecutor = new address[](1);
        anyExecutor[0] = address(0);
        address[] memory guardians = _guardians(deployer, cfg.testMode);

        // admin = deployer тимчасово — потрібен, щоб пізніше видати
        // PROPOSER_ROLE/CANCELLER_ROLE DaoGovernor-у (Крок 4).
        daoTimelock = new DaoTimelock(cfg.timelockMinDelay, noProposers, anyExecutor, guardians, deployer);

        humanityGate = new HumanityGate(deployer);
        if (cfg.passportDecoder != address(0)) {
            passportAdapter = new PassportAdapter(cfg.passportDecoder);
            humanityGate.addProvider(address(passportAdapter));
        }
        if (cfg.testMode) {
            // ⚠️ ЛИШЕ testnet: 100%-score мок-провайдер, щоб не залежати
            // від реального Human Passport Decoder під час тестування.
            mockHumanityProvider = new MockHumanityProvider(10_000, deployer);
            humanityGate.addProvider(address(mockHumanityProvider));
        }
        require(
            cfg.passportDecoder != address(0) || cfg.testMode,
            "Deploy: need at least one humanity provider"
        );

        // Гео-реформа v13 (ZK-приватність, PLONK): на testnet —
        // MockHexAncestryVerifier (завжди приймає, бо реальний доказ
        // Foundry-тести згенерувати не можуть). На mainnet — РЕАЛЬНИЙ
        // PlonkVerifier (src/HexAncestryVerifier.sol), обов'язково
        // згенерований з ПУБЛІЧНОГО universal ptau (той самий Powers-of-
        // Tau файл підходить для БУДЬ-ЯКОГО PLONK-контуру, не лише цього
        // — на відміну від Groth16, тут не потрібна власна одноосібна
        // церемонія) — ⚠️ той верифікатор, що зараз лежить у
        // репозиторії, згенерований ЛОКАЛЬНИМ ТЕСТОВИМ ptau (лише для
        // перевірки пайплайна) — перед mainnet-деплоєм ОБОВ'ЯЗКОВО
        // перегенерувати з реального публічного ptau (див.
        // ZK_PRIVACY_V13_CHANGES.md, розділ "Перед mainnet").
        address hexVerifier;
        if (cfg.testMode) {
            hexVerifier = address(new MockHexAncestryVerifier());
        } else {
            hexVerifier = address(new PlonkVerifier());
        }

        locationRegistry = new LocationRegistry(
            address(daoTimelock),
            hexVerifier,
            keccak256("HR DAO Location Disclosure Notice v1"),
            "ipfs://location-notice-placeholder"
        );
    }

    // ── Крок 2: Influence + статуси Захисника/Консула ──────────────────
    function _deploySBTs(DeployConfig memory cfg, address deployer) internal {
        influenceRegistry = new InfluenceRegistry(address(daoTimelock), address(0));

        shieldSBT = new ShieldSBT(
            address(influenceRegistry),
            address(daoTimelock),
            address(humanityGate),
            cfg.shieldMinHumanityScore,
            cfg.testMode,
            keccak256("HR DAO Human Rights Policy v1"),
            "ipfs://policy-placeholder"
        );
        if (cfg.testMode) {
            shieldSBT.setTestGraceDuration(cfg.shieldGraceDuration);
        }
        humanityGate.setAuthorizedCaller(address(shieldSBT), true);

        councilSBT = new CouncilSBT(
            address(influenceRegistry),
            address(shieldSBT),
            address(daoTimelock),
            address(humanityGate),
            cfg.councilMinHumanityScore
        );
        humanityGate.setAuthorizedCaller(address(councilSBT), true);

        // Мережева стадія (динамічний коефіцієнт $→Influence, узгоджено): підключаємо
        // щойно задеплоєний CouncilSBT до influenceRegistry.networkStage() —
        // без цього виклику networkStage() лишався б назавжди 0 (курс 1:1),
        // тому цей крок ОБОВ'ЯЗКОВИЙ у genesis-вайрингу, а не опційний.
        influenceRegistry.setCouncilSBT(address(councilSBT));

        // ⚠️ ГЕО-РЕФОРМА v14 — генезис-хак ЗНЯТО: раніше тут деплоєр
        // тимчасово видавав собі TIPJAR_ROLE і засівав собі 500 Influence
        // напряму (обходячи дедлок "курка-яйце"), що спільнота справедливо
        // могла б розцінити як несправедливу перевагу засновника.
        //
        // Тепер дедлок вирішує сам TipJar.sol (escrow-режим): award() на
        // InfluenceRegistry викликає ЛИШЕ TipJar (роль видана нижче,
        // setTipJar), і ця роль НІКОЛИ не залежала від стану Treasury.
        // tip() віддає Influence автору БЕЗУМОВНО; лише пул-частка (та, що мала
        // б піти в Treasury) тимчасово лишається в escrow всередині
        // TipJar, якщо Treasury ще не має TIPJAR_ROLE — і повністю
        // "доганяється" пізніше через permissionless sweepEscrowToTreasury().
        // Тобто: БУДЬ-ЯКИЙ реальний tip від реальної людини одразу після
        // генезису вже нараховує реальний Influence отримувачу — без жодного
        // втручання деплоєра. Перший Консул зʼявиться органічно, коли
        // хтось реально накопичить 500 Influence через справжні донати.

        // Уся SBT-верифікація ("propose") завершена — тепер остаточно
        // передаємо governor на daoTimelock. pending, доки перша
        // DAO-пропозиція не викличе acceptGovernor().
        humanityGate.proposeGovernor(address(daoTimelock));
    }

    // ── Крок 3: гексагони, ранжування, казна ─────────────────────────
    function _deployGeoAndTreasury(DeployConfig memory cfg, address deployer) internal {
        rankingEpoch = new CouncilRankingEpoch(
            address(councilSBT),
            address(locationRegistry),
            address(daoTimelock)
        );
        // ⚠️ ГЕНЕЗИС-БУТСТРАП: EPOCH_SUBMITTER_ROLE — деплоєру напряму на
        // testnet (для миттєвого тестування). На mainnet ОБОВ'ЯЗКОВО
        // передати РЕАЛЬНИЙ мультисиг/релеєр через env var EPOCH_SUBMITTER —
        // на відміну від DAO_ROLE (яку _finalizeRoles() коректно відкликає
        // у деплоєра наприкінці), EPOCH_SUBMITTER_ROLE НІХТО автоматично
        // не відкликає (це окрема, навмисно делегована операційна роль,
        // не призначена для передачі назад ДАО щоразу) — тому мовчазний
        // дефолт на deployer тут був би EOA, що постійно контролює подання
        // епохальних даних (склад Council, населеність гексагонів →
        // маршрутизація податку Treasury, Influence-коефіцієнт, територія
        // гео-скоупованих пропозицій). Раніше цей дефолт спрацьовував
        // МОВЧКИ (vm.envOr(..., deployer)) — тепер на mainnet без
        // EPOCH_SUBMITTER скрипт одразу ревертає.
        //
        // ⚠️ РЕКОМЕНДАЦІЯ: EPOCH_SUBMITTER на mainnet МАЄ бути мультисиг
        // (напр. Safe 2-з-3), НЕ одна EOA — дешевий, негайний захист без
        // жодних змін коду. Повноцінна permissionless-альтернатива вже
        // готова (OptimisticEpochSubmission.sol — застава+вікно
        // оскарження, УЖЕ передає nodeOverflowed так само, як seat root) —
        // деплоїться окремо через script/DeployOptEpoch.s.sol, вмикається
        // однією DAO-пропозицією (grantRole(EPOCH_SUBMITTER_ROLE, ...)),
        // коли ДАО буде готова децентралізувати цей крок повністю.
        address epochSubmitter;
        if (cfg.testMode) {
            epochSubmitter = deployer;
        } else {
            epochSubmitter = vm.envOr("EPOCH_SUBMITTER", address(0));
            require(epochSubmitter != address(0), "Deploy: EPOCH_SUBMITTER must be set explicitly on mainnet");
        }
        rankingEpoch.grantRole(rankingEpoch.EPOCH_SUBMITTER_ROLE(), epochSubmitter);

        treasury = new Treasury(
            address(daoTimelock),
            _guardians(deployer, cfg.testMode),
            address(locationRegistry),
            address(rankingEpoch),
            cfg.rollingWindow,
            cfg.recipientCooldown
        );

        discipline = new DisciplineModule(address(shieldSBT), address(councilSBT), address(influenceRegistry));
        shieldSBT.setDisciplineModule(address(discipline), true);
        councilSBT.setDisciplineModule(address(discipline), true);

        if (cfg.testMode) {
            // Тестовий ERC-20 для локального прогону withdraw/tip-циклів.
            mockToken = new MockERC20("Test USD", "tUSD", 6);
        }
    }

    // ── Крок 4: TipJar + DaoGovernor ──────────────────────────────────
    function _deployGovernanceLayer(DeployConfig memory cfg, address deployer) internal {
        (
            address[] memory initialTokens,
            uint256[] memory initialMinAmounts,
            uint256[] memory initialInfluencePerUnit
        ) = _buildInitialStablecoins(cfg);

        tipJar = new TipJar(
            address(shieldSBT),
            address(councilSBT),
            address(influenceRegistry),
            address(treasury),
            address(daoTimelock),
            initialTokens,
            initialMinAmounts,
            initialInfluencePerUnit
        );

        DaoGovernor.GovernorConfig memory gc = DaoGovernor.GovernorConfig({
            votingDelay: cfg.votingDelay,
            votingPeriod: cfg.votingPeriod,
            proposalThreshold: 0
        });

        daoGovernor = new DaoGovernor(
            address(influenceRegistry),
            address(shieldSBT),
            address(councilSBT),
            address(discipline),
            address(rankingEpoch),
            TimelockController(payable(address(daoTimelock))),
            gc
        );

        influenceRegistry.setTipJar(address(tipJar), true);
        influenceRegistry.grantRole(influenceRegistry.ACTIVITY_ROLE(), address(daoGovernor));
        influenceRegistry.grantRole(influenceRegistry.ACTIVITY_ROLE(), address(discipline));

        daoTimelock.grantRole(daoTimelock.PROPOSER_ROLE(), address(daoGovernor));
        daoTimelock.grantRole(daoTimelock.CANCELLER_ROLE(), address(daoGovernor));
    }

    // ── Крок 5: прибрати ВСІ тимчасові ролі деплоєра ─────────────────
    function _finalizeRoles(address deployer) internal {
        // (Гео-реформа v14: TIPJAR_ROLE деплоєру більше НЕ видається
        // взагалі — genesis-хак прибрано, revokeRole тут відповідно
        // теж не потрібен.)

        influenceRegistry.revokeRole(influenceRegistry.DAO_ROLE(), deployer);
        shieldSBT.revokeRole(shieldSBT.DAO_ROLE(), deployer);
        councilSBT.revokeRole(councilSBT.DAO_ROLE(), deployer);
        rankingEpoch.revokeRole(rankingEpoch.DAO_ROLE(), deployer);

        daoTimelock.revokeRole(daoTimelock.DEFAULT_ADMIN_ROLE(), deployer);

        // ⚠️ humanityGate.governor НАВМИСНЕ лишається "deployer" (pending →
        // daoTimelock) — це не забутий крок. Перша ж DAO-пропозиція після
        // генезису МАЄ викликати humanityGate.acceptGovernor(), інакше
        // деплоєр технічно лишається governor-ом (може addProvider/
        // removeProvider) необмежено довго. Задокументовано в
        // HumanityGate.sol і в Tokenomics, розділ 10.
        //
        // ⚠️ Treasury.TIPJAR_ROLE — Treasury НЕ видає деплоєру ЖОДНОЇ
        // тимчасової ролі (навмисно, немає backdoor) — лише daoTimelock
        // (TREASURER_ROLE) може викликати setTipJarRole(). ОДРАЗУ після
        // генезису пул-частка tip-ів (poolAmount) НЕ втрачається і НЕ
        // ревертає весь tip() — TipJar.sol (Гео-реформа v14) ловить
        // відсутність ролі через try/catch і тимчасово тримає ці кошти в
        // escrow всередині себе (autor і далі отримує Influence БЕЗУМОВНО, як і
        // завжди). Перша ж DAO-пропозиція має викликати
        // treasury.setTipJarRole(address(tipJar), true) — а ПІСЛЯ неї
        // будь-хто може одноразово перенести накопичений escrow викликом
        // tipJar.sweepEscrowToTreasury(token) (permissionless).
        //
        // Оскільки award() на InfluenceRegistry більше НЕ залежить
        // від стану Treasury (tip() завжди довершується, лише
        // Treasury-крок міг escrow-итись), ПЕРШИЙ Консул зʼявляється
        // ОРГАНІЧНО — щойно якийсь реальний учасник накопичить 500 Influence
        // через справжні донати від справжніх людей, без жодного
        // втручання деплоєра чи спеціального засіву.
    }

    /**
     * @notice Гео-реформа v6: будує масиви ЗА ЗАМОВЧУВАННЯМ зареєстрованих
     *         стейблкоїнів (TokenKind.STABLE у TipJar) — mockToken на
     *         testnet (якщо testMode) + будь-які реальні USDC/USDT/DAI-
     *         адреси, передані через env (address(0) = пропустити).
     *         influencePerUnit і minAmount підібрані під ТИПОВІ decimals
     *         кожного токена (USDC/USDT — 6, DAI — 18) так, щоб $1 ≈ 1 RIGHT
     *         — той самий принцип, що й раніше для mockToken.
     */
    function _buildInitialStablecoins(DeployConfig memory cfg)
        internal
        view
        returns (address[] memory tokens, uint256[] memory minAmounts, uint256[] memory rates)
    {
        uint256 count = 0;
        if (cfg.testMode)                count++;
        if (cfg.usdcAddress != address(0)) count++;
        if (cfg.usdtAddress != address(0)) count++;
        if (cfg.daiAddress  != address(0)) count++;

        tokens     = new address[](count);
        minAmounts = new uint256[](count);
        rates      = new uint256[](count);

        uint256 i = 0;
        if (cfg.testMode) {
            tokens[i]     = address(mockToken);
            minAmounts[i] = 1e6;  // 1 tUSD мінімум (mockToken — 6 decimals)
            rates[i]      = 1e12; // 1e18 / 1e6 → 1 tUSD = 1 RIGHT
            i++;
        }
        if (cfg.usdcAddress != address(0)) {
            tokens[i]     = cfg.usdcAddress;
            minAmounts[i] = 1e6;  // USDC — 6 decimals, мінімум 1 USDC
            rates[i]      = 1e12; // 1 USDC = 1 RIGHT
            i++;
        }
        if (cfg.usdtAddress != address(0)) {
            tokens[i]     = cfg.usdtAddress;
            minAmounts[i] = 1e6;  // USDT — теж 6 decimals
            rates[i]      = 1e12;
            i++;
        }
        if (cfg.daiAddress != address(0)) {
            tokens[i]     = cfg.daiAddress;
            minAmounts[i] = 1e18; // DAI — 18 decimals, мінімум 1 DAI
            rates[i]      = 1;    // 1e18 / 1e18 → 1 DAI = 1 RIGHT
            i++;
        }
    }

    /// @dev На testnet — deployer як guardian (швидка ітерація). На
    ///      mainnet ОБОВ'ЯЗКОВО потрібен реальний мультисиг (GUARDIAN_MULTISIG) —
    ///      guardian має право на екстрену паузу/скасування (DaoTimelock
    ///      cancel, Treasury.GUARDIAN_ROLE), тож мовчазний дефолт на EOA
    ///      деплоєра тут — той самий клас ризику, що й EPOCH_SUBMITTER
    ///      вище: раніше замовчувався, тепер на mainnet без явного env
    ///      var скрипт одразу ревертає.
    function _guardians(address deployer, bool testMode) internal view returns (address[] memory) {
        address configuredGuardian = vm.envOr("GUARDIAN_MULTISIG", address(0));
        if (!testMode) {
            require(configuredGuardian != address(0), "Deploy: GUARDIAN_MULTISIG must be set explicitly on mainnet");
        }
        address[] memory g = new address[](1);
        g[0] = configuredGuardian != address(0) ? configuredGuardian : deployer;
        return g;
    }

    function _loadConfig() internal view returns (DeployConfig memory cfg) {
        bool testMode = vm.envOr("TESTNET", true); // ⚠️ дефолт true — на mainnet ОБОВ'ЯЗКОВО передати TESTNET=false явно
        cfg = DeployConfig({
            testMode: testMode,
            timelockMinDelay: testMode ? vm.envOr("TIMELOCK_DELAY", uint256(60)) : 72 hours,
            shieldMinHumanityScore: vm.envOr("SHIELD_MIN_SCORE", uint256(2000)),   // ×100 = поріг score
            councilMinHumanityScore: vm.envOr("COUNCIL_MIN_SCORE", uint256(5000)),
            shieldGraceDuration: testMode ? vm.envOr("GRACE_DURATION", uint256(120)) : 0, // 2 хв. на testnet
            rollingWindow: testMode ? vm.envOr("ROLLING_WINDOW", uint256(600)) : 30 days,        // 10 хв. на testnet
            recipientCooldown: testMode ? vm.envOr("RECIPIENT_COOLDOWN", uint256(60)) : 14 days, // 60с на testnet
            votingDelay: testMode ? 60 : 2 days,
            votingPeriod: testMode ? 300 : 7 days,
            passportDecoder: vm.envOr("PASSPORT_DECODER", address(0)),
            usdcAddress: vm.envOr("USDC_ADDRESS", address(0)),
            usdtAddress: vm.envOr("USDT_ADDRESS", address(0)),
            daiAddress:  vm.envOr("DAI_ADDRESS", address(0))
        });
    }

    function _logSummary() internal view {
        console2.log("=== HR DAO deployed ===");
        console2.log("DaoTimelock:         ", address(daoTimelock));
        console2.log("HumanityGate:        ", address(humanityGate));
        console2.log("LocationRegistry:    ", address(locationRegistry));
        console2.log("InfluenceRegistry:      ", address(influenceRegistry));
        console2.log("ShieldSBT:           ", address(shieldSBT));
        console2.log("CouncilSBT:          ", address(councilSBT));
        console2.log("CouncilRankingEpoch: ", address(rankingEpoch));
        console2.log("Treasury:            ", address(treasury));
        console2.log("DisciplineModule:    ", address(discipline));
        console2.log("TipJar:              ", address(tipJar));
        console2.log("DaoGovernor:         ", address(daoGovernor));
        if (address(mockToken) != address(0)) {
            console2.log("MockERC20 (testnet): ", address(mockToken));
        }
    }
}
