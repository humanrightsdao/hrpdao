// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockFeeOnTransferERC20
 * @notice ТІЛЬКИ для тестування: ERC-20, що спалює `feeBps` від суми на
 *         КОЖНОМУ трансфері (не на mint/burn) — імітує реальні deflationary/
 *         fee-on-transfer токени, щоб перевірити, що TipJar рахує спліт/
 *         RIGHTS від РЕАЛЬНО отриманої суми (balanceOf до/після), а не від
 *         номінального параметра `amount` (Гео-реформа v6).
 *
 * ⚠️ ТІЛЬКИ для testnet/local — не для production-деплою.
 */
contract MockFeeOnTransferERC20 is ERC20 {
    uint8 private immutable _customDecimals;

    /// @notice Комісія в basis points (10000 = 100%), спалюється при
    ///         КОЖНОМУ трансфері (крім mint/burn, from/to == address(0)).
    uint256 public feeBps;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 feeBps_)
        ERC20(name_, symbol_)
    {
        require(feeBps_ <= 10_000, "MockFeeOnTransferERC20: fee too high");
        _customDecimals = decimals_;
        feeBps = feeBps_;
    }

    function decimals() public view virtual override returns (uint8) {
        return _customDecimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFeeBps(uint256 newFeeBps) external {
        require(newFeeBps <= 10_000, "MockFeeOnTransferERC20: fee too high");
        feeBps = newFeeBps;
    }

    /// @dev OZ v5 hook: спалює feeBps від `value` на кожному реальному
    ///      трансфері (from != 0 і to != 0), решту переказує як зазвичай.
    function _update(address from, address to, uint256 value) internal virtual override {
        if (from != address(0) && to != address(0) && feeBps > 0) {
            uint256 fee = (value * feeBps) / 10_000;
            if (fee > 0) {
                super._update(from, address(0), fee); // спалити комісію
                value -= fee;
            }
        }
        super._update(from, to, value);
    }
}
