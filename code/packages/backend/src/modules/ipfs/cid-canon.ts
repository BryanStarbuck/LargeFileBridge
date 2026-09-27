// CID CANONICALIZATION — pure math, no I/O, no service imports. A LEAF so the merge worker thread
// (merge-worker.ts) can apply the exact same rule the event loop does; ipfs.service.ts re-exports it.
import { log } from "../../shared/logging.js";

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"; // RFC 4648 lower, no padding (multibase 'b')

function base58btcDecode(s: string): Uint8Array {
  const bytes: number[] = [0];
  for (const ch of s) {
    let carry = B58_ALPHABET.indexOf(ch);
    if (carry < 0) throw new Error(`bad base58 char: ${ch}`);
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let k = 0; k < s.length && s[k] === "1"; k++) bytes.push(0); // leading-zero bytes
  return Uint8Array.from(bytes.reverse());
}

function base32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of data) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Normalize any CID to its canonical CIDv1 base32 string so two encodings of the SAME block compare equal
 * (knowledge/ipfs.mdx §5.1). A CIDv0 is always base58btc(multihash) with an implied dag-pb (0x70) codec;
 * we re-wrap it as v1 (0x01) + dag-pb (0x70) + multihash and base32-encode with the multibase 'b' prefix.
 * Anything already CIDv1 (`bafy…`/`bafk…`) or unrecognized is returned unchanged (best-effort — never throws).
 */
/** CIDv0 (`Qm…`) → CIDv1 base32 (`b…`); anything else passes through. Never throws. */
export function canonicalCid(cid: string): string {
  try {
    if (!cid.startsWith("Qm")) return cid; // already CIDv1 (or a form we leave as-is)
    const mh = base58btcDecode(cid);
    const bytes = new Uint8Array(mh.length + 2);
    bytes[0] = 0x01; // CIDv1
    bytes[1] = 0x70; // dag-pb (a CIDv0 is always dag-pb)
    bytes.set(mh, 2);
    return "b" + base32Encode(bytes);
  } catch (e) {
    log.debug("ipfs", `canonicalCid passthrough for ${cid}: ${(e as Error).message}`);
    return cid;
  }
}

