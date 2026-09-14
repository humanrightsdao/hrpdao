// build_input.js — генерує валідний тестовий вхід для zk/circuits/HexAncestry.circom
// Запуск: node build_input.js  (з кореня проєкту, після npm install circomlibjs)
const circomlibjs = require("circomlibjs");
const fs = require("fs");

async function main() {
  const poseidon = await circomlibjs.buildPoseidon();
  const F = poseidon.F;

  const mode = 1n;
  const declaredRes = 5n;
  const baseCell = 42n;
  const level = 3n;

  const digits = [];
  for (let r = 1; r <= 15; r++) {
    digits.push(BigInt((r * 3) % 6));
  }

  let hexId = mode * (1n << 59n) + declaredRes * (1n << 52n) + baseCell * (1n << 45n);
  for (let r = 1; r <= 15; r++) {
    const shift = BigInt((15 - r) * 3);
    hexId += digits[r - 1] * (1n << shift);
  }

  const salt = 123456789n;
  const commitment = F.toObject(poseidon([hexId, salt]));

  let acc = mode * (1n << 59n) + level * (1n << 52n) + baseCell * (1n << 45n);
  let digitSum = 0n;
  for (let r = 1; r <= 15; r++) {
    const shift = BigInt((15 - r) * 3);
    const isKept = BigInt(r) <= level;
    const digitEff = isKept ? digits[r - 1] : 7n;
    digitSum += digitEff * (1n << shift);
  }
  const branchId = acc + digitSum;

  const input = {
    commitment: commitment.toString(),
    level: level.toString(),
    branchId: branchId.toString(),
    hexId: hexId.toString(),
    salt: salt.toString(),
  };

  fs.writeFileSync("input.json", JSON.stringify(input, null, 2));
  console.log("Written input.json:");
  console.log(input);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
