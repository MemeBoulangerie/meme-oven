// Static page for the PreStocks Meme Radar (docs/index.html, served by GitHub Pages). No JavaScript needed to read it.
// Every string that comes from an API is escaped: meme names are user-generated.

const REPO_URL = process.env.REPO_URL || "https://github.com/";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const isMint = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s));
// meme names are user-generated: a light mask keeps the page presentable without hiding which coin it is
const mask = (s) => String(s ?? "").replace(/fuck|sex|shit|porn|butt/gi, (m) => m[0] + "*" + m.slice(2));
const usd = (x) => {
  if (x == null || !isFinite(x)) return "–";
  if (x >= 1e12) return `$${(x / 1e12).toFixed(2)}T`;
  if (x >= 1e9) return `$${(x / 1e9).toFixed(1)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  if (x >= 1e3) return `$${(x / 1e3).toFixed(x >= 1e5 ? 0 : 1)}k`;
  return `$${Math.round(x)}`;
};
const pct = (x, d = 2) => (x == null || !isFinite(x) ? "–" : `${(100 * x).toFixed(d)}%`);
const qty = (x) => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2));
const memeLink = (m) => (m && isMint(m.mint)
  ? `<a href="https://www.stonkfun.xyz/token/${m.mint}" rel="noopener">$${esc(mask(m.symbol))}</a> <span class="muted">${usd(m.marketCapUsd)}</span>`
  : '<span class="muted">none yet</span>');

export function renderPage(radar) {
  const t = radar.totals;
  const when = new Date(radar.generatedAt);
  const stamp = `${when.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const leader = [...radar.tokens].sort((a, b) => (b.held.shareOfSupply ?? 0) - (a.held.shareOfSupply ?? 0))[0];
  // a PreStock that StonkFun does not open for launches cannot have memes: say so instead of calling it an empty oven
  const closed = radar.tokens.filter((r) => r.launchable === false);
  const empty = radar.tokens.filter((r) => r.memes === 0 && r.launchable !== false);
  const rows = radar.tokens.map((r) => `
      <tr>
        <td><div class="tok"><img src="${esc(r.image)}" alt="" width="28" height="28" loading="lazy"><div><strong>${esc(r.name)}</strong><span class="muted">${esc(r.symbol)} · ${usd(r.valuationUsd)}${r.launchable === false ? " · not open for launches on StonkFun" : ""}</span></div></div></td>
        <td class="num">${r.memes.toLocaleString("en-US")}</td>
        <td class="num">${r.graduated}<span class="muted"> · ${pct(r.graduationRate, 1)}</span></td>
        <td class="num"><strong>${pct(r.held.shareOfSupply)}</strong><span class="muted"> ${qty(r.held.amount)} ${esc(r.symbol)}</span>
          <div class="bar" aria-hidden="true"><i style="width:${Math.min(100, (100 * (r.held.shareOfSupply ?? 0)) / Math.max(0.0001, leader.held.shareOfSupply ?? 0.0001)).toFixed(1)}%"></i></div></td>
        <td class="num">${usd(r.held.valueUsd)}<span class="muted"> curves ${usd(r.curves.valueUsd)} · pools ${usd(r.graduatedPools.valueUsd)}</span></td>
        <td>${memeLink(r.topMemes[0])}</td>
        <td>${memeLink(r.hottestMeme)}${r.hottestMeme ? ` <span class="muted">24h vol ${usd(r.hottestMeme.volume24hUsd)}</span>` : ""}</td>
      </tr>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PreStocks Meme Radar</title>
<meta name="description" content="How much PreStocks demand memecoins create, measured on-chain. By Meme Boulangerie.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,800&family=Inter:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#fbf6ee;--card:#fffdf8;--ink:#2b2118;--muted:#8a7a68;--line:#eadfce;--accent:#c9731c;--accent-soft:#f6e3cc;--good:#2f7d4f}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#17120d;--card:#1f1913;--ink:#f3ebe0;--muted:#a8977f;--line:#342a20;--accent:#e8964a;--accent-soft:#3a2a1a;--good:#6fcf97}}
:root[data-theme="dark"]{--bg:#17120d;--card:#1f1913;--ink:#f3ebe0;--muted:#a8977f;--line:#342a20;--accent:#e8964a;--accent-soft:#3a2a1a;--good:#6fcf97}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 Inter,system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1120px;margin:0 auto;padding:40px 16px 64px}
h1,h2{font-family:Fraunces,Georgia,serif;letter-spacing:-.01em;margin:0}
h1{font-size:clamp(30px,5vw,48px);line-height:1.1}
h2{font-size:24px;margin:48px 0 12px}
.lede{font-size:18px;max-width:720px;margin:14px 0 6px}
.muted{color:var(--muted);font-size:13px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:28px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}
.stat b{display:block;font-family:Fraunces,Georgia,serif;font-size:32px;color:var(--accent)}
.wrap{overflow-x:auto;border:1px solid var(--line);border-radius:14px;background:var(--card)}
table{border-collapse:collapse;width:100%;min-width:900px}
th,td{padding:12px 14px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600}
tr:last-child td{border-bottom:0}
td.num{white-space:nowrap}
td .muted{display:block}
.tok{display:flex;gap:10px;align-items:center}
.tok img{border-radius:8px;background:var(--accent-soft)}
.tok div{display:flex;flex-direction:column}
.bar{height:6px;background:var(--accent-soft);border-radius:4px;margin-top:6px;width:120px}
.bar i{display:block;height:100%;background:var(--accent);border-radius:4px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.callout{background:var(--accent-soft);border-radius:14px;padding:16px 18px;margin:18px 0}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
.step{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
.step b{color:var(--accent)}
footer{margin-top:48px;font-size:13px;color:var(--muted)}
code{font-size:12px;background:var(--accent-soft);padding:1px 5px;border-radius:5px;word-break:break-all}
</style>
</head>
<body>
<main>
  <p class="muted">🥐 by <a href="https://x.com/MemeBoulangerie">Meme Boulangerie</a> · updated ${esc(stamp)}</p>
  <h1>PreStocks Meme Radar</h1>
  <p class="lede">Every memecoin paired with a PreStocks token has to buy that token to exist. This page measures, on-chain, how much PreStocks supply memecoins are holding right now.</p>

  <section class="stats" aria-label="Totals">
    <div class="stat"><b>${usd(t.heldValueUsd)}</b>of PreStocks tokens held by memecoin curves and pools</div>
    <div class="stat"><b>${t.memes.toLocaleString("en-US")}</b>memecoins paired with PreStocks on StonkFun</div>
    <div class="stat"><b>${pct(t.heldValueUsd / t.prestocksMarketValueUsd, 1)}</b>of the market value of all PreStocks tokens, held by memes</div>
    <div class="stat"><b>${pct(leader.held.shareOfSupply, 1)}</b>of all ${esc(leader.symbol)} supply sits in memes, the highest share</div>
  </section>

  <div class="wrap">
  <table>
    <thead><tr><th>PreStocks token</th><th>Memes</th><th>Graduated</th><th>Supply held by memes</th><th>Value held</th><th>Biggest meme</th><th>Hottest meme, 24h</th></tr></thead>
    <tbody>${rows}
    </tbody>
  </table>
  </div>
${empty.length ? `
  <div class="callout"><strong>Empty oven:</strong> ${empty.map((r) => `${esc(r.name)} (${usd(r.valuationUsd)} valuation)`).join(", ")} ${empty.length > 1 ? "have no memecoin paired with their PreStocks tokens" : "has no memecoin paired with its PreStocks token"} yet.</div>` : ""}
${closed.length ? `
  <div class="callout"><strong>Not on the menu yet:</strong> ${closed.map((r) => `${esc(r.name)} (${usd(r.valuationUsd)} valuation)`).join(", ")} ${closed.length > 1 ? "are" : "is"} not open for launches on StonkFun, so no memecoin can pair with ${closed.length > 1 ? "them" : "it"} for now.</div>` : ""}

  <h2>How a meme buys PreStocks</h2>
  <div class="steps">
    <div class="step"><b>1. Buy the meme, buy the stock.</b><br>A StonkFun meme paired with a PreStocks token trades against it. Each purchase pays in that token, which lands in the meme's bonding curve.</div>
    <div class="step"><b>2. The curve holds it.</b><br>Until graduation, the tokens stay in a Raydium LaunchLab vault. After graduation they move into the meme's Raydium CPMM pool and stay there as liquidity.</div>
    <div class="step"><b>3. Cashback buys more.</b><br>Cashback memes charge a transfer tax of 1 to 3 percent, converted into the PreStocks token and airdropped to holders.</div>
  </div>

  <h2>Bake one</h2>
  <p>We don't just measure it. On 23 September 2026 we launched <a href="https://www.stonkfun.xyz/token/4Wuy4sVcTiY5Ek7s37f8YUZE2DEuET7262fHcydH4Lz4">Baker Bot ($BAKERBOT)</a>, a cashback meme paired with FIGUREAI, with our open-source launcher: plan file, mandatory simulation, hard caps in code, SOL converted to the PreStocks token, one Telegram command. Code and receipts: <a href="${esc(REPO_URL)}">${esc(REPO_URL.replace(/^https:\/\//, ""))}</a>.</p>

  <footer>
    <p><strong>Method.</strong> Curves: ${esc(radar.method.curves)}. Graduated pools: ${esc(radar.method.graduatedPools)}; memes that migrated to other pool types are not counted, so the figure is a floor. Value: ${esc(radar.method.value)}.
    Sources: <a href="${esc(radar.sources.prestocks)}">PreStocks API</a>, <a href="https://www.stonkfun.xyz/developers">StonkFun public API</a>, Solana RPC. All public, no key. Meme names are user-generated and lightly masked.</p>
    <p>Not affiliated with PreStocks, StonkFun or any company listed. Memecoins are highly speculative. Nothing here is financial advice.</p>
  </footer>
</main>
</body>
</html>
`;
}
