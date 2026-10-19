// GridIron Edge player props model: walk-forward, week-by-week projections.
// Works in the browser (window.PropsModel) and in Node (module.exports).
(function (root) {
  "use strict";

  // ---- Tunable settings (chosen by backtest on 2025, checked on 2026) -------
  const PARAMS = {
    decay: 0.9,         // weight of each older game relative to the next one
    carry: 0.5,         // extra weight kept on last season's games at a new season
    priorGames: 1,      // games' worth of pull toward the position average
    priorScale: 1,      // share of the position average used as that pull
    defGames: 4,        // games' worth of pull toward league average for defenses
    defDecay: 0.85,
    defPower: 0.2,      // how strongly the opponent's defense moves the projection
    envPower: 0.2,      // how strongly the game's implied team total moves it
    biasGames: 40,      // projections' worth of evidence before trusting the bias correction
  };

  // Each prop: how to read it from a stat row, who it applies to, and its distribution.
  // "yards" props use a gamma distribution, "count" props a negative binomial or binomial.
  // QB passing volume is close to symmetric, so those use a normal curve instead.
  const STATS = {
    pass_yds:     { label: "Passing yards", short: "Pass yds", pos: ["QB"], kind: "yards", shape: "normal", f: s => s.passing_yards },
    pass_att:     { label: "Pass attempts", short: "Pass att", pos: ["QB"], kind: "count", shape: "normal", f: s => s.attempts },
    completions:  { label: "Completions", short: "Comp", pos: ["QB"], kind: "count", shape: "normal", f: s => s.completions },
    pass_tds:     { label: "Passing TDs", short: "Pass TD", pos: ["QB"], kind: "count", f: s => s.passing_tds },
    ints:         { label: "Interceptions thrown", short: "INT", pos: ["QB"], kind: "count", f: s => s.passing_interceptions },
    rush_yds:     { label: "Rushing yards", short: "Rush yds", pos: ["QB", "RB"], kind: "yards", f: s => s.rushing_yards },
    rush_att:     { label: "Rush attempts", short: "Rush att", pos: ["QB", "RB"], kind: "count", f: s => s.carries },
    receptions:   { label: "Receptions", short: "Rec", pos: ["RB", "WR", "TE"], kind: "count", f: s => s.receptions },
    rec_yds:      { label: "Receiving yards", short: "Rec yds", pos: ["RB", "WR", "TE"], kind: "yards", f: s => s.receiving_yards },
    rush_rec_yds: { label: "Rush + receiving yards", short: "Rush+rec yds", pos: ["RB", "WR"], kind: "yards",
                    f: s => s.rushing_yards + s.receiving_yards },
    anytime_td:   { label: "Anytime touchdown", short: "Anytime TD", pos: ["RB", "WR", "TE"], kind: "count",
                    f: s => s.rushing_tds + s.receiving_tds, fixedLine: 0.5 },
  };
  // Starting spread of outcomes before the model has seen its own errors:
  // coefficient of variation for yards, variance / mean for counts.
  const START_SPREAD = { yards: 0.6, count: 1 };
  // High-volume players are steadier than boom-or-bust role players, so the
  // spread is learned separately for low, mid and high projections.
  const TIER_CUTS = { yards: [15, 30, 60], count: [1, 2, 4] };
  const tier = (kind, mean) => TIER_CUTS[kind].filter(c => mean >= c).length;

  // ---- Math ----------------------------------------------------------------
  function lnGamma(x) {
    const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
      -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x, tmp = x + 5.5, ser = 1.000000000190015;
    tmp -= (x + 0.5) * Math.log(tmp);
    for (const v of c) ser += v / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  }

  // Normal CDF (Abramowitz-Stegun).
  function normCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  }

  // Regularized lower incomplete gamma P(a, x).
  function gammaP(a, x) {
    if (x <= 0) return 0;
    if (x < a + 1) {
      let sum = 1 / a, del = sum, ap = a;
      for (let n = 0; n < 500; n++) { del *= x / ++ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-12) break; }
      return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
    }
    let b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d;
    for (let i = 1; i < 500; i++) {
      const an = -i * (i - a);
      b += 2;
      d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
      c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 1e-12) break;
    }
    return 1 - Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
  }

  // P(X > line), P(X = line) and P(X < line) for a projection, after the learned
  // calibration curve (see "calib" below) has been applied.
  function lineProbs(proj, line) {
    const raw = rawProbs(proj, line);
    if (proj.pcal && line === STATS[proj.key].fixedLine) {
      const over = mapProb(proj.pcal, raw.over);
      return { over, push: 0, under: 1 - over };
    }
    if (!proj.calib) return raw;
    const under = calibrate(proj.calib, raw.under);
    const atOrUnder = raw.push ? calibrate(proj.calib, raw.under + raw.push) : under;
    return { over: 1 - atOrUnder, push: atOrUnder - under, under };
  }

  // Calibration curve: a histogram of where actual results fell within earlier
  // projections (0 = far under, 1 = far over). If the model were perfect it would
  // be flat; any tilt is used to correct new probabilities.
  const CALIB_BINS = 20, CALIB_PRIOR = 5;
  function calibrate(hist, u) {
    const total = hist.reduce((a, b) => a + b, 0);
    const x = Math.min(1, Math.max(0, u)) * CALIB_BINS, i = Math.min(CALIB_BINS - 1, Math.floor(x));
    let below = 0;
    for (let k = 0; k < i; k++) below += hist[k];
    return (below + hist[i] * (x - i)) / total;
  }

  // Yes/no props (anytime TD) are calibrated directly: of the times the model said
  // about p, how often did it happen? Ten buckets, kept increasing, read between centers.
  const PCAL_BINS = 10, PCAL_PRIOR = 3;
  function mapProb(bins, p) {
    const rates = [];
    for (let i = 0; i < PCAL_BINS; i++) {
      const center = (i + 0.5) / PCAL_BINS;
      const r = (bins[i][0] + PCAL_PRIOR * center) / (bins[i][1] + PCAL_PRIOR);
      rates.push(i ? Math.max(r, rates[i - 1]) : r);
    }
    const x = Math.min(1, Math.max(0, p)) * PCAL_BINS - 0.5;
    if (x <= 0) return rates[0] * (p * PCAL_BINS * 2);   // scale down toward 0 below the first center
    if (x >= PCAL_BINS - 1) return rates[PCAL_BINS - 1];
    const i = Math.floor(x);
    return rates[i] + (rates[i + 1] - rates[i]) * (x - i);
  }

  function rawProbs(proj, line) {
    const { mean, spread, kind } = proj;
    if (mean <= 0) return { over: 0, push: line === 0 ? 1 : 0, under: line > 0 ? 1 : 0 };
    if (STATS[proj.key].shape === "normal") {
      const sd = kind === "yards" ? spread * mean : Math.sqrt(spread * mean);
      if (kind === "yards") { const under = normCdf((line - mean) / sd); return { over: 1 - under, push: 0, under }; }
      // Counts: continuity correction, and a whole-number line can push.
      const below = normCdf((Math.ceil(line) - 0.5 - mean) / sd);
      const push = Number.isInteger(line) ? normCdf((line + 0.5 - mean) / sd) - below : 0;
      return { over: Math.max(0, 1 - below - push), push, under: below };
    }
    if (kind === "yards") {
      const shape = 1 / (spread * spread), scale = mean / shape;
      const under = gammaP(shape, Math.max(0, line) / scale);
      return { over: 1 - under, push: 0, under };
    }
    // Counts: negative binomial when outcomes vary more than a Poisson, binomial when less.
    const pmf = countPmf(mean, spread, Math.floor(line) + 1);
    let below = 0;
    for (let k = 0; k < Math.ceil(line); k++) below += pmf[k];
    const push = Number.isInteger(line) ? pmf[line] : 0;
    return { over: Math.max(0, 1 - below - push), push, under: below };
  }

  function countPmf(mean, ratio, upTo) {
    const out = [];
    if (ratio > 1.02) {
      const r = mean / (ratio - 1), p = r / (r + mean);
      let v = Math.pow(p, r);
      for (let k = 0; k <= upTo; k++) { out.push(v); v *= ((k + r) / (k + 1)) * (1 - p); }
    } else if (ratio < 0.98) {
      const n = Math.max(Math.ceil(mean / (1 - ratio)), Math.ceil(mean) + 1), p = mean / n;
      let v = Math.pow(1 - p, n);
      for (let k = 0; k <= upTo; k++) { out.push(k <= n ? v : 0); v *= ((n - k) / (k + 1)) * (p / (1 - p)); }
    } else {
      let v = Math.exp(-mean);
      for (let k = 0; k <= upTo; k++) { out.push(v); v *= mean / (k + 1); }
    }
    return out;
  }

  // ---- Odds helpers (same rules as the game model) -------------------------
  const decimalOdds = am => (am < 0 ? 1 + 100 / -am : 1 + am / 100);
  const impliedProb = am => (am < 0 ? -am / (-am + 100) : 100 / (am + 100));
  const fmtOdds = am => (am > 0 ? `+${am}` : `${am}`);
  // American odds that break even at probability p (the model's fair price).
  const fairOdds = p => (p <= 0 || p >= 1 ? null : p >= 0.5 ? -Math.round(100 * p / (1 - p)) : Math.round(100 * (1 - p) / p));

  // Expected value per 1 unit staked, counting a push as money back.
  function evaluate(proj, line, overOdds, underOdds) {
    const pr = lineProbs(proj, line);
    const sides = [];
    for (const [side, prob, american] of [["over", pr.over, overOdds], ["under", pr.under, underOdds]]) {
      if (american == null || !Number.isFinite(american)) continue;
      const dec = decimalOdds(american), lose = 1 - prob - pr.push;
      const ev = prob * (dec - 1) - lose;
      const kelly = ev > 0 ? ev / (dec - 1) : 0;
      const breakeven = (1 - pr.push) / dec;   // win chance needed with pushes refunded
      sides.push({ side, prob, push: pr.push, american, ev, kelly, breakeven, fair: fairOdds(prob / (1 - pr.push)) });
    }
    let noVig = null;
    if (overOdds != null && underOdds != null) {
      const o = impliedProb(overOdds), u = impliedProb(underOdds);
      noVig = o / (o + u);
    }
    sides.sort((a, b) => b.ev - a.ev);
    return { probs: pr, sides, best: sides[0] || null, noVig };
  }

  // ---- Data ----------------------------------------------------------------
  function fromCompact(data) {
    const players = {};
    for (const [id, [name, pos]] of Object.entries(data.players)) players[id] = { id, name, pos };
    const rows = data.rows.map(r => {
      const s = {};
      data.cols.forEach((c, i) => { s[c] = r[5 + i]; });
      return { id: r[0], team: r[1], opp: r[2], season: r[3], week: r[4], s };
    });
    return { players, rows };
  }

  // Implied points for each team in each game, from the closing spread and total.
  function impliedTotals(games) {
    const out = new Map();
    for (const g of games || []) {
      if (g.spread == null || g.totalLine == null) continue;
      out.set(`${g.season}|${g.week}|${g.home}`, (g.totalLine + g.spread) / 2);
      out.set(`${g.season}|${g.week}|${g.away}`, (g.totalLine - g.spread) / 2);
    }
    return out;
  }

  // ---- Model ---------------------------------------------------------------
  // Walks through every week in order. Each week it projects every player who
  // played (for the backtest), then learns from that week's results.
  function run(data, games, params = {}) {
    const P = { ...PARAMS, ...params };
    const { players, rows } = fromCompact(data);
    const implied = impliedTotals(games);
    const keys = Object.keys(STATS);
    const player = {};          // id -> { season, n, w: {stat: [sumW, sumWX]} }
    const defense = {};         // team|pos -> {stat: [sumW, sumWX]}
    const league = {};          // pos|stat -> [sumW, sumWX] per player-game
    const leagueDef = {};       // pos|stat -> [sumW, sumWX] per team-game
    const teamEnv = {};         // team -> [sumW, sumWX] of implied points
    const spread = {};          // stat|pos|tier -> { err2, scale, n }
    const bias = {};            // stat|pos|tier -> [sumActual, sumProjected, n]
    const calib = {};           // stat|pos|tier -> histogram of where results fell
    const pcal = {};            // stat|pos -> [hits, n] per probability bucket, for yes/no props
    const backtest = [];

    const ew = (acc, x, decay) => { acc[0] = acc[0] * decay + 1; acc[1] = acc[1] * decay + x; };
    const avg = acc => (acc && acc[0] > 0 ? acc[1] / acc[0] : null);

    function project(id, team, opp, season, week, key) {
      const st = STATS[key], pl = players[id], pr = player[id];
      if (!pl || !st.pos.includes(pl.pos)) return null;
      const leagueAvg = avg(league[`${pl.pos}|${key}`]);
      if (leagueAvg == null) return null;
      const own = pr && pr.w[key] ? pr.w[key] : [0, 0];
      let carry = 1;
      if (pr && pr.season !== season) carry = P.carry;
      const base = (own[1] * carry + P.priorGames * P.priorScale * leagueAvg) / (own[0] * carry + P.priorGames);

      const lDef = avg(leagueDef[`${pl.pos}|${key}`]);
      const d = defense[`${opp}|${pl.pos}`] && defense[`${opp}|${pl.pos}`][key];
      let defFactor = 1;
      if (lDef > 0 && d) defFactor = Math.pow(((d[1] + P.defGames * lDef) / (d[0] + P.defGames)) / lDef, P.defPower);

      let envFactor = 1;
      const imp = implied.get(`${season}|${week}|${team}`), usual = avg(teamEnv[team]);
      if (imp && usual) envFactor = Math.pow(imp / usual, P.envPower);

      // Learned correction: how actual results have compared with raw projections like this one.
      const raw = Math.max(0, base * defFactor * envFactor);
      const tk = `${key}|${pl.pos}|${tier(st.kind, raw)}`;
      const bs = bias[tk];
      let biasFactor = 1;
      if (bs && bs[2] > 0) {
        const m = bs[1] / bs[2];
        biasFactor = (bs[0] + P.biasGames * m) / (bs[1] + P.biasGames * m);
      }
      const mean = raw * biasFactor;
      const sp = spread[tk];
      const yesNo = st.fixedLine != null;
      const cal = !yesNo && calib[tk] && calib[tk].n >= 50 ? calib[tk].hist : null;
      const pc = yesNo && pcal[`${key}|${pl.pos}`] && pcal[`${key}|${pl.pos}`].n >= 100 ? pcal[`${key}|${pl.pos}`].bins : null;
      let spreadVal = START_SPREAD[st.kind];
      if (sp && sp.n >= 30) spreadVal = st.kind === "yards" ? Math.sqrt(sp.err2 / sp.scale) : sp.err2 / sp.scale;
      return { id, name: pl.name, pos: pl.pos, team, opp, key, label: st.label, kind: st.kind,
        mean, spread: Math.max(spreadVal, st.kind === "yards" ? 0.25 : 0.3),
        calib: cal, pcal: pc, games: pr ? pr.n : 0, base, defFactor, envFactor, biasFactor, raw, tierKey: tk, implied: imp ?? null };
    }

    function learn(weekRows) {
      // Errors first, so each week's spread estimate only uses earlier weeks.
      for (const b of weekRows.preds) {
        const bs = bias[b.tierKey] || (bias[b.tierKey] = [0, 0, 0]);
        bs[0] = bs[0] * 0.995 + b.actual; bs[1] = bs[1] * 0.995 + b.raw; bs[2] = bs[2] * 0.995 + 1;
        if (STATS[b.key].fixedLine != null) {
          const pk = `${b.key}|${b.pos}`;
          const pc = pcal[pk] || (pcal[pk] = { bins: Array.from({ length: PCAL_BINS }, () => [0, 0]), n: 0 });
          const p = rawProbs({ ...b, calib: null, pcal: null }, STATS[b.key].fixedLine).over;
          for (const bin of pc.bins) { bin[0] *= 0.998; bin[1] *= 0.998; }
          const bin = pc.bins[Math.min(PCAL_BINS - 1, Math.floor(p * PCAL_BINS))];
          bin[0] += b.actual > STATS[b.key].fixedLine ? 1 : 0;
          bin[1] += 1;
          pc.n++;
        }
        // Where the result fell in the uncalibrated distribution (midpoint for whole numbers).
        const c = calib[b.tierKey] || (calib[b.tierKey] = { hist: new Array(CALIB_BINS).fill(CALIB_PRIOR), n: 0 });
        const plain = { ...b, calib: null };
        const u = b.kind === "count" || STATS[b.key].fixedLine != null
          ? (rawProbs(plain, b.actual - 0.5).under + rawProbs(plain, b.actual + 0.5).under) / 2
          : rawProbs(plain, b.actual).under;
        for (let k = 0; k < CALIB_BINS; k++) c.hist[k] = CALIB_PRIOR + (c.hist[k] - CALIB_PRIOR) * 0.995;
        c.hist[Math.min(CALIB_BINS - 1, Math.floor(u * CALIB_BINS))] += 1;
        c.n++;
        const sp = spread[b.tierKey] || (spread[b.tierKey] = { err2: 0, scale: 0, n: 0 });
        if (b.games < 3 || b.mean < 0.5) continue;
        sp.err2 = sp.err2 * 0.995 + (b.actual - b.mean) ** 2;
        sp.scale = sp.scale * 0.995 + (STATS[b.key].kind === "yards" ? b.mean * b.mean : b.mean);
        sp.n++;
      }
      const allowed = {};
      for (const r of weekRows.rows) {
        const pl = players[r.id];
        if (!pl) continue;
        let pr = player[r.id];
        if (!pr) pr = player[r.id] = { season: r.season, n: 0, w: {} };
        if (pr.season !== r.season) {
          for (const k of keys) if (pr.w[k]) { pr.w[k][0] *= P.carry; pr.w[k][1] *= P.carry; }
          pr.season = r.season;
        }
        pr.n++;
        pr.team = r.team;
        pr.last = { season: r.season, week: r.week };
        for (const k of keys) {
          if (!STATS[k].pos.includes(pl.pos)) continue;
          const x = STATS[k].f(r.s);
          ew(pr.w[k] || (pr.w[k] = [0, 0]), x, P.decay);
          ew(league[`${pl.pos}|${k}`] || (league[`${pl.pos}|${k}`] = [0, 0]), x, 0.999);
          const a = allowed[`${r.opp}|${pl.pos}`] || (allowed[`${r.opp}|${pl.pos}`] = {});
          a[k] = (a[k] || 0) + x;
        }
      }
      for (const [tk, stats] of Object.entries(allowed)) {
        const pos = tk.split("|")[1];
        const d = defense[tk] || (defense[tk] = {});
        for (const [k, x] of Object.entries(stats)) {
          ew(d[k] || (d[k] = [0, 0]), x, P.defDecay);
          ew(leagueDef[`${pos}|${k}`] || (leagueDef[`${pos}|${k}`] = [0, 0]), x, 0.995);
        }
      }
      for (const [t, v] of weekRows.env) ew(teamEnv[t] || (teamEnv[t] = [0, 0]), v, P.decay);
    }

    // Group rows by week, in order.
    const weeks = [];
    for (const r of rows) {
      const last = weeks[weeks.length - 1];
      if (!last || last.season !== r.season || last.week !== r.week) weeks.push({ season: r.season, week: r.week, rows: [r] });
      else last.rows.push(r);
    }
    for (const wk of weeks) {
      const preds = [], env = new Map();
      for (const r of wk.rows) {
        const imp = implied.get(`${r.season}|${r.week}|${r.team}`);
        if (imp) env.set(r.team, imp);
        for (const k of keys) {
          const p = project(r.id, r.team, r.opp, r.season, r.week, k);
          if (!p) continue;
          p.actual = STATS[k].f(r.s);
          p.season = r.season;
          p.week = r.week;
          preds.push(p);
        }
      }
      backtest.push(...preds);
      learn({ rows: wk.rows, preds, env });
    }

    const last = weeks[weeks.length - 1];
    const byGame = new Map(rows.map(r => [`${r.id}|${r.season}|${r.week}`, r]));
    const byPlayer = new Map();
    for (const r of rows) (byPlayer.get(r.id) || byPlayer.set(r.id, []).get(r.id)).push(r);
    return {
      players, player, backtest, last: last ? { season: last.season, week: last.week } : null,
      // A player's most recent games, newest first: { season, week, team, opp, s }.
      log: (id, n = 6) => (byPlayer.get(id) || []).slice(-n).reverse(),
      // What a player actually recorded in a week, or null if they have no stat line.
      actual: (id, season, week, key) => {
        const r = byGame.get(`${id}|${season}|${week}`);
        return r ? STATS[key].f(r.s) : null;
      },
      // Projection for an upcoming game. Returns null if the player or stat doesn't fit.
      project: (id, team, opp, season, week, key) => project(id, team, opp, season, week, key),
    };
  }

  // Projections for everyone likely to play in the upcoming games.
  // A player counts as active if they played in one of their team's last two games.
  function upcoming(model, games) {
    const out = [];
    const teamWeeks = {};
    for (const [id, pr] of Object.entries(model.player)) {
      if (!pr.last) continue;
      const k = pr.team;
      (teamWeeks[k] = teamWeeks[k] || new Set()).add(`${pr.last.season}|${pr.last.week}`);
    }
    const recent = {};
    for (const [t, set] of Object.entries(teamWeeks)) {
      recent[t] = new Set([...set].sort((a, b) => {
        const [sa, wa] = a.split("|").map(Number), [sb, wb] = b.split("|").map(Number);
        return sb - sa || wb - wa;
      }).slice(0, 2));
    }
    for (const g of games) {
      for (const [team, opp] of [[g.home, g.away], [g.away, g.home]]) {
        for (const [id, pr] of Object.entries(model.player)) {
          if (pr.team !== team || !recent[team].has(`${pr.last.season}|${pr.last.week}`)) continue;
          const pl = model.players[id];
          const props = {};
          for (const key of Object.keys(STATS)) {
            if (!STATS[key].pos.includes(pl.pos)) continue;
            const p = model.project(id, team, opp, g.season, g.week, key);
            if (p) props[key] = p;
          }
          out.push({ id, name: pl.name, pos: pl.pos, team, opp, game: g, props });
        }
      }
    }
    return out;
  }

  // The value with chance q of the result landing at or below it (q = 0.5 is the median).
  function quantile(proj, q) {
    if (proj.kind === "count" || STATS[proj.key].fixedLine != null) {
      for (let k = 0; k <= Math.ceil(proj.mean * 6) + 5; k++) if (lineProbs(proj, k + 0.5).under >= q) return k;
      return Math.ceil(proj.mean * 6) + 5;
    }
    let lo = 0, hi = Math.max(10, proj.mean * 6);
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (lineProbs(proj, mid).under < q) lo = mid; else hi = mid;
    }
    return Math.round(lo);
  }

  // Common milestone props ("50+ rushing yards") for each stat.
  const LADDERS = {
    pass_yds: [150, 175, 200, 225, 250, 275, 300, 325, 350], pass_att: [25, 30, 35, 40, 45], completions: [15, 18, 20, 22, 25, 28, 30],
    pass_tds: [1, 2, 3, 4], ints: [1, 2], rush_yds: [10, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 125],
    rush_att: [5, 8, 10, 12, 15, 18, 20, 25], receptions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    rec_yds: [10, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 125], rush_rec_yds: [25, 40, 50, 60, 75, 90, 100, 125, 150],
    anytime_td: [1],
  };
  // Three milestones around the projection: one likely, one near even, one a stretch.
  // Each is { at, prob } where prob is the chance of at least `at`.
  function milestones(proj) {
    const ladder = LADDERS[proj.key];
    const all = ladder.map(at => ({ at, prob: lineProbs(proj, at - 0.5).over })).filter(m => m.prob >= 0.08 && m.prob <= 0.95);
    if (all.length <= 3) return all;
    const near = (target) => all.reduce((a, b) => (Math.abs(b.prob - target) < Math.abs(a.prob - target) ? b : a));
    const picks = [near(0.75), near(0.5), near(0.25)];
    return [...new Map(picks.map(m => [m.at, m])).values()].sort((a, b) => a.at - b.at);
  }

  // The line a book would likely post: the projection's median, on a half point.
  function fairLine(proj) {
    if (STATS[proj.key].fixedLine != null) return STATS[proj.key].fixedLine;
    if (proj.kind === "count") {
      let best = 0.5, gap = Infinity;
      for (let k = 0; k <= Math.ceil(proj.mean * 3) + 1; k++) {
        const g = Math.abs(lineProbs(proj, k + 0.5).over - 0.5);
        if (g < gap) { gap = g; best = k + 0.5; }
      }
      return best;
    }
    let lo = 0, hi = Math.max(1, proj.mean * 4);
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (lineProbs(proj, mid).over > 0.5) lo = mid; else hi = mid;
    }
    return Math.max(0.5, Math.round(lo - 0.5) + 0.5);
  }

  const api = { PARAMS, STATS, LADDERS, run, upcoming, evaluate, lineProbs, quantile, milestones, fairLine, fairOdds,
                decimalOdds, impliedProb, fmtOdds };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PropsModel = api;
})(typeof window !== "undefined" ? window : globalThis);
