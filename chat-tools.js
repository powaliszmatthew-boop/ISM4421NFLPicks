// "Ask the model" tools: the chatbot's only source of numbers. Each tool wraps props-model.js and
// runs on this page, with the projections and saved props the page has already loaded.
// What goes back to the AI provider (`forModel`) never includes the bankroll or a dollar stake:
// stakes are a % of bankroll plus a token like [[S1]] that the chat panel swaps for dollars.
// Works in the browser (window.ChatTools) and in Node (module.exports) for tests.
(function (root) {
  "use strict";

  const MAX_STAKE = 0.03;          // same cap as the rest of the site
  const LITTLE_HISTORY = 4;        // fewer games than this gets the "little history" note (as on the props cards)
  const SIDE = { over: "Over", under: "Under" };

  const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
  const signedPct = x => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
  const oddsOk = am => Number.isInteger(am) && (am <= -100 || am >= 100);
  const toOdds = v => {
    if (v == null || v === "") return null;
    const n = Number(String(v).replace(/^\+/, ""));
    return oddsOk(n) ? n : NaN;
  };
  const toLine = v => (v == null || v === "" ? null : Number(v));

  // Player names: lower case, no accents or punctuation, no Jr./Sr./III.
  const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(t => t && !/^(jr|sr|ii|iii|iv|v)$/.test(t));

  function nameScore(query, name) {
    const q = norm(query), n = norm(name);
    if (!q.length || !n.length) return 0;
    if (q.join(" ") === n.join(" ")) return 100;
    const tokenHit = t => n.some(x => x === t || (t.length === 1 && x[0] === t));
    if (q.length > 1 && q.every(tokenHit)) return 80;
    const last = n[n.length - 1];
    if (q.length === 1 && q[0] === last) return 60;
    if (q.length === 1 && q[0] === n[0]) return 50;
    if (q.some(t => t.length >= 3 && last.startsWith(t))) return 35;
    if (n.join(" ").includes(q.join(" "))) return 30;
    return 0;
  }

  // Words people use for each prop, for when the AI passes a label instead of a key.
  const STAT_WORDS = {
    pass_yds: ["passing yards", "pass yards", "pass yds", "passing"], pass_att: ["pass attempts", "attempts"],
    completions: ["completions", "comp"], pass_tds: ["passing tds", "passing touchdowns", "pass td", "pass tds"],
    ints: ["interceptions", "ints", "int", "picks"], rush_yds: ["rushing yards", "rush yards", "rush yds", "rushing"],
    rush_att: ["rush attempts", "carries", "rushing attempts"], receptions: ["receptions", "catches", "rec"],
    rec_yds: ["receiving yards", "rec yards", "rec yds", "receiving"],
    rush_rec_yds: ["rush + receiving yards", "rush and receiving yards", "rushing + receiving yards", "scrimmage yards", "rush+rec yds"],
    anytime_td: ["anytime td", "anytime touchdown", "touchdown", "td", "to score"],
  };
  function statKey(PM, s) {
    if (!s) return null;
    const k = String(s).trim().toLowerCase();
    if (PM.STATS[k]) return k;
    for (const [key, words] of Object.entries(STAT_WORDS)) if (words.includes(k)) return key;
    for (const [key, st] of Object.entries(PM.STATS)) if (st.label.toLowerCase() === k || st.short.toLowerCase() === k) return key;
    return null;
  }

  function create(env) {
    // env: { PM, players(), saved(), upcomingGames(), settings() -> {minEdge, bankroll}, config() -> {newsEdge}, kickoff(g) }
    const { PM } = env;
    let cards = [], stakeN = 0;

    const kick = g => (env.kickoff ? env.kickoff(g) : `${g.date}${g.time ? ` ${g.time} ET` : ""}`);
    const gameLabel = g => `Week ${g.week}: ${g.away} @ ${g.home}, ${kick(g)}`;
    const stakeFor = s => (s && s.ev > 0 ? env.settings().bankroll * Math.min(MAX_STAKE, s.kelly / 4) : 0);
    const stakePct = s => (s && s.ev > 0 ? Math.min(MAX_STAKE, s.kelly / 4) : 0);

    // Each player once, at his soonest upcoming game (or the week asked for).
    function roster(week) {
      const seen = new Map();
      for (const p of env.players()) {
        if (!Object.keys(p.props).length || (week && p.game.week !== week)) continue;
        const cur = seen.get(p.id);
        if (!cur || `${p.game.date} ${p.game.time}` < `${cur.game.date} ${cur.game.time}`) seen.set(p.id, p);
      }
      return [...seen.values()];
    }

    function findPlayers(query, week) {
      const scored = roster(week).map(p => ({ p, s: nameScore(query, p.name) })).filter(x => x.s > 0)
        .sort((a, b) => b.s - a.s);
      if (!scored.length) return [];
      return scored.filter(x => x.s === scored[0].s).map(x => x.p);
    }

    const brief = p => ({ player: p.name, pos: p.pos, team: p.team, opponent: p.opp, game: gameLabel(p.game),
      props: Object.keys(p.props) });

    // One player or an explanation the AI can pass on.
    function resolve(args) {
      if (!args || !args.player) return { err: { status: "need_info", missing: ["player"], note: "Ask which player." } };
      const week = args.week ? Number(args.week) : null;
      const found = findPlayers(args.player, week);
      if (!found.length) return { err: { status: "not_found", note: `No active player matching "${String(args.player).slice(0, 40)}" in this week's games. He may be injured, on bye, or not have played in his team's last two games.` } };
      if (found.length > 1) return { err: { status: "ambiguous", note: "Several players match; ask which one.", candidates: found.slice(0, 5).map(brief) } };
      return { p: found[0] };
    }

    function resolveStat(p, s) {
      const key = statKey(PM, s);
      if (!key) return { err: { status: "need_info", missing: ["stat"], note: "Ask which prop (e.g. rushing yards).", available: Object.keys(p.props) } };
      if (!p.props[key]) return { err: { status: "no_projection", note: `The model has no ${PM.STATS[key].label.toLowerCase()} projection for ${p.name} (${p.pos}).`, available: Object.keys(p.props) } };
      return { key, proj: p.props[key] };
    }

    // The user's saved props for this player and prop in his upcoming game, best edge first.
    function savedLines(p, key, line, side) {
      const rows = env.saved().filter(r => r.player_id === p.id && r.stat === key && r.game_id === p.game.id &&
        (line == null || Number(r.line) === line));
      const priced = rows.map(r => {
        const ev = PM.evaluate(p.props[key], Number(r.line), r.over_odds, r.under_odds);
        const s = side ? ev.sides.find(x => x.side === side) : ev.best;
        return { r, ev: s ? s.ev : -9 };
      }).filter(x => x.ev > -9);
      return priced.sort((a, b) => b.ev - a.ev).map(x => x.r);
    }

    const history = (proj) => ({ games_of_history: proj.games, little_history: proj.games < LITTLE_HISTORY });

    // ---- Tools --------------------------------------------------------------
    function find_player(args) {
      const q = String((args && args.query) || "").trim();
      if (!q) return { status: "need_info", missing: ["query"] };
      const team = q.toUpperCase();
      const games = env.upcomingGames().filter(g => g.home === team || g.away === team).slice(0, 3).map(gameLabel);
      const players = findPlayers(q).slice(0, 5).map(brief);
      if (!players.length && !games.length) return { status: "not_found", note: `Nothing this week matches "${q.slice(0, 40)}".` };
      return { status: "ok", players, games };
    }

    function get_projection(args) {
      const r = resolve(args); if (r.err) return r.err;
      const s = resolveStat(r.p, args.stat); if (s.err) return s.err;
      const { p } = r, { key, proj } = s, st = PM.STATS[key];
      const out = { status: "ok", player: p.name, pos: p.pos, team: p.team, opponent: p.opp, game: gameLabel(p.game),
        prop: st.label, ...history(proj) };
      if (st.fixedLine != null) {
        out.chance_to_score = pct(PM.lineProbs(proj, st.fixedLine).over);
        out.fair_odds = PM.fmtOdds(PM.fairOdds(PM.lineProbs(proj, st.fixedLine).over));
      } else {
        out.most_likely = PM.quantile(proj, 0.5);
        out.typical_range = `${PM.quantile(proj, 0.25)}-${PM.quantile(proj, 0.75)}`;
        out.fair_line = PM.fairLine(proj);
        out.model_average = Number(proj.mean.toFixed(1));
      }
      return out;
    }

    // Prices one side or both. Missing line or odds come from the user's saved props, or the AI asks.
    function priceOne(args, { forParlay = false } = {}) {
      const r = resolve(args); if (r.err) return { err: r.err };
      const s = resolveStat(r.p, args.stat); if (s.err) return { err: s.err };
      const { p } = r, { key, proj } = s, st = PM.STATS[key];
      const side = args.side ? String(args.side).toLowerCase().replace(/^yes$/, "over").replace(/^no$/, "under") : null;
      if (side && !SIDE[side]) return { err: { status: "need_info", missing: ["side"], note: "Side must be over or under." } };
      let line = st.fixedLine != null ? st.fixedLine : toLine(args.line);
      let over = toOdds(args.over_odds), under = toOdds(args.under_odds);
      if (forParlay && args.odds != null) { if (side === "under") under = toOdds(args.odds); else over = toOdds(args.odds); }
      if (Number.isNaN(over) || Number.isNaN(under)) return { err: { status: "bad_odds", note: "Odds must be American odds like -110 or +120 (at least 100 either way)." } };
      if (line != null && !(line >= 0)) return { err: { status: "bad_line", note: "The line must be 0 or more." } };

      const needSide = side || null;
      const haveOdds = () => (needSide ? (needSide === "over" ? over : under) != null : over != null || under != null);
      let source = "your numbers";
      if (line == null || !haveOdds()) {
        const row = savedLines(p, key, line, needSide)[0];
        if (row) {
          if (line == null) line = Number(row.line);
          if (Number(row.line) === line) {
            if (over == null) over = row.over_odds;
            if (under == null) under = row.under_odds;
          }
          source = `your saved prop${row.book ? ` at ${row.book}` : ""}`;
        }
      }
      if (line == null) {
        return { err: { status: "need_info", missing: ["line", "odds"], player: p.name, prop: st.label,
          note: "No saved line for this prop. Ask the user for the sportsbook's line and odds.", model_fair_line: PM.fairLine(proj) } };
      }
      if (!haveOdds()) {
        return { err: { status: "need_info", missing: [needSide ? `${needSide}_odds` : "odds"], player: p.name, prop: st.label, line,
          note: `Ask the user for the ${needSide ? SIDE[needSide].toLowerCase() + " " : ""}odds at their sportsbook.` } };
      }
      const ev = PM.evaluate(proj, line, over, under);
      const chosen = needSide ? ev.sides.find(x => x.side === needSide) : ev.best;
      return { p, key, proj, st, line, ev, chosen, source };
    }

    function verdictFor(chosen, label) {
      const { minEdge } = env.settings();
      if (chosen.ev >= minEdge) return { action: "Suggested", text: `Suggested: ${label}` };
      if (chosen.ev > 0) return { action: "Pass", text: `Pass (lean ${label}, but the ${signedPct(chosen.ev)} edge is below your ${pct(minEdge, 0)} minimum)` };
      return { action: "Pass", text: "Pass (no edge at these odds)" };
    }

    const sideLabel = (st, side, line) => (st.fixedLine != null ? (side === "over" ? "Anytime TD: Yes" : "Anytime TD: No") : `${SIDE[side]} ${line} ${st.short.toLowerCase()}`);
    const newsFlag = ev => ev >= env.config().newsEdge;

    function price_prop(args) {
      const x = priceOne(args); if (x.err) return x.err;
      const { p, st, line, ev, chosen, source, proj } = x;
      const label = sideLabel(st, chosen.side, line);
      const v = verdictFor(chosen, `${label} at ${PM.fmtOdds(chosen.american)}`);
      const stake = v.action === "Suggested" ? stakeFor(chosen) : 0;
      const token = `[[S${++stakeN}]]`;
      const sides = ev.sides.map(sd => ({ side: sd.side, odds: PM.fmtOdds(sd.american), win_chance: pct(sd.prob),
        break_even: pct(sd.breakeven), edge: signedPct(sd.ev), fair_odds: sd.fair != null ? PM.fmtOdds(sd.fair) : null }));
      const other = ev.sides.find(sd => sd.side !== chosen.side);
      const card = { kind: "prop", token, stake, player: p.name, pos: p.pos, game: gameLabel(p.game), bet: label,
        odds: PM.fmtOdds(chosen.american), win: chosen.prob, breakeven: chosen.breakeven, edge: chosen.ev,
        verdict: v.text, action: v.action, news: newsFlag(chosen.ev), little: proj.games < LITTLE_HISTORY,
        games: proj.games, source, push: ev.probs.push };
      cards.push(card);
      return {
        status: "ok", player: p.name, pos: p.pos, team: p.team, opponent: p.opp, game: gameLabel(p.game), prop: st.label,
        line, odds_source: source, bet: label, odds: PM.fmtOdds(chosen.american),
        win_chance: pct(chosen.prob), break_even: pct(chosen.breakeven), edge: signedPct(chosen.ev),
        push_chance: ev.probs.push > 0.001 ? pct(ev.probs.push) : undefined,
        verdict: v.text, suggested_stake: stake > 0 ? `${token} (${pct(stakePct(chosen))} of bankroll)` : `${token} (none, pass)`,
        stake_token: token, min_edge: pct(env.settings().minEdge, 0),
        check_news: newsFlag(chosen.ev), ...history(proj),
        other_side: other && args.side ? { side: other.side, edge: signedPct(other.ev), suggested: other.ev >= env.settings().minEdge } : undefined,
        all_sides: args.side ? undefined : sides,
        model_fair_line: st.fixedLine != null ? undefined : PM.fairLine(proj),
      };
    }

    function price_parlay(args) {
      const legsIn = Array.isArray(args && args.legs) ? args.legs.slice(0, 10) : [];
      if (legsIn.length < 2) return { status: "need_info", missing: ["legs"], note: "A parlay needs at least 2 legs." };
      const legs = [], problems = [];
      legsIn.forEach((l, i) => {
        if (!l || !l.side) { problems.push({ leg: i + 1, status: "need_info", missing: ["side"], note: "Ask over or under for this leg." }); return; }
        const x = priceOne(l, { forParlay: true });
        if (x.err) { problems.push({ leg: i + 1, ...x.err }); return; }
        legs.push(x);
      });
      if (problems.length) return { status: "need_info", legs: problems, note: "Fix or ask about these legs first." };
      const { minEdge } = env.settings();
      const prob = legs.reduce((a, x) => a * x.chosen.prob, 1);
      const legDec = legs.reduce((a, x) => a * PM.decimalOdds(x.chosen.american), 1);
      let parlayOdds = toOdds(args.parlay_odds);
      if (Number.isNaN(parlayOdds)) return { status: "bad_odds", note: "Parlay odds must be American odds like +260." };
      const dec = parlayOdds != null ? PM.decimalOdds(parlayOdds) : legDec;
      if (parlayOdds == null) parlayOdds = dec >= 2 ? Math.round((dec - 1) * 100) : -Math.round(100 / (dec - 1));
      const evP = prob * dec - 1, kelly = evP > 0 ? evP / (dec - 1) : 0;
      const games = legs.map(x => x.p.game.id), sameGame = new Set(games).size < games.length;
      const weak = legs.filter(x => x.chosen.ev < minEdge);
      const bestSingle = legs.reduce((a, x) => Math.max(a, x.chosen.ev), -1);
      const singlesBetter = weak.length > 0 || sameGame || evP < bestSingle;
      const why = weak.length ? `${weak.length} leg${weak.length > 1 ? "s don't clear your " + pct(minEdge, 0) + " minimum on their own" : " doesn't clear your " + pct(minEdge, 0) + " minimum on its own"}`
        : sameGame ? "two or more legs are from the same game, so their results are linked and the model's combined chance is unreliable"
        : evP < bestSingle ? "the best single leg has a bigger edge than the parlay" : "";
      const v = evP >= minEdge && !sameGame
        ? { action: "Suggested", text: `Suggested: the ${legs.length}-leg parlay at ${PM.fmtOdds(parlayOdds)}` }
        : { action: "Pass", text: evP > 0 && !sameGame ? `Pass on the parlay (its ${signedPct(evP)} edge is below your ${pct(minEdge, 0)} minimum)` : "Pass on the parlay" };
      const stake = v.action === "Suggested" ? env.settings().bankroll * Math.min(MAX_STAKE, kelly / 4) : 0;
      const token = `[[S${++stakeN}]]`;
      const legOut = legs.map(x => {
        const label = sideLabel(x.st, x.chosen.side, x.line);
        return { player: x.p.name, bet: label, odds: PM.fmtOdds(x.chosen.american), win_chance: pct(x.chosen.prob),
          break_even: pct(x.chosen.breakeven), edge: signedPct(x.chosen.ev), suggested_alone: x.chosen.ev >= minEdge,
          odds_source: x.source, check_news: newsFlag(x.chosen.ev), little_history: x.proj.games < LITTLE_HISTORY };
      });
      cards.push({ kind: "parlay", token, stake, legs: legOut, odds: PM.fmtOdds(parlayOdds), win: prob, breakeven: 1 / dec,
        edge: evP, verdict: v.text, action: v.action, singlesBetter, why, sameGame,
        news: legOut.some(l => l.check_news), little: legOut.some(l => l.little_history) });
      return {
        status: "ok", legs: legOut, parlay_odds: PM.fmtOdds(parlayOdds),
        parlay_odds_source: args.parlay_odds != null ? "user" : "legs multiplied (standard parlay payout)",
        combined_win_chance: pct(prob), parlay_break_even: pct(1 / dec), parlay_edge: signedPct(evP),
        same_game: sameGame, singles_better: singlesBetter, singles_reason: why || undefined, verdict: v.text,
        suggested_stake: stake > 0 ? `${token} (${pct(Math.min(MAX_STAKE, kelly / 4))} of bankroll)` : `${token} (none, pass)`,
        stake_token: token, min_edge: pct(minEdge, 0),
        note: "Combined chance multiplies the legs, so it assumes they're independent.",
      };
    }

    // Saved props that clear the user's minimum edge, plus the model's top projections (no odds needed).
    function top_suggestions(args) {
      const { minEdge } = env.settings();
      const ids = new Set(env.upcomingGames().map(g => g.id));
      const all = env.players();
      const sugg = [];
      for (const r of env.saved()) {
        if (!ids.has(r.game_id)) continue;
        const p = all.find(x => x.id === r.player_id && x.game.id === r.game_id), proj = p && p.props[r.stat];
        if (!proj) continue;
        const b = PM.evaluate(proj, Number(r.line), r.over_odds, r.under_odds).best;
        if (b) sugg.push({ p, r, b });
      }
      sugg.sort((a, b) => b.b.ev - a.b.ev);
      const limit = Math.min(8, Math.max(1, Number(args && args.limit) || 5));
      const key = args && args.stat ? statKey(PM, args.stat) : null;
      const pos = args && args.position ? String(args.position).toUpperCase() : null;
      const ranked = k => roster().filter(p => p.props[k] && (!pos || p.pos === pos))
        .map(p => ({ p, k, score: PM.STATS[k].fixedLine != null ? PM.lineProbs(p.props[k], 0.5).over : p.props[k].mean }))
        .filter(x => PM.STATS[k].fixedLine != null || x.score >= (PM.STATS[k].kind === "yards" ? 15 : 0.8))
        .sort((a, b) => b.score - a.score).map((x, i) => ({ ...x, rank: i }));
      // All props: every type's #1 first, then every #2 (as Top plays does), one entry per player.
      const merged = key ? ranked(key) : Object.keys(PM.STATS).flatMap(ranked).sort((a, b) => a.rank - b.rank)
        .filter((x, i, arr) => arr.findIndex(y => y.p.id === x.p.id) === i);
      const plays = merged.slice(0, limit).map(({ p, k }) => {
          const proj = p.props[k], st = PM.STATS[k];
          const o = { player: p.name, pos: p.pos, game: gameLabel(p.game), prop: st.label, ...history(proj) };
          if (st.fixedLine != null) o.chance_to_score = pct(PM.lineProbs(proj, 0.5).over);
          else { o.most_likely = PM.quantile(proj, 0.5); o.typical_range = `${PM.quantile(proj, 0.25)}-${PM.quantile(proj, 0.75)}`; o.fair_line = PM.fairLine(proj); }
          return o;
        });
      return {
        status: "ok", min_edge: pct(minEdge, 0),
        saved_props_suggested: sugg.filter(x => x.b.ev >= minEdge).slice(0, limit).map(({ p, r, b }) => ({
          player: p.name, bet: sideLabel(PM.STATS[r.stat], b.side, Number(r.line)), odds: PM.fmtOdds(b.american),
          win_chance: pct(b.prob), edge: signedPct(b.ev), check_news: newsFlag(b.ev), book: r.book || undefined })),
        saved_props_total: sugg.length,
        top_projections: plays,
        note: "Top projections have no sportsbook odds, so they aren't bets yet; the user can give a line and odds to price one.",
      };
    }

    const TOOLS = { find_player, get_projection, price_prop, price_parlay, top_suggestions };
    return {
      names: Object.keys(TOOLS),
      // Runs one tool. Never throws: errors come back as a result the AI can explain.
      run(name, args) {
        if (!TOOLS[name]) return { status: "error", note: `Unknown tool ${String(name).slice(0, 40)}` };
        try { return JSON.parse(JSON.stringify(TOOLS[name](args || {}))); }
        catch (err) { return { status: "error", note: "The model couldn't compute that." }; }
      },
      // Bet cards made since the last reset, with dollar stakes for the panel only.
      takeCards() { const c = cards; cards = []; return c; },
      newQuestion() { cards = []; stakeN = 0; },
    };
  }

  const api = { create, nameScore, statKey, MAX_STAKE };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ChatTools = api;
})(typeof window !== "undefined" ? window : globalThis);
