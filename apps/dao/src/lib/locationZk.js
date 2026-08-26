// src/lib/locationZk.js
// ---------------------------------------------------------------------------
// The full ZK flow for declaring/revealing a location — adapted from
// zk/frontend-example/locationFlow.js (the contracts repo), BUT instead
// of the stub packH3Index() with fake numbers, this uses the REAL h3-js
// library — manually verified (see the accompanying discussion) that
// its 64-bit index format EXACTLY matches what
// zk/circuits/HexAncestry.circom expects (mode/resolution/baseCell/
// 15×3-bit digits, the official Uber H3 bit layout).
//
// Privacy: hexId and salt NEVER leave this browser (except mathematically
// hidden inside the ZK proof). They're stored only in this device's
// localStorage — if the user clears their browser data or switches to
// another device, they'll need to redeclare their location (a new
// commitment; the old declaration is lost forever until CHANGE_COOLDOWN).
//
// ⚠️ Same caveat as in the contracts: the verification key in zk/build/
// comes from a local, one-off, UNSAFE (for production) ceremony. Suitable
// only for the test deployment.

import * as h3 from "h3-js";
import { ethers } from "ethers";

const STORAGE_KEY = "hrdao_location_secret";
const ZK_WASM_PATH = "/zk/HexAncestry.wasm";
const ZK_ZKEY_PATH = "/zk/HexAncestry_final.zkey";

let _snarkjs = null;
let _poseidon = null;

// snarkjs and circomlibjs are lazy-loaded (dynamic import) — these are
// heavy WASM bundles, not needed on any page except Location.
async function _loadSnarkjs() {
  if (!_snarkjs) {
    _snarkjs = await import("snarkjs");
  }
  return _snarkjs;
}

async function _loadPoseidon() {
  if (!_poseidon) {
    const { buildPoseidon } = await import("circomlibjs");
    _poseidon = await buildPoseidon();
  }
  return _poseidon;
}

// ── Local secret (hexId + salt) ──────────────────────────────────────

export function getStoredSecret() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      hexId: BigInt(parsed.hexId),
      salt: BigInt(parsed.salt),
      resolution: parsed.resolution,
      h3IndexHex: parsed.h3IndexHex,
    };
  } catch (e) {
    console.warn("[locationZk] getStoredSecret failed:", e);
    return null;
  }
}

export function hasStoredSecret() {
  return getStoredSecret() !== null;
}

function _storeSecret({ hexId, salt, resolution, h3IndexHex }) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      hexId: hexId.toString(),
      salt: salt.toString(),
      resolution,
      h3IndexHex,
    }),
  );
}

export function clearStoredSecret() {
  localStorage.removeItem(STORAGE_KEY);
}

// ── Step 1: determine the browser's GPS coordinates ────────────────────

