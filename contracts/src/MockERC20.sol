// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockERC20
 * @notice Тестовий ERC-20 токен для локального тестування TipJar на Anvil
 *         (вільний mint для будь-кого, кастомна кількість decimals).
 *
 * ⚠️ ВИПРАВЛЕНО: раніше decimals() завжди повертав 18 (дефолт OpenZeppelin
 * ERC20), незалежно від того, який токен імітувався. Через це "tUSDC"
 * фактично мав 18 decimals замість 6, що зламало конвертацію в RIGHTS
 * у TipJar (rightsPerUnit рахувався під 6 decimals, а реальна сума
 * приходила в 18-decimals одиницях — інфляція ×1e12).
 * Тепер decimals передається явно в конструкторі і повертається з override.
 *
 * ⚠️ ТІЛЬКИ для testnet/local. На mainnet використовувати реальний GHO/USDC.
 */
contract MockERC20 is ERC20 {
    uint8 private immutable _customDecimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) ERC20(name_, symbol_) {
        _customDecimals = decimals_;
    }

    /// @notice Перевизначає дефолтні 18 decimals з OpenZeppelin ERC20.
    function decimals() public view virtual override returns (uint8) {
        return _customDecimals;
    }

    /// @notice Будь-хто може намінтити собі тестових токенів.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
