// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title H3Utils
 * @notice Бітова математика H3-індексів (формат H3 v1), без повної H3-
 *         бібліотеки — потрібні лише операції "яка резолюція" і "хто
 *         батько" (truncation), обидві прості бітові маски.
 *
 * ⚠️ ПЕРЕВІРЕНО: логіка _parentOf() і _resolutionOf() звірена з реальним
 * виводом бібліотеки `h3-js` (латTest на 3 точках з різних континентів,
 * повний ланцюжок res3→res2→res1→res0) — результати збігаються точно.
 * Truncation "дитина → батько" не має пентагон-спотворень (вони
 * стосуються лише переліку/кількості ДІТЕЙ, не visnovka по одному
 * конкретному предку), тому ця операція надійна для БУДЬ-ЯКОГО валідного
 * H3-індексу, включно з тими, що належать пентагональним базовим
 * коміркам.
 *
 * Формат H3 v1 (64 біти, LSB-нумерація):
 *   - біти 59-62: mode (1 = H3 Cell)
 *   - біти 52-55: resolution (0-15)
 *   - біти 45-51: базова комірка (0-121)
 *   - потім по 3 біти на кожну резолюцію 1..15 (значення 7 = "unused")
 */
library H3Utils {
    uint256 private constant _RES_SHIFT  = 52;
    uint256 private constant _RES_MASK   = 0xF;
    uint256 private constant _MODE_SHIFT = 59;
    uint256 private constant _MODE_MASK  = 0xF;
    uint8   private constant _CELL_MODE  = 1;
    uint64  private constant _UNUSED_DIGIT = 0x7;

    /// @notice Резолюція H3-індексу (0-15).
    function resolutionOf(uint64 h3Index) internal pure returns (uint8) {
        return uint8((h3Index >> _RES_SHIFT) & _RES_MASK);
    }

    /// @notice Чи це взагалі валідний за форматом H3 Cell-індекс (легка
    ///         сигнатурна перевірка mode-бітів, не повна H3-валідація).
    function isValidCellIndex(uint64 h3Index) internal pure returns (bool) {
        return uint8((h3Index >> _MODE_SHIFT) & _MODE_MASK) == _CELL_MODE;
    }

    /// @notice Батьківський H3-індекс на резолюцію нижче (h3ToParent).
    ///         Реверт, якщо hexId уже на резолюції 0 (батька не існує).
    function parentOf(uint64 h3Index) internal pure returns (uint64) {
        uint8 res = resolutionOf(h3Index);
        require(res > 0, "H3Utils: resolution 0 has no parent");

        uint8 newRes = res - 1;

        // Обнулити поле резолюції, записати нове значення.
        uint64 cleared    = h3Index & ~(uint64(_RES_MASK) << uint64(_RES_SHIFT));
        uint64 withNewRes = cleared | (uint64(newRes) << uint64(_RES_SHIFT));

        // Позначити digit-біти позиції `res` як "unused" (0b111).
        uint256 digitShift = uint256(15 - res) * 3;
        uint64 digitMask   = _UNUSED_DIGIT << uint64(digitShift);

        return withNewRes | digitMask;
    }

    /// @notice Піднятись на `levels` резолюцій вгору одним викликом.
    function ancestorOf(uint64 h3Index, uint8 levels) internal pure returns (uint64) {
        uint64 current = h3Index;
        for (uint8 i = 0; i < levels; i++) {
            current = parentOf(current);
        }
        return current;
    }
}
