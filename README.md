# ISM4421NFLPicks — GridIron Edge

A static web app that recommends NFL bets (spread, over/under, and optionally moneyline) using statistics from previous weeks and a model that learns week to week.

## How it works

- **Data:** [nflverse games.csv](https://github.com/nflverse/nfldata), with every game since 1999, final scores, and closing odds. It's downloaded live on each page load, so new weeks show up automatically.
- **Team stats:** Elo rating (margin-of-victory adjusted), rolling points for/against, against-the-spread form, and over/under form, weighted toward recent games and regressed toward average each offseason.
- **Model:** three online logistic regressions (win, cover, over). They are trained walk-forward: predict a week, learn from its results, then go to the next week. The win model starts from the market's no-vig probability and learns adjustments on top of it.
- **Picks:** a bet is recommended when model probability × decimal odds − 1 ≥ your minimum edge. Stakes use quarter-Kelly, capped at 3% of bankroll.
- **Live betting splits:** a Netlify function (`netlify/functions/splits.mjs`) reads the [DraftKings Sportsbook betting splits](https://dknetwork.draftkings.com/draftkings-sportsbook-betting-splits/) page. For each upcoming game it returns the % of money (handle) and % of bets on each side of the moneyline, spread, and total. The app refreshes it every 5 minutes and flags "sharp" sides (money % ≥ 15 points above bets %) and "public" sides (≥ 70% of bets). Sportsbooks only publish percentages, not dollar totals.
- **Track record:** every past pick was made without seeing that week's results, so the season-by-season record is an honest out-of-sample backtest.

## Pages

- **Game picks** (`index.html`): the game model's spread, total, and moneyline picks. Every pick, and every side of every upcoming game, has **Track** and **+ Parlay** buttons.
- **Player props** (`props.html`): **Top plays** lists what each player will most likely do (median and typical range) and the chance and fair odds of common milestones (50+ rushing yards, 5+ catches, anytime TD), with no sportsbook line needed. **Player outlook** shows every prop for one player next to his recent games, and a **Model report card** shows how last week's and this season's projections held up. A calculator prices any sportsbook line (win chance, fair odds, edge, quarter-Kelly stake). Saved props are re-priced on every load and ranked as suggestions, and past props are graded against what the model said before kickoff.
- **My bets** (`bets.html`): every bet and parlay you track or add by hand, with record, profit, ROI, and a running-profit chart. Odds, stake, and result can be edited in place. Bets and parlay legs tracked from the picks pages settle automatically from final scores and stat lines.
- **Parlay slip** (every page, `track.js`): **+ Parlay** adds a leg, and the slip shows combined odds, the model's chance (product of legs, with a warning for same-game legs), edge, and payout. Tracking saves the parlay and its legs in one transaction (`create_parlay`). A parlay loses on any lost leg, and pushed or voided legs drop out of the payout.

## Ask the model (chatbot)

The Player props page has an **Ask the model** panel (bottom right) where a signed-in user asks in plain English whether the model likes a prop or parlay. The AI only words the answer: every number comes from this site's model.

- **Where things run.** `chat.js` (the panel) sends the question to the Supabase Edge Function `ask-model` (`supabase/functions/ask-model/`), which calls the AI provider. When the AI asks for numbers, the function hands the tool call back to the page, and `chat-tools.js` answers it with `props-model.js` and the projections and saved props the page already loaded. The model code exists in one place, so the chatbot can't drift from the rest of the site.
- **Tools:** `find_player`, `get_projection` (most likely, typical range, fair line), `price_prop` (win chance, break-even, edge, suggested stake, verdict), `price_parlay` (each leg, combined chance vs. the payout, and whether singles are better) and `top_suggestions`. A missing line or odds comes from the user's saved props (best edge first), otherwise the AI asks for it. Verdicts follow the site's rules: suggested only at or above the user's minimum edge, otherwise Pass. Edges of 15% or more get a "check news" warning (`chat_config.news_flag_edge`), and players with fewer than 4 games get a little-history note.
- **Privacy.** The provider gets only the question (emails, phone numbers and dollar amounts removed), a short history, and tool results. Stakes go to the AI as a % of bankroll with a token like `[[S1]]` that the page replaces with dollars, so the bankroll never leaves the browser. The panel says that questions go to a third-party AI service, and shows 1-800-GAMBLER.
- **Providers.** Google Gemini `gemini-3.5-flash-lite` (free tier) first, then Groq `openai/gpt-oss-120b` (free tier) when Gemini is rate limited. A provider that answers "rate limited" is skipped until its cooldown ends (`chat_provider_state`). If both are, the panel says chat is busy and links to Price a prop. The order lives in `chat_config.providers`. To switch to Claude later, store a key with `select vault.create_secret('<key>', 'anthropic_api_key');` and put `{"provider": "anthropic", "model": "claude-haiku-5-5", "key": "anthropic_api_key"}` first in that list. The adapter is already in `core.ts`.
- **Keys** are in Supabase Vault (`gemini_api_key`, `groq_api_key`), readable only by the Edge Function through `chat_provider_key()`. To replace one: `select vault.update_secret((select id from vault.secrets where name = 'gemini_api_key'), '<new key>');`
- **Limits.** 30 questions per user per day (Eastern), 3 past exchanges of history, and at most 4 AI calls per question, all in `chat_config`. Busy or failed questions don't count.
- **Capacity.** Measured at launch: about 4,000 tokens and 2 AI calls per question. Gemini's free tier (about 500 requests a day, see AI Studio for the exact number) covers roughly 250 questions a day, and Groq's (200,000 tokens a day, 8,000 a minute) adds about 55 more, at most about 2 a minute.
- **Usage.** Every AI call is logged in `chat_log` (provider, model, tokens, status, no question text). In the SQL editor, `select * from chat_usage_today;` shows today's requests and tokens against the free-tier limits, and `chat_usage_daily` shows the history.
- **Deploy.** The function deploys with the Supabase CLI (`supabase functions deploy ask-model`) or the dashboard. The tables are in `supabase/migrations/20261107000000_ask_model_chat.sql`.

## Sportsbook lines

Upcoming games are priced at Hard Rock Bet (and Hard Rock FL), DraftKings, FanDuel, BetMGM, theScore Bet, BetRivers, and Bovada (plus Caesars and Fanatics when listed). Supabase fetches them from The Odds API every 12 hours, September through February. A `pg_cron` job (`refresh-nfl-odds`) runs `public.refresh_odds('nfl')` and caches the result in `nfl_odds_cache`. The API key is stored encrypted in Supabase Vault, never in this repo, and is shared with the college football site (500 free credits a month, about 415 used between the two). Picks use the book with the best price for each side, and every book's price can be tracked from **Track a side**. The model's cover and over chances become an expected margin and total (standard deviations of 13.0 and 13.2 points around the closing line), which prices each book's own line, including pushes.

## Player props model

`props-model.js` walks through every week of nflverse weekly player stats in order, like the game model. A projection is a recency-weighted average (last season counts half), nudged for the opponent's defense against that position and the team's implied points. Week by week it learns three corrections for each stat and volume tier: projection bias, spread of outcomes, and a calibration curve for where results land. Anytime TD chances are calibrated directly (how often players scored when the model said about p). The projection becomes a gamma, normal, or count distribution, which gives over, under, and push chances for any line.

Walk-forward backtest (2025 to tune, 2026 Weeks 1–6 unseen): projections were about 2–4% more accurate than a player's last-8-game average. Predicted over rates at a line matched actual rates within about 3 points. The Netlify function `netlify/functions/player-stats.mjs` serves this season's and last season's stats (GitHub release files can't be fetched from the browser).

## Accounts

Sign-in uses email and password, or **Continue with Google**, through Supabase Auth (project `ISM4421NFLPicks`). The app stays hidden until someone signs in. Each user's settings (`user_settings`), bets (`bets`, `bet_legs`), and saved props (`props`) are stored in Supabase, and row-level security limits every user to their own rows. The project URL and publishable key are in `config.js`. The table definition is in `supabase/migrations/`.

In the Supabase dashboard under **Authentication → URL Configuration**, **Site URL** and **Redirect URLs** must include `https://gridironedgenfl.netlify.app`, or confirmation links, password-reset links, and Google sign-ins won't come back to the app.

Google sign-in needs **Authentication → Sign In / Providers → Google** enabled with the Google OAuth client ID and secret, and the Google client's **Authorized redirect URIs** must include `https://doxbwuyctzfkecbpaqna.supabase.co/auth/v1/callback`. Once signed in, the header shows the name and picture from the user's `user_metadata` (falling back to their email).

## Run locally

Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
```

The live betting splits need the Netlify function, so they only appear when deployed or when run with `netlify dev`.

To deploy on Netlify, import this repo. `netlify.toml` publishes the repo root, deploys the functions, and sets security headers (Content-Security-Policy and friends), and no build command is needed. If you add a script or data source from another site, add it to the CSP there. A Git-connected site redeploys on every push to `main`. Drag-and-drop deploys don't include functions.

## Caveat

Closing NFL lines are very efficient. In backtests this model is about as accurate as the market, not better, so treat the picks as a starting point for analysis rather than a guaranteed edge. Bet responsibly (1-800-GAMBLER).
