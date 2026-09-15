// src/lib/publicId.js
//
// A compact, reversible, NON-HEX encoding of an EVM address — used as the
// fallback public identifier (in the /card/:id URL, the QR code, and the
// on-card display) for members who don't have a Lens/ENS name to show
// instead (see identity.js's buildPublicCardId/resolveAddressFromPublicId).
//
// ⚠️ This is NOT encryption or access control — it's plain base58 of the
// same 160 bits, fully reversible by anyone who reads this file. That's
// on purpose: the actual goal (see the card-link discussion this was
// built for) isn't hiding the address from a determined developer, it's
// making sure a CASUAL visitor doesn't see a "0x..."-shaped string and
// reflexively paste it into their own wallet's "Send" field — bypassing
// TipJar's tip()/split entirely. A wallet's send screen expects
// "0x" + 40 hex chars; a base58 string like "8vNK3fQmZ2..." simply won't
// paste in as a valid address, which is enough friction for that
// accidental-direct-send case. Old links/QR codes printed with the raw
// address keep working regardless — see resolveAddressFromPublicId()'s
// "already a real address" branch in identity.js.
//
// Same alphabet as Bitcoin's base58 (no 0/O/I/l — those look alike in
// most fonts, and this is meant to be read off a phone screen or a
// printed card).

import { ethers } from "ethers";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE = BigInt(ALPHABET.length);
const CODE_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** address ("0x...", 20 bytes) -> base58 code (no "0x", ~28 chars) */
export function encodeAddressCode(address) {
  if (!ethers.isAddress(address)) return null;
  let n = BigInt(address);
  if (n === 0n) return ALPHABET[0];
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % BASE)] + out;
    n /= BASE;
  }
  return out;
}

/** base58 code -> checksummed address, or null if it isn't a valid code */
export function decodeAddressCode(code) {
  if (!code || !CODE_RE.test(code)) return null;
  let n = 0n;
  for (const ch of code) {
    n = n * BASE + BigInt(ALPHABET.indexOf(ch));
  }
  const hex = n.toString(16);
  if (hex.length > 40) return null; // more than 160 bits — not one of ours
  try {
    return ethers.getAddress("0x" + hex.padStart(40, "0"));
  } catch {
    return null; // shouldn't happen once length is checked, but be safe
  }
}

/** Shortened display form, e.g. "8vNK3f…mZ2Q" — same idea as truncAddr() */
export function truncCode(code, front = 6, back = 4) {
  if (!code || code.length <= front + back + 1) return code || "";
  return `${code.slice(0, front)}…${code.slice(-back)}`;
}
