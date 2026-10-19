# ISM4421NFLPicks — GridIron Edge

A static web app that recommends NFL bets (spread, over/under, and optionally moneyline) using statistics from previous weeks and a model that learns week to week.

## How it works

- **Data:** [nflverse games.csv](https://github.com/nflverse/nfldata), with every game since 1999, final scores, and closing odds. It's downloaded live on each page load, so new weeks show up automatically.
- **Team stats:** Elo rating (margin-of-victory adjusted), rolling points for/against, against-the-spread form, and over/under form, weighted toward recent games and regressed toward average each offseason.
- **Model:** three online logistic regressions (win, cover, over). They are trained walk-forward: predict a week, learn from its results, then go to the next week. The win model starts from the market's no-vig probability and learns adjustments on top of it.
- **Picks:** a bet is recommended when model probability × decimal odds − 1 ≥ your minimum edge. Stakes use quarter-Kelly, capped at 3% of bankroll.
- **Live betting splits:** a Netlify function (`netlify/functions/splits.mjs`) reads the [DraftKings Sportsbook betting splits](https://dknetwork.draftkings.com/draftkings-sportsbook-betting-splits/) page. For each upcoming game it returns the % of money (handle) and % of bets on each side of the moneyline, spread, and total. The app refreshes it every 5 minutes and flags "sharp" sides (money % ≥ 15 points above bets %) and "public" sides (≥ 70% of bets). Sportsbooks only publish percentages, not dollar totals.
- **Track record:** every past pick was made without seeing that week's results, so the season-by-season record is an honest out-of-sample backtest.

## Run locally

Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
```

The live betting splits need the Netlify function, so they only appear when deployed or when run with `netlify dev`.

To deploy on Netlify, import this repo. `netlify.toml` publishes the repo root and deploys the function, and no build command is needed. A Git-connected site redeploys on every push to `main`. Drag-and-drop deploys don't include functions.

## Caveat

Closing NFL lines are very efficient. In backtests this model is about as accurate as the market, not better, so treat the picks as a starting point for analysis rather than a guaranteed edge. Bet responsibly (1-800-GAMBLER).
