#!/usr/bin/env node
// PreStocks Meme Radar — how much PreStocks demand do memecoins create?
//
// A StonkFun memecoin paired with a PreStocks token trades against it. Buying the meme means buying the PreStock,
// and that PreStock sits in the meme's bonding curve (Raydium LaunchLab) until graduation, then in the meme's
// Raydium CPMM pool. Cashback ("reward") memes also convert a transfer tax into the PreStock for their holders.
// This script measures it, on-chain, for every PreStocks token.
//
// Sources, all public, no key:
//   PreStocks API  https://prestocks.com/api/prestocks        tokens, supply, price, valuation
//   StonkFun API   https://www.stonkfun.xyz/api/public/v1     memes per pair, graduation, market caps
//   Solana RPC     token accounts held by the LaunchLab vault authority, and Raydium CPMM pools of graduated memes
//
// Usage:  node radar/radar.mjs            writes docs/radar.json and docs/index.html
//         RPC=https://... node radar/radar.mjs   to use another Solana RPC (default: the public mainnet endpoint)
// Zero dependencies (Node 20+).

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPage } from "./page.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs");
const PRESTOCKS_API = "https://prestocks.com/api/prestocks";
const STONKFUN_API = "https://www.stonkfun.xyz/api/public/v1";
const RPC = process.env.RPC || "https://api.mainnet-beta.solana.com";

// Raydium LaunchLab: every bonding-curve vault is a token account owned by this PDA of program
// LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj (seed "vault_auth_seed"), checked against the Raydium SDK on 23/09/2026.
const LAUNCHLAB_VAULT_AUTH = "WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh";
// Raydium CPMM, where LaunchLab memes graduate. PoolState layout after the 8-byte discriminator:
// amm_config 8 · pool_creator 40 · token_0_vault 72 · token_1_vault 104 · lp_mint 136 · token_0_mint 168 · token_1_mint 200.
const CPMM_PROGRAM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const CPMM_POOL_SIZE = 637;

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const log = (...a) => console.error(...a);

// ——— tiny base58 encoder, to read public keys out of raw account bytes without a dependency ———
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}

// ——— HTTP helpers with polite retries (public endpoints rate-limit bursts) ———
async function getJson(url, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": "prestocks-meme-radar/1.0", accept: "application/json" } });
      if (r.ok) return await r.json();
      log(`  ${r.status} on ${url.slice(0, 90)} (try ${i})`);
    } catch (e) { log(`  ${e.message} on ${url.slice(0, 90)} (try ${i})`); }
    await sleep(2000 * i);
  }
  throw new Error(`giving up on ${url}`);
}
async function rpc(method, params, tries = 6) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const j = await r.json();
      if (j.result !== undefined) return j.result;
      log(`  rpc ${method}: ${JSON.stringify(j.error).slice(0, 120)} (try ${i})`);
    } catch (e) { log(`  rpc ${method}: ${e.message} (try ${i})`); }
    await sleep(2500 * i);
  }
  throw new Error(`rpc ${method} failed`);
}

// ——— StonkFun ———
const stonk = async (query) => {
  const j = await getJson(`${STONKFUN_API}/tokens?${query}`);
  const d = j.data ?? j;
  return { tokens: d.tokens ?? [], total: d.pagination?.total ?? 0 };
};
async function allGraduated(mint) {
  const out = [];
  for (const mode of ["reward", "standard"]) {
    for (let page = 1; page <= 20; page++) {
      const { tokens, total } = await stonk(`quoteMint=${mint}&status=graduated&mode=${mode}&pageSize=100&page=${page}`);
      out.push(...tokens);
      if (page * 100 >= total || !tokens.length) break;
    }
  }
  return out;
}
const memeView = (t) => ({
  mint: t.mint, symbol: t.symbol, name: t.name, status: t.status, mode: t.mode,
  marketCapUsd: Math.round(t.market?.marketCapUsd ?? 0), peakMarketCapUsd: Math.round(t.market?.peakMarketCapUsd ?? 0),
  volume24hUsd: Math.round(t.market?.volume24hUsd ?? 0), imageUrl: t.imageUrl ?? null, createdAt: t.createdAt ?? null,
});

// ——— on-chain ———
async function heldByCurves(mint, tokenProgram) {
  // every token account of this PreStock owned by the LaunchLab vault authority = a meme bonding curve's quote vault
  const accounts = await rpc("getProgramAccounts", [tokenProgram, {
    encoding: "jsonParsed",
    filters: [{ memcmp: { offset: 0, bytes: mint } }, { memcmp: { offset: 32, bytes: LAUNCHLAB_VAULT_AUTH } }],
  }]);
  const amounts = accounts.map((a) => +a.account.data.parsed.info.tokenAmount.uiAmountString).filter((x) => x > 0);
  return { vaults: accounts.length, funded: amounts.length, amount: amounts.reduce((a, b) => a + b, 0) };
}
async function heldByGraduatedPools(mint, graduatedMints) {
  // Raydium CPMM pools holding this PreStock whose other token is a graduated StonkFun meme
  const pools = [];
  for (const offset of [168, 200]) {
    const res = await rpc("getProgramAccounts", [CPMM_PROGRAM, {
      encoding: "base64", dataSlice: { offset: 72, length: 160 },
      filters: [{ dataSize: CPMM_POOL_SIZE }, { memcmp: { offset, bytes: mint } }],
    }]);
    for (const p of res) {
      const b = Buffer.from(p.account.data[0], "base64");
      const key = (o) => base58(b.subarray(o, o + 32));
      const [vault0, vault1, mint0, mint1] = [key(0), key(32), key(96), key(128)];
      const other = mint0 === mint ? mint1 : mint0;
      pools.push({ pool: p.pubkey, other, vault: mint0 === mint ? vault0 : vault1, isMeme: graduatedMints.has(other) });
    }
    await sleep(1200);
  }
  const memePools = pools.filter((p) => p.isMeme);
  let amount = 0;
  for (let i = 0; i < memePools.length; i += 100) {
    const res = await rpc("getMultipleAccounts", [memePools.slice(i, i + 100).map((p) => p.vault), { encoding: "jsonParsed" }]);
    for (const a of res.value) amount += +(a?.data?.parsed?.info?.tokenAmount?.uiAmountString ?? 0);
  }
  return { pools: memePools.length, otherPools: pools.length - memePools.length, amount };
}

