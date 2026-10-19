# ISM4421NFLPicks — GridIron Edge

A static web app that recommends NFL bets (spread, over/under, and optionally moneyline) using statistics from previous weeks and a model that learns week to week.

## How it works

- **Data:** [nflverse games.csv](https://github.com/nflverse/nfldata), with every game since 1999, final scores, and closing odds. It's downloaded live on each page load, so new weeks show up automatically.
- **Team stats:** Elo rating (margin-of-victory adjusted), rolling points for/against, against-the-spread form, and over/under form, weighted toward recent games and regressed toward average each offseason.
- **Model:** three online logistic regressions (win, cover, over). They are trained walk-forward: predict a week, learn from its results, then go to the next week. The win model starts from the market's no-vig probability and learns adjustments on top of it.
- **Picks:** a bet is recommended when model probability × decimal odds − 1 ≥ your minimum edge. Stakes use quarter-Kelly, capped at 3% of bankroll.
- **Track record:** every past pick was made without seeing that week's results, so the season-by-season record is an honest out-of-sample backtest.

## Run locally

Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
```

To deploy on Netlify, import this repo; no build command is needed and the publish directory is the repo root.

## Caveat

Closing NFL lines are very efficient. In backtests this model is about as accurate as the market, not better, so treat the picks as a starting point for analysis rather than a guaranteed edge. Bet responsibly (1-800-GAMBLER).
