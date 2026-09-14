// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/OptimisticEpochSubmission.sol";

/**
 * @title DeployOptEpoch
 * @notice Окремий скрипт для деплою OptimisticEpochSubmission ПІСЛЯ того,
 *         як основний Deploy.s.sol вже відпрацював — permissionless-шлях
 *         подачі рейтингу свідомо не деплоїться автоматично (див. TODO
 *         у Tokenomics v4). Приймає адреси вже задеплоєних контрактів
 *         через змінні середовища, нічого не хардкодить.
 *
 * ⚠️ Цей скрипт ЛИШЕ деплоїть контракт. Він НЕ і НЕ МОЖЕ видати йому
 * EPOCH_SUBMITTER_ROLE на CouncilRankingEpoch — DAO_ROLE там тепер тримає
 * ЛИШЕ DaoTimelock (деплоєр уже відкликав свою), тож грант ролі можливий
 * лише через повний цикл propose→vote→queue→execute в DaoGovernor.
 *
 * Запуск (Arbitrum Sepolia, chain id 421614):
 *   export COUNCIL_SBT=0x...
 *   export LOCATION_REGISTRY=0x...
 *   export RANKING_EPOCH=0x...
 *   export DAO_TIMELOCK=0x...
 *   forge script script/DeployOptEpoch.s.sol:DeployOptEpoch --rpc-url arbitrum_sepolia --broadcast --verify
 *
 * Запуск (Arbitrum One, mainnet, chain id 42161) — так само, лише
 *   --rpc-url arbitrum_one і реальний GUARDIAN_MULTISIG.
 */
contract DeployOptEpoch is Script {
    OptimisticEpochSubmission public optEpoch;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        address councilSBT      = vm.envAddress("COUNCIL_SBT");
        address locationRegistry = vm.envAddress("LOCATION_REGISTRY");
        address rankingEpoch    = vm.envAddress("RANKING_EPOCH");
        address daoTimelock     = vm.envAddress("DAO_TIMELOCK");

        // Guardian — за замовчуванням сам деплоєр (testnet); на mainnet
        // передати реальний мультисиг через GUARDIAN_MULTISIG.
        address guardian = vm.envOr("GUARDIAN_MULTISIG", deployer);
        address[] memory guardians = new address[](1);
        guardians[0] = guardian;

        vm.startBroadcast(deployerKey);

        optEpoch = new OptimisticEpochSubmission(
            councilSBT,
            locationRegistry,
            rankingEpoch,
            daoTimelock, // DAO_ROLE цього НОВОГО контракту — одразу daoTimelock, тимчасовий грант деплоєру теж додасться автоматично (msg.sender != dao у конструкторі)
            guardians
        );

        vm.stopBroadcast();

        console2.log("=== OptimisticEpochSubmission deployed ===");
        console2.log("Address:", address(optEpoch));
        console2.log("");
        console2.log("NEXT STEP: grant EPOCH_SUBMITTER_ROLE on CouncilRankingEpoch");
        console2.log("via DaoGovernor proposal (bootstrap deadlock - see chat guidance).");
    }
}
