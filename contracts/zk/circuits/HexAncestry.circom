pragma circom 2.1.9;

include "poseidon.circom";
include "comparators.circom";
include "bitify.circom";
include "gates.circom";

/*
 * HexAncestry.circom
 * ------------------
 * Доводить: "я знаю приватний H3-індекс `hexId` і `salt`, такі що
 *   (1) Poseidon(hexId, salt) == commitment (публічний, уже записаний
 *       у LocationRegistry ЗАМІСТЬ сирого hexId)
 *   (2) предок hexId на резолюції `level` дорівнює `branchId`
 * — БЕЗ розкриття самого hexId (а отже, і точної локації на рівні 10).
 *
 * Формат H3-індексу (64-біт, детально в src/H3Utils.sol):
 *   біт 63        — reserved (0)
 *   біти 59-62 (4)— mode (1 = Cell)
 *   біти 56-58 (3)— reserved (0)
 *   біти 52-55 (4)— resolution
 *   біти 45-51 (7)— base cell
 *   біти 0-44 (45)— 15 груп по 3 біти: digit для резолюції r у позиції
 *                    (15-r)*3, r=1..15
 *
 * Замість ІТЕРАТИВНОГО "здирання" по одному рівню (як parentOf() у
 * H3Utils.sol) — схема одразу РЕКОНСТРУЮЄ предка на заданому `level`:
 * той самий mode/base cell, resolution=level, digit r лишається, якщо
 * r<=level, інакше стає "unused" (0b111=7). Це прямий, детермінований
 * розрахунок — без цикла parentOf(), значно дешевше в обмеженнях схеми.
 *
 * `level` — 0..10 (EARTH, рівень -1, обробляється ПОЗА схемою: голосування
 * за EARTH-масштабну пропозицію не потребує жодного доказу, доступне всім).
 */
template HexAncestry() {
    // ── Публічні входи ──────────────────────────────────────────
    signal input commitment; // Poseidon(hexId, salt), записаний у LocationRegistry
    signal input level;      // 0..10 — рівень, на якому доводимо приналежність
    signal input branchId;   // заявлений предок на цьому рівні (nodeKey перевіряється контрактом окремо)

    // ── Приватні входи ──────────────────────────────────────────
    signal input hexId;
    signal input salt;

    // ── (1) Комітмент ───────────────────────────────────────────
    component hasher = Poseidon(2);
    hasher.inputs[0] <== hexId;
    hasher.inputs[1] <== salt;
    hasher.out === commitment;

    // ── Розкладання hexId на 64 біти ────────────────────────────
    component bits = Num2Bits(64);
    bits.in <== hexId;

    // Допоміжна: зібрати підмножину бітів у число (little-endian у Num2Bits,
    // біт 0 — найменш значущий).
    // mode: біти 59..62
    signal mode;
    mode <== bits.out[59] + 2*bits.out[60] + 4*bits.out[61] + 8*bits.out[62];
    mode === 1; // має бути дійсна H3-клітинка (Cell mode)

    // resolution (declaredRes): біти 52..55
    signal declaredRes;
    declaredRes <== bits.out[52] + 2*bits.out[53] + 4*bits.out[54] + 8*bits.out[55];

    // level має не перевищувати ВЛАСНУ задекларовану резолюцію
    // (інакше "предок на рівні level" глибший за те, що людина взагалі
    // задекларувала — безглуздо і небезпечно дозволяти).
    component levelCheck = LessEqThan(4); // 4 біти достатньо (0..10 < 16)
    levelCheck.in[0] <== level;
    levelCheck.in[1] <== declaredRes;
    levelCheck.out === 1;

    // base cell: біти 45..51 (7 бітів)
    signal baseCell;
    baseCell <== bits.out[45] + 2*bits.out[46] + 4*bits.out[47] + 8*bits.out[48]
                + 16*bits.out[49] + 32*bits.out[50] + 64*bits.out[51];

    // ── (2) Реконструкція предка на рівні `level` ───────────────
    // Для кожної позиції r=1..15: digit_r (3 біти, позиція (15-r)*3),
    // ефективне значення = digit_r, якщо r<=level, інакше 7 (unused).
    component isKept[15];
    signal digitEff[15];
    signal digitRaw[15];

    for (var r = 1; r <= 15; r++) {
        var shift = (15 - r) * 3;
        digitRaw[r-1] <== bits.out[shift] + 2*bits.out[shift+1] + 4*bits.out[shift+2];

        // isKept = 1, якщо r <= level
        isKept[r-1] = LessEqThan(4);
        isKept[r-1].in[0] <== r;
        isKept[r-1].in[1] <== level;

        // digitEff = isKept ? digitRaw : 7
        digitEff[r-1] <== isKept[r-1].out * digitRaw[r-1] + (1 - isKept[r-1].out) * 7;
    }

    // Зібрати відновленого предка назад у 64-бітне число.
    // (Степені 2 виписані буквально, а не через `**`, щоб не залежати
    // від конкретної підтримки оператора піднесення до степеня в
    // компайлері — безпечніше й однозначніше.)
    signal reconstructed;
    var acc = mode * 576460752303423488          // 2^59
            + level * 4503599627370496            // 2^52
            + baseCell * 35184372088832;           // 2^45
    var digitSum = 0;
    var pow2_45_15 [15] = [
        1,               // r=15, shift=0  -> 2^0
        8,               // r=14, shift=3  -> 2^3
        64,              // r=13, shift=6
        512,             // r=12, shift=9
        4096,            // r=11, shift=12
        32768,           // r=10, shift=15
        262144,          // r=9,  shift=18
        2097152,         // r=8,  shift=21
        16777216,        // r=7,  shift=24
        134217728,       // r=6,  shift=27
        1073741824,      // r=5,  shift=30
        8589934592,      // r=4,  shift=33
        68719476736,     // r=3,  shift=36
        549755813888,    // r=2,  shift=39
        4398046511104    // r=1,  shift=42
    ];
    for (var r = 1; r <= 15; r++) {
        digitSum += digitEff[r-1] * pow2_45_15[15 - r];
    }
    reconstructed <== acc + digitSum;

    reconstructed === branchId;
}

component main { public [commitment, level, branchId] } = HexAncestry();