// ——— main ———
const started = new Date();
log(`PreStocks Meme Radar — ${started.toISOString()}`);
const prestocks = await getJson(PRESTOCKS_API);
// Pairs open for launches on StonkFun: a PreStock missing from this list cannot have memes yet
// (SPACEX was missing on 23/09/2026, which is why it had zero memes, not because nobody tried).
let launchable = null;
try {
  const j = await getJson(`${STONKFUN_API}/pairs?launchable=true`);
  const list = j.data?.pairs ?? j.pairs ?? j.data ?? j;
  launchable = new Set((Array.isArray(list) ? list : []).map((x) => x.mint));
} catch { log("  launchable pairs unavailable, skipping that flag"); }
const rows = [];
for (const p of prestocks) {
  const mint = p.contract_address;
  log(`${p.symbol} …`);
  const all = await stonk(`quoteMint=${mint}&sort=marketCap&pageSize=5`);
  const hot = await stonk(`quoteMint=${mint}&sort=volume&pageSize=1`);
  const soon = await stonk(`quoteMint=${mint}&status=aboutToGraduate&pageSize=1`);
  const graduated = await allGraduated(mint);
  const info = await rpc("getAccountInfo", [mint, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
  const tokenProgram = info.value.owner;
  const curves = await heldByCurves(mint, tokenProgram);
  await sleep(1500);
  const pools = await heldByGraduatedPools(mint, new Set(graduated.map((t) => t.mint)));
  await sleep(1500);
  const price = +p.tokenPrice;
  const heldAmount = curves.amount + pools.amount;
  rows.push({
    symbol: p.symbol, name: p.name.replace(/\s*PreStocks$/i, ""), mint, image: p.image, url: p.external_url,
    price, valuationUsd: +p.markValuation, supply: +p.supply,
    launchable: launchable ? launchable.has(mint) : null,
    memes: all.total, graduated: graduated.length, aboutToGraduate: soon.total,
    graduationRate: all.total ? graduated.length / all.total : null,
    topMemes: all.tokens.map(memeView), hottestMeme: hot.tokens[0] ? memeView(hot.tokens[0]) : null,
    curves: { ...curves, valueUsd: curves.amount * price },
    graduatedPools: { ...pools, valueUsd: pools.amount * price },
    held: { amount: heldAmount, valueUsd: heldAmount * price, shareOfSupply: p.supply ? heldAmount / p.supply : null },
  });
}
rows.sort((a, b) => b.held.valueUsd - a.held.valueUsd);
const totals = {
  memes: rows.reduce((s, r) => s + r.memes, 0),
  graduated: rows.reduce((s, r) => s + r.graduated, 0),
  heldValueUsd: rows.reduce((s, r) => s + r.held.valueUsd, 0),
  curveValueUsd: rows.reduce((s, r) => s + r.curves.valueUsd, 0),
  poolValueUsd: rows.reduce((s, r) => s + r.graduatedPools.valueUsd, 0),
  prestocksMarketValueUsd: rows.reduce((s, r) => s + r.supply * r.price, 0),
};
const radar = {
  generatedAt: started.toISOString(),
  sources: { prestocks: PRESTOCKS_API, stonkfun: STONKFUN_API, rpc: RPC.includes("api-key") ? "private RPC" : RPC },
  method: {
    curves: `token accounts of each PreStock owned by the Raydium LaunchLab vault authority ${LAUNCHLAB_VAULT_AUTH}`,
    graduatedPools: `Raydium CPMM pools (${CPMM_PROGRAM}) holding the PreStock whose other token is a graduated StonkFun meme`,
    value: "token amount × PreStocks tokenPrice",
  },
  totals, tokens: rows,
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "radar.json"), JSON.stringify(radar, null, 1));
writeFileSync(join(OUT, "index.html"), renderPage(radar));
log(`done in ${Math.round((Date.now() - started) / 1000)} s → docs/radar.json, docs/index.html`);
for (const r of rows) {
  log(`${r.symbol.padEnd(11)} memes ${String(r.memes).padStart(5)} · graduated ${String(r.graduated).padStart(3)} · held ${r.held.amount.toFixed(2)} (${(100 * (r.held.shareOfSupply ?? 0)).toFixed(2)} % of supply, $${Math.round(r.held.valueUsd)})`);
}
