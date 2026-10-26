const M = window.NFLModel;
const $ = sel => document.querySelector(sel);
const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
const signed = (x, d = 1) => (x > 0 ? "+" : "") + x.toFixed(d);
const MARKET_NAMES = { ML: "Moneyline", ATS: "Spread", TOT: "Over/Under" };
const MAX_STAKE = 0.03;
const SPLITS_URL = "/.netlify/functions/splits";
const SPLITS_REFRESH_MS = 5 * 60 * 1000;
const SHARP_GAP = 15;     // money % this many points above bets % = sharp sign
const PUBLIC_PCT = 70;    // this share of bets or more = public side
const SPLIT_KEY = { ML: "ml", ATS: "spread", TOT: "total" };

const BOOKS_REFRESH_MS = 15 * 60 * 1000;
const BOOK_NAMES = {
  draftkings: "DraftKings", hardrockbet: "Hard Rock Bet", hardrockbet_fl: "Hard Rock Bet (FL)", fanduel: "FanDuel",
  betmgm: "BetMGM", williamhill_us: "Caesars", espnbet: "theScore Bet", fanatics: "Fanatics", betrivers: "BetRivers",
  bovada: "Bovada",
};
// Unknown keys come straight from The Odds API, so escape them before they reach the HTML.
const bookName = k => (k ? BOOK_NAMES[k] || window.GridIronTrack.esc(k) : "Market line");
// The Odds API uses full team names; the game data uses nflverse abbreviations.
const TEAM_ABBR = {
  "Arizona Cardinals": "ARI", "Atlanta Falcons": "ATL", "Baltimore Ravens": "BAL", "Buffalo Bills": "BUF",
  "Carolina Panthers": "CAR", "Chicago Bears": "CHI", "Cincinnati Bengals": "CIN", "Cleveland Browns": "CLE",
  "Dallas Cowboys": "DAL", "Denver Broncos": "DEN", "Detroit Lions": "DET", "Green Bay Packers": "GB",
  "Houston Texans": "HOU", "Indianapolis Colts": "IND", "Jacksonville Jaguars": "JAX", "Kansas City Chiefs": "KC",
  "Las Vegas Raiders": "LV", "Los Angeles Chargers": "LAC", "Los Angeles Rams": "LA", "Miami Dolphins": "MIA",
  "Minnesota Vikings": "MIN", "New England Patriots": "NE", "New Orleans Saints": "NO", "New York Giants": "NYG",
  "New York Jets": "NYJ", "Philadelphia Eagles": "PHI", "Pittsburgh Steelers": "PIT", "San Francisco 49ers": "SF",
  "Seattle Seahawks": "SEA", "Tampa Bay Buccaneers": "TB", "Tennessee Titans": "TEN", "Washington Commanders": "WAS",
};

let state = null;
let splits = { status: "loading" };
let books = { status: "loading" };

function settings() {
  return {
    minEdge: Number($("#edge").value) / 100,
    markets: [...document.querySelectorAll(".markets input:checked")].map(i => i.value),
    bankroll: Math.max(0, Number($("#bankroll").value) || 0),
  };
}

function kickoff(g) {
  const d = new Date(`${g.date}T12:00:00`);
  const day = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return g.time ? `${day}, ${g.time} ET` : day;
}

function weekLabel(g) {
  return g.type === "REG" ? `Week ${g.week}` : { WC: "Wild Card", DIV: "Divisional", CON: "Conference", SB: "Super Bowl" }[g.type];
}

// Live DraftKings split for a game, matched by teams.
function findSplit(g) {
  if (splits.status !== "ok") return null;
  return splits.games.find(s => s.home === g.home && s.away === g.away) || null;
}

function splitForBet(b) {
  const s = findSplit(b.pred.game);
  return s && s[SPLIT_KEY[b.market]] ? s[SPLIT_KEY[b.market]][b.side] || null : null;
}

