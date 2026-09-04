// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockHexAncestryVerifier
 * @notice ТІЛЬКИ для тестування: заглушка замість реального
 *         Groth16Verifier (src/HexAncestryVerifier.sol) — завжди
 *         повертає `alwaysValid` (дефолт true), не робить жодної
 *         реальної криптографічної перевірки.
 *
 *         Причина: Foundry-тести не можуть практично згенерувати
 *         справжній Groth16-доказ (потребує snarkjs/circom поза EVM);
 *         цей мок дозволяє тестувати РЕШТУ системи (LocationRegistry.
 *         revealAncestor()/каскад/маршрутизація), не блокуючись на
 *         відсутності реального ZK-тулчейну в тестовому середовищі.
 *
 * ⚠️ ТІЛЬКИ для testnet/local — НІКОЛИ не деплоїти на mainnet замість
 *    справжнього Groth16Verifier.
 */
contract MockHexAncestryVerifier {
    bool public alwaysValid = true;

    function setAlwaysValid(bool v) external {
        alwaysValid = v;
    }

    function verifyProof(
        uint256[24] calldata /*_proof*/,
        uint256[3] calldata /*_pubSignals*/
    ) external view returns (bool) {
        return alwaysValid;
    }
}
