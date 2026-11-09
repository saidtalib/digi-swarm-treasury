// NEAR Chain Signatures: derive the EVM address that a NEAR account controls through the MPC network.
// Read-only view call; no signature is requested in this demo.
import bs58 from 'bs58';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { view } from './near.js';

export const MPC_CONTRACT = process.env.MPC_CONTRACT || 'v1.signer-prod.testnet';
export const PAYOUT_PATH = 'digi-payout';

export async function deriveEvmAddress(predecessor, path = PAYOUT_PATH) {
  const pk = await view(MPC_CONTRACT, 'derived_public_key', { path, predecessor });
  const raw = bs58.decode(String(pk).replace('secp256k1:', '')); // 64 bytes: x || y
  if (raw.length !== 64) throw new Error(`unexpected MPC key length ${raw.length}`);
  const hash = keccak_256(raw);
  const hex = Buffer.from(hash.slice(-20)).toString('hex');
  return toChecksum(hex);
}

function toChecksum(hexLower) {
  const h = Buffer.from(keccak_256(Buffer.from(hexLower, 'ascii'))).toString('hex');
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? hexLower[i].toUpperCase() : hexLower[i];
  return out;
}
