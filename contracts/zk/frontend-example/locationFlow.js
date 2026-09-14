/**
 * zk/frontend-example/locationFlow.js
 * ------------------------------------
 * Приклад повного флоу "кнопка визначити локацію" → ZK-приховане
 * зберігання → (опційно, пізніше) розкриття конкретного рівня.
 *
 * Залежності (npm): snarkjs, circomlibjs, ethers (чи viem — приклад на ethers v6).
 * Файли з zk/build/ (HexAncestry.wasm, HexAncestry_final.zkey) МАЮТЬ бути
 * доступні фронтенду статично (напр. /public/zk/...) — генерація доказу
 * відбувається В БРАУЗЕРІ КОРИСТУВАЧА, сирий hexId НІКОЛИ нікуди не
 * надсилається (ні на бекенд, ні в блокчейн).
 *
 * ⚠️ Це приклад/ескіз для інтеграції, не production-ready бібліотека —
 * обробку помилок, UI-стани завантаження тощо потрібно додати під ваш
 * фронтенд-стек.
 */

import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";
import { ethers } from "ethers";

// ── 1. Локальне обчислення H3-індексу з GPS-координат ──────────────
//
// У проді використовуйте офіційну бібліотеку h3-js (npm) для
// latLngToCell() — тут спрощений приклад структури (той самий формат,
// що й src/H3Utils.sol): mode(4б)=1, resolution(4б), base cell(7б),
// 15×3б digit-групи.
function packH3Index(resolution, baseCell, digits /* масив 15 чисел 0-7 */) {
  let idx = 1n << 59n; // mode = Cell
  idx |= BigInt(resolution) << 52n;
  idx |= BigInt(baseCell) << 45n;
  for (let r = 1; r <= 15; r++) {
    const digit = r <= resolution ? BigInt(digits[r - 1]) : 7n;
    const shift = BigInt((15 - r) * 3);
    idx |= digit << shift;
  }
  return idx;
}

// Предок на заданому рівні — та сама логіка, що H3Utils.sol/circuit.
function ancestorOf(hexId, resolution, level) {
  const mode = 1n;
  const baseCell = (hexId >> 45n) & 0x7fn;
  let out = (mode << 59n) | (BigInt(level) << 52n) | (baseCell << 45n);
  for (let r = 1; r <= 15; r++) {
    const shift = BigInt((15 - r) * 3);
    const digit = r <= level ? (hexId >> shift) & 0x7n : 7n;
    out |= digit << shift;
  }
  return out;
}

// ── 2. Обробник кнопки "Визначити локацію" ─────────────────────────
//
// Це ЄДИНЕ, що користувач бачить/натискає — уся крипто-механіка
// прихована всередині.
export async function onDetermineLocationClick({ signer, locationRegistryAddress, locationRegistryAbi }) {
  // 2.1. Дозвіл браузера на геолокацію (стандартний Web API, НЕ ончейн).
  const position = await new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true })
  );
  const { latitude, longitude } = position.coords;

  // 2.2. Локально порахувати H3-індекс на максимальній резолюції
  // (напр. через h3-js: const hexId = latLngToCell(latitude, longitude, 10)).
  // Тут — заглушка для ілюстрації формату (реальний проєкт підключає h3-js):
  const resolution = 10;
  const baseCell = 12; // приклад — реально обчислюється з lat/lng через h3-js
  const digits = Array(15).fill(3); // приклад
  const hexId = packH3Index(resolution, baseCell, digits);

  // 2.3. Випадковий salt (НІКОЛИ не покидає пристрій користувача, окрім
  // як усередині ZK-доказів, де він лишається прихованим математично).
  const salt = BigInt(ethers.hexlify(ethers.randomBytes(31))); // < 2^248, з запасом у полі BN254

  // 2.4. Poseidon-комітмент (той самий, що очікує circuit/контракт).
  const poseidon = await buildPoseidon();
  const commitment = poseidon.F.toString(poseidon([hexId, salt]));

  // 2.5. ЗБЕРЕГТИ hexId і salt ЛОКАЛЬНО (localStorage/IndexedDB/гаманець-
  // сумісне шифрове сховище) — вони знадобляться для КОЖНОГО майбутнього
  // revealAncestor(). Якщо користувач їх втратить — доведеться заново
  // визначати локацію (новий комітмент, стара decl. губиться назавжди,
  // до наступного дозволеного CHANGE_COOLDOWN).
  localStorage.setItem(
    "hrdao_location_secret",
    JSON.stringify({ hexId: hexId.toString(), salt: salt.toString(), resolution })
  );

  // 2.6. Записати КОМІТМЕНТ (не hexId!) ончейн.
  const contract = new ethers.Contract(locationRegistryAddress, locationRegistryAbi, signer);
  const tx = await contract.setLocationCommitment(commitment);
  await tx.wait();

  return { commitment, resolution };
}

// ── 3. Розкриття конкретного рівня (окрема дія, ЗА БАЖАННЯМ користувача
//       чи автоматично фронтендом, коли це стає корисним — напр. коли
//       effectiveHexFor "сусідів" показує, що каскад відкрився до N) ──
export async function revealLevel({ signer, locationRegistryAddress, locationRegistryAbi, level, wasmPath, zkeyPath }) {
  const secret = JSON.parse(localStorage.getItem("hrdao_location_secret"));
  if (!secret) throw new Error("Немає збереженої локації — спершу onDetermineLocationClick()");

  const hexId = BigInt(secret.hexId);
  const salt = BigInt(secret.salt);
  const declaredRes = secret.resolution;

  const poseidon = await buildPoseidon();
  const commitment = poseidon.F.toString(poseidon([hexId, salt]));
  const branchId = ancestorOf(hexId, declaredRes, level);

  // 3.1. Генерація ZK-доказу — ЛОКАЛЬНО, в браузері (WASM), займає
  // від часток секунди до кількох секунд залежно від пристрою. Ані
  // hexId, ані salt НІКУДИ не надсилаються — лише результат (proof +
  // публічні сигнали).
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    { hexId: hexId.toString(), salt: salt.toString(), commitment, level: level.toString(), branchId: branchId.toString() },
    wasmPath,  // напр. "/zk/HexAncestry.wasm"
    zkeyPath   // напр. "/zk/HexAncestry_final.zkey"
  );

  // 3.2. Конвертувати у формат, який очікує Solidity-верифікатор
  // (той самий porядок аргументів, що verifyProof(a,b,c,pubSignals)).
  const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
  const [a, b, c] = JSON.parse(`[${calldata.split("][").join("],[")}]`).slice(0, 3);

  // 3.3. Викликати revealAncestor() — контракт перевіряє ЛИШЕ математичний
  // доказ, сире значення так і лишається невідомим.
  const contract = new ethers.Contract(locationRegistryAddress, locationRegistryAbi, signer);
  const tx = await contract.revealAncestor(level, branchId.toString(), a, b, c);
  await tx.wait();

  return { level, branchId: branchId.toString() };
}
