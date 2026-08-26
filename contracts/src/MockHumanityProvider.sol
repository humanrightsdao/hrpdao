// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockHumanityProvider
 * @notice ЛИШЕ ДЛЯ TESTNET. Реалізує IHumanityVerifier (getScore) і завжди
 *         повертає фіксований високий score для БУДЬ-ЯКОЇ адреси — тобто
 *         "справжня перевірка людяності" повністю обходиться: будь-хто
 *         проходить humanityGate.verifyHuman()/isHuman() з мінімальним
 *         score, який ви задасте в ShieldSBT/CouncilSBT.
 *
 * ⚠️ НІКОЛИ не використовувати на mainnet — це буквально відкриває Sybil-
 * атаку "один гаманець = одна людина" повністю, без жодного захисту.
 * Призначення — ЛИШЕ прискорити першу тестову прогонку контрактів, коли
 * реальна інтеграція з Human Passport/World ID ще не потрібна.
 *
 * Використання: замість PassportAdapter підключіть цей контракт як
 * провайдера в HumanityGate.addProvider(address(mockProvider)).
 */
contract MockHumanityProvider {
    /// @notice Фіксований score (масштаб ×100, тобто 10000 = 100.00),
    ///         однаковий для будь-якої адреси. DAO (тут — просто admin
    ///         деплою) може змінити для різних тестових сценаріїв.
    uint256 public fixedScore;

    address public admin;

    event FixedScoreUpdated(uint256 newScore);

    constructor(uint256 _fixedScore, address _admin) {
        fixedScore = _fixedScore;
        admin = _admin;
    }

    function getScore(address /*account*/) external view returns (uint256) {
        return fixedScore;
    }

    function setFixedScore(uint256 newScore) external {
        require(msg.sender == admin, "MockHumanityProvider: not admin");
        fixedScore = newScore;
        emit FixedScoreUpdated(newScore);
    }
}
