// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./TipJar.sol"; // IPriceFeed оголошений на рівні файлу в TipJar.sol

/**
 * @title MockPriceFeed
 * @notice ТІЛЬКИ для тестування: мінімальний Chainlink-сумісний price feed
 *         (IPriceFeed з TipJar.sol) з ручним встановленням ціни/часу —
 *         щоб перевірити ORACLE-гілку TipJar._valueInRights() і захист
 *         від протухлої ціни (maxOracleStaleness), без залежності від
 *         реального Chainlink-деплою на testnet.
 *
 * ⚠️ ТІЛЬКИ для testnet/local — не для production-деплою (на mainnet
 *    TipJar.setOraclePricedToken() має вказувати на РЕАЛЬНИЙ Chainlink-
 *    (чи сумісний) фід, ніколи не на цей мок).
 */
contract MockPriceFeed is IPriceFeed {
    uint8   public immutable priceDecimals;
    int256  public price;
    uint256 public updatedAt;

    constructor(uint8 _priceDecimals, int256 _initialPrice) {
        priceDecimals = _priceDecimals;
        price = _initialPrice;
        updatedAt = block.timestamp;
    }

    function decimals() external view returns (uint8) {
        return priceDecimals;
    }

    /// @notice Оновити ціну (і, як у реальному оракулі, час оновлення).
    function setPrice(int256 newPrice) external {
        price = newPrice;
        updatedAt = block.timestamp;
    }

    /// @notice Імітувати "протухлу" ціну — не міняючи саму ціну, лише
    ///         відкотити updatedAt на `secondsAgo` назад від зараз.
    function setStaleBy(uint256 secondsAgo) external {
        updatedAt = block.timestamp > secondsAgo ? block.timestamp - secondsAgo : 0;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt_, uint80 answeredInRound)
    {
        return (1, price, updatedAt, updatedAt, 1);
    }
}
