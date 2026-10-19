// GridIron Edge model: walk-forward, week-by-week online logistic regression.
// Works in the browser (window.NFLModel) and in Node (module.exports).
(function (root) {
  "use strict";

  const DATA_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";
  const RELOCATED = { OAK: "LV", SD: "LAC", STL: "LA" };

  // ---- Tunable settings ----------------------------------------------------
  const ELO_K = 20;
  const ELO_HFA = 48;            // home-field advantage in Elo points
  const ELO_REGRESS = 1 / 3;     // pull toward the mean at each new season
  const FORM_ALPHA = 0.2;        // weight of the most recent game in rolling stats
  const FORM_REGRESS = 0.5;      // carry-over of rolling stats into a new season
  const LEAGUE_PPG = 22;
  const LR = { win: 0.01, cover: 0.005, total: 0.005 };
  const L2 = 1e-3;

  // ---- CSV -----------------------------------------------------------------
  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
        } else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c !== "\r") field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    const header = rows.shift();
    return rows.filter(r => r.length === header.length).map(r => {
      const o = {};
      header.forEach((h, i) => { o[h] = r[i]; });
      return o;
    });
  }

  const num = v => (v === "" || v === "NA" || v == null ? null : Number(v));
  const team = t => RELOCATED[t] || t;

  function toGames(rows) {
    return rows.map(r => ({
      id: r.game_id,
      season: Number(r.season),
      week: Number(r.week),
      type: r.game_type,
      date: r.gameday,
      time: r.gametime,
      away: team(r.away_team),
      home: team(r.home_team),
      awayScore: num(r.away_score),
      homeScore: num(r.home_score),
      neutral: r.location === "Neutral",
      awayRest: num(r.away_rest),
      homeRest: num(r.home_rest),
      awayML: num(r.away_moneyline),
      homeML: num(r.home_moneyline),
      spread: num(r.spread_line),           // > 0 means the home team is favored
      awaySpreadOdds: num(r.away_spread_odds),
      homeSpreadOdds: num(r.home_spread_odds),
      totalLine: num(r.total_line),
      overOdds: num(r.over_odds),
      underOdds: num(r.under_odds),
      div: r.div_game === "1",
      dome: r.roof === "dome" || r.roof === "closed",
      awayQB: r.away_qb_name,
      homeQB: r.home_qb_name,
    })).map(g => ({ ...g, played: g.homeScore != null && g.awayScore != null }));
  }

  // ---- Odds helpers --------------------------------------------------------
  const impliedProb = am => (am < 0 ? -am / (-am + 100) : 100 / (am + 100));
  const decimalOdds = am => (am < 0 ? 1 + 100 / -am : 1 + am / 100);
  const sigmoid = z => 1 / (1 + Math.exp(-z));
  const logit = p => Math.log(p / (1 - p));
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  // Normal CDF (Abramowitz-Stegun) for converting a spread into a win probability.
  function normCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  }

  // No-vig market probability that the home team wins.
  function marketHomeProb(g) {
    if (g.homeML != null && g.awayML != null) {
      const h = impliedProb(g.homeML), a = impliedProb(g.awayML);
      return h / (h + a);
    }
    if (g.spread != null) return normCdf(g.spread / 13.45);
    return 0.57;
  }

  // ---- Logistic regression trained with SGD -------------------------------
  class OnlineLogit {
    constructor(names, lr, offsetIndex = -1) {
      this.names = names;
      this.offsetIndex = offsetIndex;   // feature added with a fixed weight of 1
      this.w = new Array(names.length).fill(0);
      this.lr = lr;
      this.seen = 0;
    }
    predict(x) {
      let z = this.offsetIndex >= 0 ? x[this.offsetIndex] : 0;
      for (let i = 0; i < x.length; i++) if (i !== this.offsetIndex) z += this.w[i] * x[i];
      return sigmoid(z);
    }
    update(x, y) {
      const err = y - this.predict(x);
      for (let i = 0; i < x.length; i++) {
        if (i === this.offsetIndex) continue;
        const reg = i === 0 ? 0 : L2 * this.w[i];
        this.w[i] += this.lr * (err * x[i] - reg);
      }
      this.seen++;
    }
  }

  const MODELS = {
    win: ["bias", "market log-odds (fixed)", "Elo edge", "point-diff form", "rest edge", "ATS form"],
    cover: ["bias", "Elo margin vs spread", "form margin vs spread", "spread size", "ATS form", "rest edge", "division game"],
    total: ["bias", "form total vs line", "over/under form", "line size", "dome", "division game"],
  };

  // ---- Team state ----------------------------------------------------------
  function newTeam() {
    return { elo: 1505, pf: LEAGUE_PPG, pa: LEAGUE_PPG, ats: 0, ou: 0, games: 0, season: null,
             w: 0, l: 0, t: 0 };
  }

  function seasonReset(s, season) {
    if (s.season === season) return;
    if (s.season !== null) {
      s.elo = s.elo * (1 - ELO_REGRESS) + 1505 * ELO_REGRESS;
      s.pf = s.pf * FORM_REGRESS + LEAGUE_PPG * (1 - FORM_REGRESS);
      s.pa = s.pa * FORM_REGRESS + LEAGUE_PPG * (1 - FORM_REGRESS);
      s.ats *= FORM_REGRESS;
      s.ou *= FORM_REGRESS;
    }
    s.season = season;
    s.w = s.l = s.t = 0;
  }

  function features(g, H, A) {
    const hfa = g.neutral ? 0 : ELO_HFA;
    const eloDiff = H.elo + hfa - A.elo;
    const eloMargin = eloDiff / 25;
    const formMargin = ((H.pf - H.pa) - (A.pf - A.pa)) / 2 + (g.neutral ? 0 : 1.5);
    const restDiff = clamp(((g.homeRest ?? 7) - (g.awayRest ?? 7)) / 7, -2, 2);
    const spread = g.spread ?? eloMargin;
    const totalLine = g.totalLine ?? (H.pf + H.pa + A.pf + A.pa) / 2;
    const formTotal = (H.pf + A.pa + A.pf + H.pa) / 2;
    const pMkt = clamp(marketHomeProb(g), 0.02, 0.98);
    return {
      eloDiff, eloMargin, formMargin, formTotal, pMkt,
      win: [1, logit(pMkt), eloDiff / 100, ((H.pf - H.pa) - (A.pf - A.pa)) / 10, restDiff, (H.ats - A.ats) / 10],
      cover: [1, (eloMargin - spread) / 7, (formMargin - spread) / 7, spread / 7, (H.ats - A.ats) / 10, restDiff, g.div ? 1 : 0],
      total: [1, (formTotal - totalLine) / 7, (H.ou + A.ou) / 10, (totalLine - 44) / 7, g.dome ? 1 : 0, g.div ? 1 : 0],
    };
  }

  function updateTeams(g, H, A) {
    const margin = g.homeScore - g.awayScore;
    const hfa = g.neutral ? 0 : ELO_HFA;
    const expHome = 1 / (1 + Math.pow(10, -(H.elo + hfa - A.elo) / 400));
    const actual = margin > 0 ? 1 : margin < 0 ? 0 : 0.5;
    const movMult = Math.log(Math.abs(margin) + 1) * (2.2 / ((actual === 1 ? 1 : -1) * (H.elo + hfa - A.elo) * 0.001 + 2.2));
    const delta = ELO_K * (margin === 0 ? 1 : movMult) * (actual - expHome);
    H.elo += delta; A.elo -= delta;

    const a = FORM_ALPHA;
    H.pf = H.pf * (1 - a) + g.homeScore * a; H.pa = H.pa * (1 - a) + g.awayScore * a;
    A.pf = A.pf * (1 - a) + g.awayScore * a; A.pa = A.pa * (1 - a) + g.homeScore * a;
    if (g.spread != null) {
      const atsHome = margin - g.spread;
      H.ats = H.ats * (1 - a) + atsHome * a; A.ats = A.ats * (1 - a) - atsHome * a;
    }
    if (g.totalLine != null) {
      const ou = g.homeScore + g.awayScore - g.totalLine;
      H.ou = H.ou * (1 - a) + ou * a; A.ou = A.ou * (1 - a) + ou * a;
    }
    H.games++; A.games++;
    if (g.type === "REG") {
      if (margin > 0) { H.w++; A.l++; } else if (margin < 0) { H.l++; A.w++; } else { H.t++; A.t++; }
    }
  }

  // ---- Walk-forward run ----------------------------------------------------
  // For every week in order: predict all of that week's games using only data
  // from earlier weeks, then learn from that week's results before moving on.
  function run(games) {
    const teams = {};
    const models = {
      win: new OnlineLogit(MODELS.win, LR.win, 1),
      cover: new OnlineLogit(MODELS.cover, LR.cover),
      total: new OnlineLogit(MODELS.total, LR.total),
    };
    const sorted = games.slice().sort((x, y) =>
      x.season - y.season || x.week - y.week || (x.date + (x.time || "")).localeCompare(y.date + (y.time || "")));

    const weeks = [];
    for (const g of sorted) {
      const last = weeks[weeks.length - 1];
      if (last && last.season === g.season && last.week === g.week) last.games.push(g);
      else weeks.push({ season: g.season, week: g.week, games: [g] });
    }

    const predictions = [];
    for (const wk of weeks) {
      const rows = wk.games.map(g => {
        teams[g.home] = teams[g.home] || newTeam();
        teams[g.away] = teams[g.away] || newTeam();
        seasonReset(teams[g.home], g.season);
        seasonReset(teams[g.away], g.season);
        const f = features(g, teams[g.home], teams[g.away]);
        const pred = {
          game: g, f,
          pHomeWin: models.win.predict(f.win),
          pHomeCover: models.cover.predict(f.cover),
          pOver: models.total.predict(f.total),
          homeElo: teams[g.home].elo, awayElo: teams[g.away].elo,
        };
        predictions.push(pred);
        return pred;
      });
      // Learn from this week's completed games.
      for (const p of rows) {
        const g = p.game;
        if (!g.played) continue;
        const margin = g.homeScore - g.awayScore;
        if (margin !== 0) models.win.update(p.f.win, margin > 0 ? 1 : 0);
        if (g.spread != null && margin !== g.spread) models.cover.update(p.f.cover, margin > g.spread ? 1 : 0);
        const total = g.homeScore + g.awayScore;
        if (g.totalLine != null && total !== g.totalLine) models.total.update(p.f.total, total > g.totalLine ? 1 : 0);
      }
      for (const p of rows) if (p.game.played) updateTeams(p.game, teams[p.game.home], teams[p.game.away]);
    }
    return { predictions, teams, models };
  }

  // ---- Bets ----------------------------------------------------------------
  // Every bettable side of a game with the model probability and expected value.
  function betOptions(p) {
    const g = p.game, out = [];
    const add = (market, side, label, prob, american) => {
      if (american == null) return;
      const dec = decimalOdds(american);
      const ev = prob * dec - 1;
      const kelly = ev > 0 ? ev / (dec - 1) : 0;
      out.push({ pred: p, market, side, label, prob, american, breakeven: 1 / dec, ev, kelly });
    };
    if (g.homeML != null && g.awayML != null) {
      add("ML", "home", `${g.home} ML`, p.pHomeWin, g.homeML);
      add("ML", "away", `${g.away} ML`, 1 - p.pHomeWin, g.awayML);
    }
    if (g.spread != null) {
      const hs = -g.spread;
      add("ATS", "home", `${g.home} ${fmtLine(hs)}`, p.pHomeCover, g.homeSpreadOdds ?? -110);
      add("ATS", "away", `${g.away} ${fmtLine(-hs)}`, 1 - p.pHomeCover, g.awaySpreadOdds ?? -110);
    }
    if (g.totalLine != null) {
      add("TOT", "over", `Over ${g.totalLine}`, p.pOver, g.overOdds ?? -110);
      add("TOT", "under", `Under ${g.totalLine}`, 1 - p.pOver, g.underOdds ?? -110);
    }
    return out;
  }

  // Best positive-EV side per market per game above the edge threshold.
  function selectBets(preds, { minEdge = 0.03, markets = ["ML", "ATS", "TOT"], minProb = 0 } = {}) {
    const bets = [];
    for (const p of preds) {
      const opts = betOptions(p).filter(o => markets.includes(o.market));
      for (const m of markets) {
        const best = opts.filter(o => o.market === m).sort((a, b) => b.ev - a.ev)[0];
        if (best && best.ev >= minEdge && best.prob >= minProb) bets.push(best);
      }
    }
    return bets.sort((a, b) => b.ev - a.ev);
  }

  // 1 = win, 0 = loss, 0.5 = push, null = not graded yet.
  function grade(bet) {
    const g = bet.pred.game;
    if (!g.played) return null;
    const margin = g.homeScore - g.awayScore;
    if (bet.market === "ML") {
      if (margin === 0) return 0.5;
      return (margin > 0) === (bet.side === "home") ? 1 : 0;
    }
    if (bet.market === "ATS") {
      if (margin === g.spread) return 0.5;
      return (margin > g.spread) === (bet.side === "home") ? 1 : 0;
    }
    const total = g.homeScore + g.awayScore;
    if (total === g.totalLine) return 0.5;
    return (total > g.totalLine) === (bet.side === "over") ? 1 : 0;
  }

  // Profit in units for a 1-unit stake.
  function profit(bet) {
    const r = grade(bet);
    if (r === null || r === 0.5) return 0;
    return r === 1 ? decimalOdds(bet.american) - 1 : -1;
  }

  function summarize(bets) {
    const s = { n: 0, w: 0, l: 0, p: 0, units: 0 };
    for (const b of bets) {
      const r = grade(b);
      if (r === null) continue;
      s.n++;
      if (r === 1) s.w++; else if (r === 0) s.l++; else s.p++;
      s.units += profit(b);
    }
    s.roi = s.n ? s.units / s.n : 0;
    s.hitRate = s.w + s.l ? s.w / (s.w + s.l) : 0;
    return s;
  }

  // Calibration metrics of the win model vs. the betting market.
  function winModelMetrics(preds) {
    let n = 0, correct = 0, mktCorrect = 0, brier = 0, mktBrier = 0;
    for (const p of preds) {
      const g = p.game;
      if (!g.played || g.homeScore === g.awayScore) continue;
      const y = g.homeScore > g.awayScore ? 1 : 0;
      n++;
      correct += (p.pHomeWin > 0.5) === (y === 1) ? 1 : 0;
      mktCorrect += (p.f.pMkt > 0.5) === (y === 1) ? 1 : 0;
      brier += (p.pHomeWin - y) ** 2;
      mktBrier += (p.f.pMkt - y) ** 2;
    }
    return { n, acc: n ? correct / n : 0, mktAcc: n ? mktCorrect / n : 0,
             brier: n ? brier / n : 0, mktBrier: n ? mktBrier / n : 0 };
  }

  function fmtLine(x) { return x > 0 ? `+${x}` : `${x}`; }
  function fmtOdds(am) { return am > 0 ? `+${am}` : `${am}`; }

  async function load(fetchImpl) {
    const res = await (fetchImpl || fetch)(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`Data download failed (${res.status})`);
    return toGames(parseCSV(await res.text()));
  }

  const api = { DATA_URL, MODELS, parseCSV, toGames, run, betOptions, selectBets, grade, profit,
                summarize, winModelMetrics, load, fmtLine, fmtOdds, impliedProb, decimalOdds };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NFLModel = api;
})(typeof window !== "undefined" ? window : globalThis);