function _getPositionOnce(options) {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

/**
 * A two-tier attempt: first high accuracy (GPS chip, fast on a phone),
 * and if it doesn't complete in a reasonable time (typically on desktop
 * without GPS — geolocation falls back to WiFi/IP triangulation, which
 * is noticeably slower) — a second attempt without enableHighAccuracy
 * and with a longer timeout.
 */
export async function getBrowserPosition(onProgress) {
  if (!navigator.geolocation) {
    throw new Error("Geolocation isn't supported by this browser.");
  }
  onProgress?.("Determining precise (GPS) position...");
  try {
    return await _getPositionOnce({
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 0,
    });
  } catch (firstErr) {
    // code 3 = TIMEOUT, code 2 = POSITION_UNAVAILABLE — both worth
    // retrying with softer requirements. code 1 = PERMISSION_DENIED —
    // no point retrying, the user explicitly declined.
    if (firstErr?.code === 1) {
      throw new Error(
        "Geolocation access was denied by the browser. Allow geolocation for this site in your browser settings and try again.",
      );
    }
    onProgress?.(
      "GPS didn't complete in time — trying network geolocation (may take up to 30s)...",
    );
    try {
      return await _getPositionOnce({
        enableHighAccuracy: false,
        timeout: 30000,
        maximumAge: 60000,
      });
    } catch (secondErr) {
      if (secondErr?.code === 3) {
        throw new Error(
          "Failed to determine location in 42 seconds (both GPS and network geolocation timed out). Try again, ideally outdoors or with Wi-Fi enabled.",
        );
      }
      if (secondErr?.code === 2) {
        throw new Error(
          "Position unavailable — check that geolocation is enabled in your OS/browser settings.",
        );
      }
      throw secondErr;
    }
  }
}

// ── Step 2: compute the commitment locally and store the secret ────────

/**
 * @param resolution The H3 resolution to declare at (0..10, the
 *                    contract's MAX_RESOLUTION). The maximum (10) usually
 *                    makes sense — deeper levels are revealed ONLY
 *                    separately, at will (revealLevel).
 * @returns {Promise<{commitment: string, resolution: number, h3IndexHex: string}>}
 */
async function _commitFromCoords(latitude, longitude, resolution, onProgress) {
  const h3IndexHex = h3.latLngToCell(latitude, longitude, resolution);
  const hexId = BigInt("0x" + h3IndexHex);

  // A random salt — stays exclusively on this device.
  const salt = BigInt(ethers.hexlify(ethers.randomBytes(28))); // < 2^224, with room to spare in the BN254 field

  onProgress?.("Computing cryptographic commitment locally...");
  const poseidon = await _loadPoseidon();
  const commitment = poseidon.F.toString(poseidon([hexId, salt]));

  _storeSecret({ hexId, salt, resolution, h3IndexHex });

  return { commitment, resolution, h3IndexHex };
}

export async function determineLocation(resolution = 10, onProgress) {
  const position = await getBrowserPosition(onProgress);
  const { latitude, longitude } = position.coords;
  return _commitFromCoords(latitude, longitude, resolution, onProgress);
}

/**
 * A fallback path for when automatic browser geolocation doesn't work
 * at all (typically: the OS location service is disabled — on Windows
 * that's Settings → Privacy & Security → Location — or a VPN or
 * corporate network blocking WiFi triangulation). The user enters the
 * coordinates themselves; the rest of the flow (commitment, storing
 * the secret, revealing) is IDENTICAL to the automatic path.
 */
export async function determineLocationFromCoords(
  latitude,
  longitude,
  resolution = 10,
  onProgress,
) {
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    Number.isNaN(latitude) ||
    Number.isNaN(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new Error(
      "Invalid coordinates — latitude must be -90..90, longitude -180..180.",
    );
  }
  return _commitFromCoords(latitude, longitude, resolution, onProgress);
}

// ── Step 3: reveal a specific ancestor level (ZK proof) ─────────────────

/**
 * @param level The ancestor level to reveal (0..MAX_RESOLUTION).
 * @param onProgress Optional callback("generating proof...") for the UI.
 * @returns {Promise<{level:number, branchId:string, a,b,c: proof for the contract}>}
 */
export async function generateRevealProof(level, onProgress) {
  const secret = getStoredSecret();
  if (!secret) {
    throw new Error(
      "No stored location secret on this device — set your location first.",
    );
  }
  if (level > secret.resolution) {
    throw new Error(
      `Level ${level} is deeper than the declared resolution (${secret.resolution}) — can't be proven.`,
    );
  }

  const { hexId, salt } = secret;

  const poseidon = await _loadPoseidon();
  const commitment = poseidon.F.toString(poseidon([hexId, salt]));

  // The ancestor at the given level — official h3-js, guaranteed to
  // match what the contract will verify (the same algorithm as cellToParent()).
  const h3IndexHex = secret.h3IndexHex;
  const parentHex = level === secret.resolution ? h3IndexHex : h3.cellToParent(h3IndexHex, level);
  const branchId = BigInt("0x" + parentHex);

  onProgress?.("Generating ZK proof locally (may take a few seconds)...");
  const snarkjs = await _loadSnarkjs();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    {
      hexId: hexId.toString(),
      salt: salt.toString(),
      commitment,
      level: level.toString(),
      branchId: branchId.toString(),
    },
    ZK_WASM_PATH,
    ZK_ZKEY_PATH,
  );

  const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
  const [a, b, c] = JSON.parse(`[${calldata.split("][").join("],[")}]`).slice(0, 3);

  return { level, branchId: branchId.toString(), a, b, c };
}

// ── Helper: how many ancestor levels can be revealed (0..resolution) ────

export function availableLevelsToReveal() {
  const secret = getStoredSecret();
  if (!secret) return [];
  const levels = [];
  for (let r = 0; r <= secret.resolution; r++) levels.push(r);
  return levels;
}

/**
 * The local ancestor (branchId) at a given level for the stored secret —
 * the same h3.cellToParent used in generateRevealProof, factored out
 * separately so the on-chain status (nodeOverflowed) of a node at this
 * level can be checked PUBLICLY (with no ZK proof or reveal) even
 * BEFORE the user decides to reveal it.
 */
export function getLocalAncestor(level) {
  const secret = getStoredSecret();
  if (!secret) return null;
  if (level > secret.resolution) return null;
  const parentHex =
    level === secret.resolution
      ? secret.h3IndexHex
      : h3.cellToParent(secret.h3IndexHex, level);
  return BigInt("0x" + parentHex);
}

// ── Human-readable resolution description (for the UI) ──────────────────

export const RESOLUTION_DESCRIPTIONS = {
  0: "~1100 km (continent/very large region)",
  1: "~420 km",
  2: "~160 km",
  3: "~60 km (state/province)",
  4: "~23 km",
  5: "~8.5 km (city)",
  6: "~3.2 km (city district)",
  7: "~1.2 km",
  8: "~460 m (block)",
  9: "~175 m",
  10: "~65 m (building)",
};