// Plain-language reasons behind a pick.
function reasons(bet) {
  const p = bet.pred, g = p.game, f = p.f, out = [];
  const homeSpreadTxt = M.fmtLine(-g.spread);
  if (bet.market === "TOT") {
    out.push(`Recent scoring projects ${f.formTotal.toFixed(1)} points vs. a line of ${g.totalLine}`);
    if (g.dome) out.push("Played indoors");
  } else {
    out.push(`Elo projects ${g.home} by ${signed(f.eloMargin)} (market: ${g.home} ${homeSpreadTxt})`);
    out.push(`Recent point differential projects ${g.home} by ${signed(f.formMargin)}`);
    const rest = (g.homeRest ?? 7) - (g.awayRest ?? 7);
    if (Math.abs(rest) >= 3) out.push(`${rest > 0 ? g.home : g.away} has ${Math.abs(rest)} more days of rest`);
  }
  out.push(`Model ${pct(bet.prob, 1)} vs. ${pct(bet.breakeven, 1)} needed to break even${bet.book ? ` at ${bookName(bet.book)}` : ""}`);
  return out;
}

// A recommended pick as a row for My bets, with what's needed to settle it automatically.
function trackedBet(b, stake) {
  const g = b.pred.game;
  if (stake == null) stake = b.ev > 0 ? settings().bankroll * Math.min(MAX_STAKE, b.kelly / 4) : window.GridIronTrack.defaultStake();
  let line = null;
  if (b.book) line = b.line;
  else if (b.market === "ATS") line = b.side === "home" ? -g.spread : g.spread;
  else if (b.market === "TOT") line = g.totalLine;
  return {
    kind: "game", description: `${b.label} (${g.away} @ ${g.home})${b.book ? ` · ${bookName(b.book)}` : ""}`, odds: b.american,
    stake: Math.round(stake * 100) / 100, model_prob: Number(b.prob.toFixed(5)), edge: Number(b.ev.toFixed(5)),
    market: b.market, game_id: g.id, side: b.side, line, season: g.season, week: g.week,
  };
}

// The same side at other books, best first: " · also FanDuel -3 -105, BetMGM -3.5 -110".
function otherPrices(b) {
  const others = M.betOptions(b.pred).filter(o => o.market === b.market && o.side === b.side && o.book !== b.book)
    .sort((x, y) => y.ev - x.ev).slice(0, 4);
  const price = o => (o.market === "ML" ? M.fmtOdds(o.american) : `${o.label.split(" ").pop()} ${M.fmtOdds(o.american)}`);
  return others.length ? ` <span class="muted small">· also ${others.map(o => `${bookName(o.book)} ${price(o)}`).join(", ")}</span>` : "";
}

function renderPicks() {
  const s = settings();
  const upcoming = state.upcoming;
  const bets = M.selectBets(upcoming, s);
  const box = $("#picks");
  box.innerHTML = "";
  if (!upcoming.length) {
    $("#picks-sub").textContent = "No upcoming games with posted lines right now. Check back when next week's odds are out.";
    return;
  }
  $("#picks-sub").textContent = bets.length
    ? `${bets.length} bet${bets.length > 1 ? "s" : ""} clear a ${pct(s.minEdge)} edge across ${upcoming.length} upcoming games, best first.`
    : `None of the ${upcoming.length} upcoming games clear a ${pct(s.minEdge)} edge. Passing is a valid bet. Lower the edge to see weaker leans.`;
  for (const b of bets) {
    const g = b.pred.game;
    const stake = s.bankroll * Math.min(MAX_STAKE, b.kelly / 4);
    const card = document.createElement("article");
    card.className = "pick";
    card.innerHTML = `
      <div class="pick-top">
        <span class="badge ${b.market}">${MARKET_NAMES[b.market]}</span>
        <span class="muted">${weekLabel(g)} · ${kickoff(g)}</span>
      </div>
      <h3>${b.label} <span class="odds">${M.fmtOdds(b.american)}</span></h3>
      <p class="matchup">${g.away} @ ${g.home}${g.neutral ? " (neutral site)" : ""}</p>
      ${b.book ? `<p class="best-book">Best price: <strong>${bookName(b.book)}</strong>${otherPrices(b)}</p>` : ""}
      <div class="meter" title="Model probability vs. break-even">
        <div class="fill" style="width:${(b.prob * 100).toFixed(1)}%"></div>
        <div class="mark" style="left:${(b.breakeven * 100).toFixed(1)}%"></div>
      </div>
      <dl class="stats">
        <div><dt>Win chance</dt><dd>${pct(b.prob, 1)}</dd></div>
        <div><dt>Edge (EV)</dt><dd class="pos">${signed(b.ev * 100)}%</dd></div>
        <div><dt>Suggested stake</dt><dd>$${stake.toFixed(2)}</dd></div>
      </dl>
      <ul class="why">${reasons(b).map(r => `<li>${r}</li>`).join("")}</ul>
      ${publicLine(b)}
      <div class="card-actions">${window.GridIronTrack.actions(trackedBet(b, stake), { track: "Track bet" })}</div>`;
    box.appendChild(card);
  }
}

