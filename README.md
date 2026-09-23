# Meme Oven 🥐 — memes that buy PreStocks

**A live, on-chain radar of how much PreStocks demand memecoins create, and the open-source oven we used to bake one.**

Built for the PreStocks bounty of [Stocklana](https://hackathons.solana.com/hackathons/stocklana) by
[Meme Boulangerie](https://x.com/MemeBoulangerie), a tiny French meme bakery.

## The finding

Every StonkFun memecoin paired with a PreStocks token trades against that token. To buy the meme, you buy the
PreStock. The PreStock then sits in the meme's bonding curve, and after graduation in the meme's Raydium pool.
Nobody was measuring how big that is. So we did, on-chain, on 23 September 2026:

| | |
|---|---|
| PreStocks tokens held by memecoin curves and graduated meme pools | **$660k** |
| Share of the market value of all PreStocks tokens | **3.1%** |
| Share of POLYMARKET supply held by memes | **9.4%** |
| Share of OPENAI supply held by memes | **7.1%** |
| Share of FIGUREAI supply held by memes | **7.0%** |
| Memecoins paired with PreStocks on StonkFun | **5,304**, of which 211 graduated |
| Memecoins paired with SPACEX | **0**: StonkFun does not open that pair for launches yet |

**Live page: https://memeboulangerie.github.io/meme-oven/**, refreshed every six hours by a GitHub Action.

## Why it matters for PreStocks

- **Memes are a demand sink.** Each meme holds its PreStock for as long as it lives. Graduated memes turn that into
  permanent PreStock liquidity in Raydium pools.
- **Cashback memes keep buying.** Reward-mode memes convert a 1 to 3 percent transfer tax into the paired PreStock and
  airdrop it to holders, on every trade.
- **Memes are distribution.** A meme about Figure's robots puts FIGUREAI in front of degens who would never open a
  pre-IPO product page. The radar shows which names already have that crowd, and which ones don't.

## What's inside

| Folder | What it does |
|---|---|
| `radar/` | `radar.mjs` collects the data from three public sources and writes `docs/radar.json` and `docs/index.html`. Zero dependencies. |
| `docs/` | The live radar page and its data, served by GitHub Pages and refreshed by `.github/workflows/radar.yml`. |
| `launcher/` | `oven.mjs`, the exact code that launched Baker Bot on mainnet. Comments are in French: we are a French bakery. |
| `journal/lancements/` | The plan file Baker Bot was launched from: name, pair, tax, creator buy, announcement. |
| `case-study/` | Baker Bot, launch receipts and what happened in the first minutes. |

### Run the radar

```bash
node radar/radar.mjs
```

Node 20 or later, no key, about three minutes on the public Solana RPC. Set `RPC=` to use another endpoint.

**Method.** For each PreStocks token from the PreStocks API:
1. **Memes** come from the StonkFun public API: count, graduated, about to graduate, biggest and hottest meme.
2. **Curves** are the token accounts of that PreStock owned by the Raydium LaunchLab vault authority
   `WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh`, one `getProgramAccounts` call filtered on mint and owner.
3. **Graduated pools** are the Raydium CPMM pools holding that PreStock whose other token is a graduated StonkFun meme.
   PreStock/SOL pools and other non-meme pools are excluded. Memes that migrated to other pool types are not counted,
   so the figure is a floor.
4. **Value** is token amount times the PreStocks `tokenPrice`.

### The launcher

`launcher/oven.mjs` turns a plan file into a cashback memecoin paired with a PreStocks token, on StonkFun's Raydium
LaunchLab curve, with the creator buy in the same transaction. We built the transaction ourselves, following
StonkFun's "Building it yourself" guide against Raydium SDK 0.2.70.

- **Simulation first.** `simuler` builds and simulates the whole launch on mainnet without signing anything.
  `envoyer` is the only mode that sends, and the key never leaves the server.
- **SOL in, PreStock out.** For a PreStocks pair, SOL is converted through Jupiter first, with a price-impact cap and a
  slippage cap enforced in code, and the conversion is itself simulated before it is sent.
- **Caps live in the code, not in a click.** Creator buy at most 0.25 SOL, ten launches at most, a SOL reserve kept for
  fees, cashback only after a standard launch was adopted, a kill-switch file, and a plan can only be launched once.
- **Intent ledger.** Every step is written before it happens, so a crash never leaves a doubt about what was sent.
- **Robust sending.** Priority fee, rebroadcast every two seconds, rebuild on a fresh blockhash if the first one expires.
- **Human trigger.** In production, a person sends `/lancement <id>` to a private Telegram bot, reads the simulation and
  the announcement, then confirms with `/lancer <id> <code>`. The code refuses anything outside the plan.

## Case study: Baker Bot

A robot baker paired with FIGUREAI, 1 percent cashback, creator buy of 0.1 SOL disclosed in the description.
Launched on 23 September 2026 at 12:13 UTC, adopted by StonkFun two minutes later. Snipers bought about 14 percent of the
supply in the first blocks and dumped most of it within 90 seconds, paying the tax to holders on the way.
Receipts and timeline: [`case-study/baker-bot.md`](case-study/baker-bot.md).

## Honesty notes

- The radar reads public data and prints its method on the page. Anyone can rerun it and get the same numbers.
- Meme names are user-generated. The page masks a few words to stay presentable.
- Not affiliated with PreStocks, StonkFun, Raydium or any company listed. Memecoins are highly speculative.
  Nothing here is financial advice.

## License

MIT.
