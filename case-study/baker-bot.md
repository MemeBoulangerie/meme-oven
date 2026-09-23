# Baker Bot ($BAKERBOT), launch receipts

A robot baker that bakes all day, paired with the FIGUREAI PreStocks token. 1 percent of every transfer is converted
into FIGUREAI and airdropped to holders. Creator buy: 0.1 SOL, disclosed in the token description.

| | |
|---|---|
| Mint | [`4Wuy4sVcTiY5Ek7s37f8YUZE2DEuET7262fHcydH4Lz4`](https://solscan.io/token/4Wuy4sVcTiY5Ek7s37f8YUZE2DEuET7262fHcydH4Lz4) |
| Curve pool | [`A7Ltrx2ffNnSTtZa1EdAuhmRLPaDGk33angGJW8gxRCt`](https://solscan.io/account/A7Ltrx2ffNnSTtZa1EdAuhmRLPaDGk33angGJW8gxRCt) |
| Pair | FIGUREAI, `PreZad18qfPtbxNpMtMuAuX2zVpvkEU8DnJx56faCWd` |
| Token page | [stonkfun.xyz/token/4Wuy…4Lz4](https://www.stonkfun.xyz/token/4Wuy4sVcTiY5Ek7s37f8YUZE2DEuET7262fHcydH4Lz4) |
| Plan file | [`journal/lancements/baker-bot.json`](../journal/lancements/baker-bot.json) |

## Timeline, 23 September 2026 (UTC)

| Time | Step | Receipt |
|---|---|---|
| 11:49:36 | SOL converted into 0.0641 FIGUREAI through Jupiter | [3u2h3fhT…aVtmp](https://solscan.io/tx/3u2h3fhTzRphZfxTQy4wuR5naMsXTAASxPz9uJVeNPz7MkVLSJ1fQaGKsk3ciwAme3bzUQrm4voHFqdEEAMaVtmp) |
| 11:49:36 | First launch sent, expired without being included: priority fee too low | never landed, mint unused |
| 12:13:20 | Relaunch: FIGUREAI already held, conversion skipped instead of paying the impact twice | |
| 12:13:22 | Create and creator buy confirmed in one transaction | [5aVdWQR9…Nm8t](https://solscan.io/tx/5aVdWQR9pjARvmdsMoW8Z7SmGVNDuyrbni7ZYVEatDjotoAypzeBxXE5U53uMBM28szifhJvW7cz77wJepHhNm8t) |
| 12:15:03 | Adopted by StonkFun: token page, chart and holder rewards live | |

## What the first minutes looked like

- In the first 4 seconds, 47 sniper transactions failed.
- The bots that got in bought about 14 percent of the supply in the first blocks.
- Three of them sold most of it between 12:14:24 and 12:14:52, about 90 seconds after launch, because nobody was
  buying behind them.
- Every one of those buys and sells paid the 1 percent transfer tax, which goes to holders as FIGUREAI.

Our earlier test launch, clearly labelled "please do not buy", attracted no buyer at all, not even a bot. A real name
and a real pair is what brings the snipers.

## What we learned

- **Priority fees matter more than the code.** The first send expired at 0.00006 SOL of priority while the Jupiter
  conversion, at 0.0002 SOL, landed in two seconds. The launcher now pays 0.0003 SOL, rebroadcasts every two seconds and
  rebuilds on a fresh blockhash.
- **Never pay the conversion twice.** Between the two attempts the price impact of the SOL to FIGUREAI route went from
  0.3 to 3.5 percent. The launcher now reuses a conversion it already confirmed, straight from its intent ledger.
- **StonkFun adoption is automatic.** A launch built by hand with StonkFun's platform id is picked up within minutes.
  Its `/tokens/{mint}` endpoint does not serve LaunchLab tokens; `/launches?creator=` does.