function publicLine(b) {
  const sp = splitForBet(b);
  if (!sp || sp.handle == null) return "";
  const gap = sp.handle - sp.bets;
  const note = gap >= SHARP_GAP ? " · sharp money sign" : sp.bets >= PUBLIC_PCT ? " · public side" : "";
  return `<p class="public-line"><strong>Live:</strong> ${sp.handle}% of the money and ${sp.bets}% of bets are on this side${note}</p>`;
}

// One market (moneyline, spread or total) of a game's live splits.
function marketBlock(title, sides, recommended) {
  if (!sides.every(x => x.data && x.data.handle != null)) return "";
  const bar = kind => `<div class="bar" role="img" aria-label="${kind}: ${sides.map(x => `${x.label} ${x.data[kind === "Money" ? "handle" : "bets"]}%`).join(", ")}">
      ${sides.map((x, i) => `<div class="seg s${i}" style="width:${x.data[kind === "Money" ? "handle" : "bets"]}%"></div>`).join("")}
    </div>`;
  const signals = [];
  for (const x of sides) {
    if (x.data.handle - x.data.bets >= SHARP_GAP) signals.push(`<span class="chip sharp">Sharp sign: ${x.label}</span>`);
    else if (x.data.bets >= PUBLIC_PCT) signals.push(`<span class="chip public">Public side: ${x.label}</span>`);
    if (recommended.includes(x.side)) signals.push(`<span class="chip model">Model pick: ${x.label}</span>`);
  }
  return `<div class="mkt">
    <div class="mkt-title">${title}</div>
    <div class="mkt-sides">${sides.map((x, i) => `<div class="side s${i}"><span class="dot"></span><strong>${x.label}</strong>
      <span class="muted small">${x.data.odds != null ? M.fmtOdds(x.data.odds) : ""}</span>
      <div class="small">Money <strong>${x.data.handle}%</strong> · Bets <strong>${x.data.bets}%</strong></div></div>`).join("")}</div>
    <div class="bar-row"><span class="bar-kind">Money</span>${bar("Money")}</div>
    <div class="bar-row"><span class="bar-kind">Bets</span>${bar("Bets")}</div>
    ${signals.length ? `<div class="chips">${signals.join("")}</div>` : ""}
  </div>`;
}

