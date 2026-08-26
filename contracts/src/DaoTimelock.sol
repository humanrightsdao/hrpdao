// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title DaoTimelock
 * @notice TimelockController для ОБ'ЄДНАНОГО DaoGovernor (Shield+Council
 *         пропонують/голосують за все через єдиний Governor). Цей Timelock
 *         лишається ЄДИНИМ виконавчим контуром ДАО.
 *
 * Цей Timelock тримає:
 *   - DAO_ROLE на InfluenceRegistry, ShieldSBT, CouncilSBT, TipJar (усі setTipJar/
 *     setDisciplineModule/setAcceptedToken/setSplits — самоврядні ролі,
 *     керовані лише через DaoGovernor)
 *   - ACTIVITY_ROLE на InfluenceRegistry
 *   - контроль над казною/основними коштами ДАО
 *
 * Затримка (testnet): 60 секунд. Затримка (mainnet): рекомендовано 72 год+
 * (це найвищий і ЄДИНИЙ бар'єр виконання тепер — і для казни/токеноміки,
 *  і для звичайних рішень, бо Governor тепер один).
 *
 * ⚠️ Це моя рекомендація щодо довжини затримки — не було явно узгоджено
 * яка саме довжина.
 *
 * Ролі (узгоджено: однакові правила для всіх, без мультисиг-адміна):
 *   PROPOSER_ROLE  → DaoGovernor
 *   CANCELLER_ROLE → DaoGovernor + НЕЗАЛЕЖНІ guardians (окремий мультисиг,
 *                    НЕ Governor і не хтось із proposers) — див. параметр
 *                    `guardians` нижче.
 *
 *                    ⚠️ Технічно: конструктор TimelockController приймає
 *                    порожній масив `proposers` (DaoGovernor ще не існує
 *                    на момент деплою цього Timelock — черговість
 *                    GenesisDeployer: спочатку Timelock, DaoGovernor
 *                    деплоїться пізніше). Тому PROPOSER_ROLE і
 *                    CANCELLER_ROLE видаються DaoGovernor-у ОКРЕМИМИ
 *                    явними grantRole()-викликами вже ПІСЛЯ його деплою
 *                    (GenesisDeployer._finalizeRoles()), а не автоматичним
 *                    "бандлом" з конструктора — авто-бандл там працює
 *                    лише для адрес, переданих САМЕ в масив `proposers`
 *                    під час деплою Timelock-у, що тут неможливо через
 *                    порядок деплою.
 *
 *                    ⚠️ КРИТИЧНО: якщо CANCELLER_ROLE має лише сам
 *                    DaoGovernor, скасувати шкідливу пропозицію під час
 *                    minDelay нема кому в разі захоплення голосування —
 *                    той самий скомпрометований актор, що провів
 *                    пропозицію, є єдиним, хто міг би її скасувати.
 *                    Guardians — це саме та "спроможність реагувати",
 *                    без якої затримка (72г+) є лише відстрочкою, а не
 *                    захистом. Guardians НЕ отримують PROPOSER_ROLE і
 *                    НЕ можуть самі ініціювати чи виконати жодну дію —
 *                    лише скасувати вже заплановану.
 *   EXECUTOR_ROLE  → address(0)
 *   DEFAULT_ADMIN_ROLE → НІКОМУ — деплой через GenesisDeployer
 *                    (одна атомарна транзакція, без вікна довіри)
 */
contract DaoTimelock is TimelockController {
    /**
     * @param minDelay   Затримка виконання (mainnet: рекомендовано 72г+)
     * @param proposers  DaoGovernor (автоматично отримує і PROPOSER_ROLE,
     *                    і CANCELLER_ROLE через конструктор TimelockController)
     * @param executors  address(0) — виконати може будь-хто після delay
     * @param guardians  НЕЗАЛЕЖНИЙ мультисиг довірених осіб поза звичайним
     *                    DAO-голосуванням. Отримує ЛИШЕ CANCELLER_ROLE —
     *                    емерджентний "стоп-кран" на випадок захоплення
     *                    Governor-у чи виявленої шкідливої пропозиції під
     *                    час minDelay-вікна. Не плутати з proposers.
     * @param admin      Тимчасовий DEFAULT_ADMIN_ROLE для атомарного
     *                    genesis-вайрингу (GenesisDeployer), зрікається
     *                    себе в тій самій транзакції
     */
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address[] memory guardians,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {
        for (uint256 i = 0; i < guardians.length; i++) {
            _grantRole(CANCELLER_ROLE, guardians[i]);
        }
    }
}
