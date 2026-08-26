// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./HumanityGate.sol";

/**
 * @title IPassportDecoder
 * @notice Той самий інтерфейс, що був у старому PassportGate.sol.
 */
interface IPassportDecoder {
    function getScore(address account) external view returns (uint256);
}

/**
 * @title PassportAdapter
 * @notice Тонка обгортка вже наявного Human Passport Decoder-контракту під
 *         спільний інтерфейс IHumanityVerifier, щоб його можна було
 *         зареєструвати в HumanityGate через addProvider(). Passport вже
 *         віддає score у потрібному масштабі (×100), тому адаптер тут —
 *         це буквально прохідний виклик, без перерахунку.
 *
 * @dev Деплоїться ОДИН РАЗ на мережу (той самий decoder, що раніше
 *      передавався напряму в конструктор ShieldSBT/CouncilSBT), і саме
 *      адреса ЦЬОГО адаптера (не decoder напряму) передається в
 *      humanityGate.addProvider().
 */
contract PassportAdapter is IHumanityVerifier {
    IPassportDecoder public immutable passportDecoder;

    constructor(address _passportDecoder) {
        require(_passportDecoder != address(0), "PassportAdapter: zero decoder");
        passportDecoder = IPassportDecoder(_passportDecoder);
    }

    function getScore(address account) external view returns (uint256) {
        return passportDecoder.getScore(account);
    }
}

/**
 * @title IWorldIDRouter
 * @notice Мінімальний приклад інтерфейсу для майбутнього World ID-адаптера
 *         (точна сигнатура залежить від того, яку версію World ID Router
 *         DAO вирішить підключити — уточнити на момент інтеграції).
 * @dev Залишено як ілюстрація "як додати ще один провайдер" — НЕ
 *      задеплоєний і не підключений, поки DAO не проголосує за це.
 */
interface IWorldIDRouter {
    function isVerified(address account) external view returns (bool);
}

/**
 * @title WorldIDAdapter
 * @notice World ID зазвичай бінарний (verified / not verified), тому
 *         мапимо його у ту саму шкалу 0-10000, що й Passport: verified →
 *         10000 (максимальний score), not verified → 0. Завдяки цьому
 *         ShieldSBT.minHumanityScore і CouncilSBT.minHumanityScore
 *         продовжують працювати в тих самих одиницях незалежно від того,
 *         який провайдер їх фактично задовольнив.
 */
contract WorldIDAdapter is IHumanityVerifier {
    IWorldIDRouter public immutable worldIdRouter;

    constructor(address _worldIdRouter) {
        require(_worldIdRouter != address(0), "WorldIDAdapter: zero router");
        worldIdRouter = IWorldIDRouter(_worldIdRouter);
    }

    function getScore(address account) external view returns (uint256) {
        return worldIdRouter.isVerified(account) ? 10000 : 0;
    }
}
