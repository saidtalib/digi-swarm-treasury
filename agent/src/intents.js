// NEAR Intents 1Click API: real mainnet quotes, always with dry: true (no deposit address is issued,
// nothing can be executed). The quote digest is what the coordinator asks the contract to authorise.
import { sha256 } from './near.js';

const API = process.env.ONECLICK_API || 'https://1click.chaindefuser.com';
export const ASSETS = {
  'near:usdc': 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  'base:usdc': 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  'arb:usdc': 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
};
// Refund address for the dry quote: Digi's public NEAR account (no funds are moved by a dry quote).
export const REFUND_TO = process.env.INTENTS_REFUND_TO || '82013a12a4a1c07b8bbbdb7ad9c0ed4b67aed738faff338946d43dba840be733';

export async function dryQuote({ toChain, recipient, usdcAmount }) {
  const body = {
    dry: true,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: ASSETS['near:usdc'],
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: ASSETS[`${toChain}:usdc`],
    amount: String(Math.round(usdcAmount * 1e6)),
    refundTo: REFUND_TO,
    refundType: 'ORIGIN_CHAIN',
    recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };
  const headers = { 'content-type': 'application/json' };
  if (process.env.ONECLICK_JWT) headers.authorization = `Bearer ${process.env.ONECLICK_JWT}`;
  const r = await fetch(`${API}/v0/quote`, { method: 'POST', headers, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok || !j.quote) throw new Error(`1Click quote failed: ${j.message || r.status}`);
  if (j.quote.depositAddress) throw new Error('refusing: got a live deposit address, expected a dry quote');
  return { quote: j.quote, digest: sha256(JSON.stringify({ q: j.quote, sig: j.signature })), signature: j.signature };
}