function renderSplits() {
  const box = $("#splits");
  if (splits.status === "loading") { $("#splits-sub").textContent = "Loading live betting splits…"; box.innerHTML = ""; return; }
  if (splits.status === "error") {
    $("#splits-sub").textContent = `Live betting splits are unavailable right now (${splits.error}). They load when the site runs on Netlify; opening index.html directly can't reach them.`;
    box.innerHTML = "";
    return;
  }
  const order = new Map(state ? state.upcoming.map((p, i) => [`${p.game.away}@${p.game.home}`, p]) : []);
  const recs = state ? M.selectBets(state.upcoming, settings()) : [];
  const games = splits.games.slice().sort((a, b) => {
    const ia = [...order.keys()].indexOf(`${a.away}@${a.home}`), ib = [...order.keys()].indexOf(`${b.away}@${b.home}`);
    return (ia < 0 ? 1e3 : ia) - (ib < 0 ? 1e3 : ib);
  });
  const updated = new Date(splits.fetchedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const missing = state ? state.upcoming.filter(p => !findSplit(p.game)).map(p => `${p.game.away} @ ${p.game.home}`) : [];
  $("#splits-sub").textContent = `${games.length} games from ${splits.source}, updated ${updated}.` +
    (missing.length ? ` Not posted yet: ${missing.join(", ")}.` : "");
  box.innerHTML = games.map(s => {
    const pred = order.get(`${s.away}@${s.home}`);
    const when = pred ? `${weekLabel(pred.game)} · ${kickoff(pred.game)}` : window.GridIronTrack.esc(s.time);
    const recSides = m => recs.filter(b => b.pred === pred && b.market === m).map(b => b.side);
    const line = x => (x && x.line != null ? M.fmtLine(x.line) : "");
    return `<article class="split-card">
      <div class="pick-top"><h3>${s.away} @ ${s.home}</h3><span class="muted">${when}</span></div>
      ${marketBlock("Moneyline (who wins)", [
        { side: "away", label: s.away, data: s.ml && s.ml.away },
        { side: "home", label: s.home, data: s.ml && s.ml.home }], recSides("ML"))}
      ${marketBlock("Spread", [
        { side: "away", label: `${s.away} ${line(s.spread && s.spread.away)}`, data: s.spread && s.spread.away },
        { side: "home", label: `${s.home} ${line(s.spread && s.spread.home)}`, data: s.spread && s.spread.home }], recSides("ATS"))}
      ${marketBlock("Over/Under", [
        { side: "over", label: `Over ${s.total && s.total.over ? s.total.over.line : ""}`, data: s.total && s.total.over },
        { side: "under", label: `Under ${s.total && s.total.under ? s.total.under.line : ""}`, data: s.total && s.total.under }], recSides("TOT"))}
    </article>`;
  }).join("") || '<p class="muted">DraftKings has no NFL splits posted for the next 7 days.</p>';
}

async function loadSplits() {
  try {
    const res = await fetch(SPLITS_URL, { cache: "no-store" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(body.games)) throw new Error(body.error || `HTTP ${res.status}`);
    splits = { status: "ok", ...body };
  } catch (err) {
    splits = { status: "error", error: err.message };
  }
  renderSplits();
  if (state) renderPicks();
}

// Every side of a game with the model's chance and edge, each with Track and + Parlay.
// Every side of a game: the best-priced book first, the other books one click deeper.
function sideMenu(p) {
  const opts = M.betOptions(p);
  if (!opts.length) return "–";
  const sides = new Map();
  for (const o of opts) {
    const k = `${o.market}|${o.side}`;
    if (!sides.has(k)) sides.set(k, []);
    sides.get(k).push(o);
  }
  const row = o => `<span><strong>${o.label}</strong> ${M.fmtOdds(o.american)}${o.book ? ` <span class="muted small">${bookName(o.book)}</span>` : ""}
      <span class="muted small">model ${pct(o.prob, 1)} · <span class="${o.ev >= 0 ? "pos" : "neg"}">${signed(o.ev * 100)}%</span></span></span>
    ${window.GridIronTrack.actions(() => trackedBet(o))}`;
  return `<details class="side-menu"><summary>Track a side</summary><ul>${[...sides.values()].map(list => {
    const [best, ...rest] = list.sort((a, b) => b.ev - a.ev);
    return `<li>${row(best)}${rest.length ? `<details class="more-books"><summary>${rest.length} more book${rest.length > 1 ? "s" : ""}</summary>
      <ul>${rest.map(o => `<li>${row(o)}</li>`).join("")}</ul></details>` : ""}</li>`;
  }).join("")}</ul></details>`;
}

// ---- Other sportsbooks ---------------------------------------------------------
// Supabase fetches The Odds API twice a day in season (the key stays in Supabase Vault)
// and caches it in nfl_odds_cache. Each event's prices are matched to an upcoming game.
// Prices and points are forced to numbers (or null) because they're rendered into the page.
const numOrNull = v => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

function bookPrices(ev) {
  const out = {};
  for (const b of ev.bookmakers || []) {
    const row = { updated: b.last_update };
    for (const m of b.markets || []) {
      const by = name => {
        const o = (m.outcomes || []).find(x => x.name === name);
        return o && { price: numOrNull(o.price), point: numOrNull(o.point) };
      };
      if (m.key === "h2h") { row.homeML = by(ev.home_team)?.price ?? null; row.awayML = by(ev.away_team)?.price ?? null; }
      else if (m.key === "spreads") {
        const h = by(ev.home_team), a = by(ev.away_team);
        if (h && h.point != null) { row.homeSpread = h.point; row.homeSpreadOdds = h.price; row.awaySpreadOdds = a ? a.price : null; }
      } else if (m.key === "totals") {
        const o = by("Over"), u = by("Under");
        if (o && o.point != null) { row.total = o.point; row.overOdds = o.price; row.underOdds = u ? u.price : null; }
      }
    }
    out[b.key] = row;
  }
  return out;
}

function attachBooks() {
  if (!state || books.status !== "ok") return;
  for (const p of state.upcoming) p.game.books = null;
  let matched = 0;
  for (const ev of books.events) {
    const home = TEAM_ABBR[ev.home_team], away = TEAM_ABBR[ev.away_team];
    const when = Date.parse(ev.commence_time);
    const p = state.upcoming.find(x => Math.abs(Date.parse(`${x.game.date}T12:00:00Z`) - when) < 3 * 864e5 &&
      ((x.game.home === home && x.game.away === away) || (x.game.home === away && x.game.away === home)));
    if (!p) continue;
    const g = p.game, swapped = g.home !== home, prices = bookPrices(ev);
    g.books = {};
    for (const [key, b] of Object.entries(prices)) {
      const row = swapped ? { updated: b.updated, homeML: b.awayML, awayML: b.homeML,
        homeSpread: b.homeSpread == null ? null : -b.homeSpread, homeSpreadOdds: b.awaySpreadOdds, awaySpreadOdds: b.homeSpreadOdds,
        total: b.total, overOdds: b.overOdds, underOdds: b.underOdds } : b;
      // A spread far from the market line means the match went wrong; leave that book out.
      if (g.spread != null && row.homeSpread != null && Math.abs(row.homeSpread + g.spread) > 7) continue;
      g.books[key] = row;
    }
    if (Object.keys(g.books).length) matched++; else g.books = null;
  }
  books.matched = matched;
}

async function loadBooks() {
  try {
    const sb = window.GridIronAuth && window.GridIronAuth.client;
    if (!sb) throw new Error("not signed in");
    const { data, error } = await sb.from("nfl_odds_cache").select("fetched_at, body").eq("id", 1).maybeSingle();
    if (error) throw error;
    books = data && Array.isArray(data.body) && data.fetched_at
      ? { status: "ok", fetchedAt: data.fetched_at, events: data.body } : { status: "off" };
  } catch (err) {
    books = { status: "error", error: err.message };
  }
  attachBooks();
  renderBooksState();
}

function renderBooksState() {
  const el = $("#books-state");
  if (!el) return;
  if (books.status === "ok") {
    const names = [...new Set(books.events.flatMap(e => (e.bookmakers || []).map(b => b.key)))].map(bookName);
    const at = new Date(books.fetchedAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
    el.textContent = `Prices from ${names.join(", ")} for ${books.matched || 0} upcoming games, updated ${at} (twice a day). Picks use the best price for each side.`;
  } else if (books.status === "error") {
    el.textContent = `Couldn't load other sportsbooks' lines (${books.error}). Picks use the market line.`;
  } else el.textContent = "Other sportsbooks' lines aren't available yet. Picks use the market line.";
}

function renderGames() {
  const rows = state.upcoming.map(p => {
    const g = p.game;
    return `<tr>
      <td>${weekLabel(g)}</td>
      <td><strong>${g.away} @ ${g.home}</strong><div class="muted small">${kickoff(g)}</div></td>
      <td>${g.home} ${M.fmtLine(-g.spread)}</td>
      <td>${pct(p.pHomeWin)} <span class="muted small">(mkt ${pct(p.f.pMkt)})</span></td>
      <td>${pct(p.pHomeCover)}</td>
      <td>${g.totalLine ?? "–"}</td>
      <td>${pct(p.pOver)}</td>
      <td>${sideMenu(p)}</td>
    </tr>`;
  }).join("");
  $("#games").innerHTML = `<thead><tr><th>Week</th><th>Game</th><th>Spread</th><th>Home win</th>
    <th>Home covers</th><th>Total</th><th>Over</th><th>Bet</th></tr></thead><tbody>${rows ||
    '<tr><td colspan="8" class="muted">No upcoming lines posted.</td></tr>'}</tbody>`;
}

function renderRecord() {
  const s = settings();
  const season = Number($("#season").value);
  const preds = state.predictions.filter(p => p.game.season === season && p.game.played);
  const bets = M.selectBets(preds, s);
  const sum = M.summarize(bets);
  const wm = M.winModelMetrics(preds);
  const tile = (label, value, cls = "") => `<div class="tile"><div class="muted small">${label}</div><div class="big ${cls}">${value}</div></div>`;
  $("#tiles").innerHTML =
    tile("Bets", sum.n) +
    tile("Record (W-L-P)", `${sum.w}-${sum.l}-${sum.p}`) +
    tile("Hit rate", sum.w + sum.l ? pct(sum.hitRate, 1) : "–") +
    tile("Units won", signed(sum.units, 2), sum.units >= 0 ? "pos" : "neg") +
    tile("ROI", sum.n ? signed(sum.roi * 100) + "%" : "–", sum.roi >= 0 ? "pos" : "neg") +
    tile("Winner picked (model / market)", wm.n ? `${pct(wm.acc, 1)} / ${pct(wm.mktAcc, 1)}` : "–");

  const weeks = new Map();
  for (const p of preds) {
    const key = p.game.week;
    if (!weeks.has(key)) weeks.set(key, { label: weekLabel(p.game), bets: [] });
  }
  for (const b of bets) weeks.get(b.pred.game.week).bets.push(b);
  let cum = 0;
  const rows = [...weeks.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) => {
    const ws = M.summarize(w.bets);
    cum += ws.units;
    return { label: w.label, ...ws, cum };
  });
  $("#weekly").innerHTML = `<thead><tr><th>Week</th><th>Bets</th><th>W-L-P</th><th>Units</th><th>Running total</th></tr></thead><tbody>${
    rows.map(r => `<tr><td>${r.label}</td><td>${r.n}</td><td>${r.w}-${r.l}-${r.p}</td>
      <td class="${r.units >= 0 ? "pos" : "neg"}">${signed(r.units, 2)}</td>
      <td class="${r.cum >= 0 ? "pos" : "neg"}">${signed(r.cum, 2)}</td></tr>`).join("") ||
    '<tr><td colspan="5" class="muted">No completed games yet.</td></tr>'}</tbody>`;
  renderChart(rows);
}

function renderChart(rows) {
  if (rows.length < 2) { $("#chart").innerHTML = ""; return; }
  const W = 600, H = 160, pad = 28, padRight = 56;
  const vals = [0, ...rows.map(r => r.cum)];
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const x = i => pad + (i * (W - pad - padRight)) / (vals.length - 1);
  const y = v => pad / 2 + ((hi - v) * (H - pad)) / span;
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = vals[vals.length - 1];
  $("#chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Running units won by week, ending at ${signed(last, 2)}">
    <line x1="${pad}" x2="${W - padRight}" y1="${y(0)}" y2="${y(0)}" class="zero"/>
    <text x="${pad - 4}" y="${y(0) + 4}" text-anchor="end" class="axis">0</text>
    <polyline points="${pts}" class="${last >= 0 ? "up" : "down"}"/>
    <text x="${W - padRight + 6}" y="${y(last) + 4}" class="axis">${signed(last, 1)}u</text>
  </svg>`;
}

function renderPower() {
  const season = state.currentSeason;
  const teams = Object.entries(state.teams).filter(([, t]) => t.season === season)
    .sort((a, b) => b[1].elo - a[1].elo);
  $("#power").innerHTML = `<thead><tr><th>#</th><th>Team</th><th>Record</th><th>Elo</th>
    <th>Pts for</th><th>Pts against</th><th>ATS form</th></tr></thead><tbody>${
    teams.map(([abbr, t], i) => `<tr><td>${i + 1}</td><td><strong>${abbr}</strong></td>
      <td>${t.w}-${t.l}${t.t ? "-" + t.t : ""}</td><td>${Math.round(t.elo)}</td>
      <td>${t.pf.toFixed(1)}</td><td>${t.pa.toFixed(1)}</td>
      <td class="${t.ats >= 0 ? "pos" : "neg"}">${signed(t.ats)}</td></tr>`).join("")}</tbody>`;
}

function renderWeights() {
  const titles = { win: "Win model", cover: "Spread model", total: "Over/Under model" };
  $("#weights").innerHTML = Object.entries(state.models).map(([k, m]) => `
    <div><h4>${titles[k]} <span class="muted small">(${m.seen.toLocaleString()} games learned)</span></h4>
    <ul>${m.names.map((n, i) => i === m.offsetIndex ? `<li>${n}: 1.000</li>`
      : `<li>${n}: <span class="${m.w[i] >= 0 ? "pos" : "neg"}">${signed(m.w[i], 3)}</span></li>`).join("")}</ul></div>`).join("");
}

function renderAll() {
  $("#edge-out").textContent = `${$("#edge").value}%`;
  renderPicks();
  renderRecord();
  renderSplits();
}

async function init() {
  loadSplits();
  setInterval(loadSplits, SPLITS_REFRESH_MS);
  $("#refresh-splits").addEventListener("click", () => {
    splits = { status: "loading" };
    renderSplits();
    loadSplits();
  });
  try {
    const games = await M.load();
    const { predictions, teams, models } = M.run(games);
    const played = predictions.filter(p => p.game.played);
    const lastPlayed = played[played.length - 1].game;
    const upcoming = predictions.filter(p => !p.game.played && p.game.spread != null &&
      p.game.season === lastPlayed.season);
    state = { predictions, teams, models, upcoming, currentSeason: lastPlayed.season };

    const seasons = [...new Set(played.filter(p => p.game.season >= 2006).map(p => p.game.season))].reverse();
    $("#season").innerHTML = seasons.map(s => `<option>${s}</option>`).join("");
    $("#status").textContent = `Trained on ${played.length.toLocaleString()} games through the ${lastPlayed.season} ${weekLabel(lastPlayed)} results (${lastPlayed.date}). Reload after new games to update the model.`;

    await loadBooks();
    renderAll();
    renderGames();
    renderPower();
    renderWeights();
    setInterval(async () => { await loadBooks(); renderPicks(); renderGames(); }, BOOKS_REFRESH_MS);
    $("#edge").addEventListener("input", renderAll);
    $("#bankroll").addEventListener("input", renderPicks);
    $("#season").addEventListener("change", renderRecord);
    document.querySelectorAll(".markets input").forEach(i => i.addEventListener("change", renderAll));
  } catch (err) {
    $("#status").textContent = `Couldn't load NFL data: ${err.message}. Check your connection and reload.`;
    $("#status").classList.add("error");
  }
}

// auth.js calls start() once someone signs in; later sign-ins just re-render with their settings.
let started = false;
window.GridIron = {
  start() {
    if (!started) { started = true; init(); }
    else if (state) renderAll();
  },
};
