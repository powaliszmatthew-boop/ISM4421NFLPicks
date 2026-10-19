const M = window.NFLModel;
const PM = window.PropsModel;
const T = window.GridIronTrack;
const $ = sel => document.querySelector(sel);
const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
const signed = (x, d = 1) => (x > 0 ? "+" : "") + x.toFixed(d);
const STATS_URL = "/.netlify/functions/player-stats";
const MAX_STAKE = 0.03;
const PROJ_ROWS = 40;
const POS_ORDER = { QB: 0, RB: 1, WR: 2, TE: 3 };
const SIDE = { over: "Over", under: "Under" };

let model = null;
let upcomingGames = [];
let players = [];          // active players in this week's games, with projections
let saved = [];            // rows from the props table
let editingId = null;
let showAllProj = false;
let started = false;

function settings() {
  return {
    minEdge: Number($("#edge").value) / 100,
    bankroll: Math.max(0, Number($("#bankroll").value) || 0),
  };
}

const db = () => window.GridIronAuth.client;
const stakeFor = side => (side && side.ev > 0 ? settings().bankroll * Math.min(MAX_STAKE, side.kelly / 4) : 0);
const oddsOk = am => Number.isInteger(am) && (am <= -100 || am >= 100);
const fmtNum = (x, key) => (PM.STATS[key].kind === "yards" ? x.toFixed(1) : x.toFixed(2));

function kickoff(g) {
  const d = new Date(`${g.date}T12:00:00`);
  const day = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return g.time ? `${day}, ${g.time} ET` : day;
}

const findPlayer = (id, gameId) => players.find(p => p.id === id && p.game.id === gameId) || null;
const isUpcoming = row => upcomingGames.some(g => g.id === row.game_id);

// ---- Data -----------------------------------------------------------------
async function loadModel() {
  const [statsRes, games] = await Promise.all([fetch(STATS_URL), M.load()]);
  const body = await statsRes.json().catch(() => ({}));
  if (!statsRes.ok || !Array.isArray(body.rows)) throw new Error(body.error || `player stats returned ${statsRes.status}`);
  model = PM.run(body, games);
  // Unplayed games this week and next, so a Monday night game doesn't hide the coming week.
  const unplayed = games.filter(g => g.season === body.season && !g.played);
  const nextWeek = unplayed.length ? Math.min(...unplayed.map(g => g.week)) : null;
  upcomingGames = unplayed.filter(g => g.week <= nextWeek + 1)
    .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  players = PM.upcoming(model, upcomingGames);
  const weeks = [...new Set(upcomingGames.map(g => g.week))];
  $("#status").textContent = model.last
    ? `Trained on ${model.backtest.length.toLocaleString()} player projections through ${model.last.season} Week ${model.last.week}. ` +
      (upcomingGames.length
        ? `Projecting ${players.length} active players in ${upcomingGames.length} upcoming games (Week${weeks.length > 1 ? "s" : ""} ${weeks.join(" and ")}).`
        : "No upcoming games on the schedule.")
    : "No player stats yet.";
}

async function loadSaved() {
  const { data, error } = await db().from("props").select("*")
    .order("season", { ascending: false }).order("week", { ascending: false }).order("created_at", { ascending: false });
  if (error) throw error;
  saved = data.map(r => ({ ...r, line: Number(r.line), model_mean: r.model_mean == null ? null : Number(r.model_mean),
    model_prob: r.model_prob == null ? null : Number(r.model_prob), model_ev: r.model_ev == null ? null : Number(r.model_ev) }));
}

// The model's current view of a saved prop, or null if the player has no projection.
function price(row) {
  const pl = findPlayer(row.player_id, row.game_id);
  const proj = pl && pl.props[row.stat];
  if (!proj) return null;
  return { pl, proj, ev: PM.evaluate(proj, row.line, row.over_odds, row.under_odds) };
}

const snapshot = pr => pr && pr.ev.best ? {
  model_mean: Number(pr.proj.mean.toFixed(2)), model_side: pr.ev.best.side,
  model_prob: Number(pr.ev.best.prob.toFixed(5)), model_ev: Number(pr.ev.best.ev.toFixed(5)),
  priced_at: new Date().toISOString(),
} : {};

// Keep each upcoming prop's saved model view current, so it's graded on the last pre-game price.
async function refreshSnapshots() {
  for (const row of saved.filter(isUpcoming)) {
    const snap = snapshot(price(row));
    if (!snap.model_side) continue;
    const changed = row.model_side !== snap.model_side || row.model_mean == null ||
      Math.abs(row.model_mean - snap.model_mean) >= 0.05 || Math.abs((row.model_ev ?? 0) - snap.model_ev) >= 0.001;
    if (!changed) continue;
    const { error } = await db().from("props").update(snap).eq("id", row.id);
    if (!error) Object.assign(row, snap);
  }
}

// ---- My props & suggestions ----------------------------------------------
function propBet(row, pr, side, stake) {
  const g = pr.pl.game, st = PM.STATS[row.stat];
  return {
    kind: "prop", description: `${row.player_name} ${SIDE[side.side]} ${row.line} ${st.short} (${g.away} @ ${g.home})`,
    odds: side.american, stake: Math.round(stake * 100) / 100,
    model_prob: Number(side.prob.toFixed(5)), edge: Number(side.ev.toFixed(5)),
    market: "PROP", side: side.side, line: row.line, player_id: row.player_id, player_name: row.player_name,
    stat: row.stat, season: row.season, week: row.week, game_id: row.game_id,
  };
}

function reasonsFor(row, pr) {
  const { proj, ev } = pr, st = PM.STATS[row.stat], out = [];
  out.push(`Model average ${fmtNum(proj.mean, row.stat)} ${st.short.toLowerCase()} vs. a line of ${row.line} (fair line ${PM.fairLine(proj)})`);
  if (Math.abs(proj.defFactor - 1) >= 0.02) out.push(`${proj.opp} defense: ${signed((proj.defFactor - 1) * 100, 0)}% vs. average for ${proj.pos}s`);
  if (proj.implied) out.push(`${proj.team} implied points: ${proj.implied.toFixed(1)}`);
  if (ev.noVig != null) out.push(`Book's no-vig chance of over: ${pct(ev.noVig, 1)}`);
  if (proj.games < 4) out.push(`Only ${proj.games} game${proj.games === 1 ? "" : "s"} of history, so treat with care`);
  return out;
}

function renderMine() {
  const s = settings();
  const box = $("#mine");
  box.innerHTML = "";
  const rows = saved.filter(isUpcoming).map(row => ({ row, pr: price(row) }));
  const ranked = rows.sort((a, b) => (b.pr && b.pr.ev.best ? b.pr.ev.best.ev : -9) - (a.pr && a.pr.ev.best ? a.pr.ev.best.ev : -9));
  const good = ranked.filter(x => x.pr && x.pr.ev.best && x.pr.ev.best.ev >= s.minEdge);
  $("#mine-sub").textContent = !rows.length
    ? "No props saved for this week yet. Price one below and save it."
    : good.length
      ? `${good.length} of ${rows.length} saved props clear a ${pct(s.minEdge)} edge, best first.`
      : `None of your ${rows.length} saved props clear a ${pct(s.minEdge)} edge. Passing is a valid bet.`;
  for (const { row, pr } of ranked) {
    const card = document.createElement("article");
    card.className = "pick";
    const st = PM.STATS[row.stat];
    if (!pr || !pr.ev.best) {
      card.innerHTML = `<h3>${T.esc(row.player_name)} · ${st.label} ${row.line}</h3>
        <p class="muted small">No projection: the player hasn't played in either of his team's last two games, or the odds are missing.</p>
        <div class="card-actions"><button type="button" class="link" data-del="${row.id}">Delete</button></div>`;
      box.appendChild(card);
      continue;
    }
    const b = pr.ev.best, g = pr.pl.game, suggested = b.ev >= s.minEdge, stake = stakeFor(b);
    card.className = `pick${suggested ? "" : " pass"}`;
    card.innerHTML = `
      <div class="pick-top">
        <span class="badge ${suggested ? "PROP" : "PASS"}">${suggested ? `Suggested: ${SIDE[b.side]}` : "Pass"}</span>
        <span class="muted">${kickoff(g)}${row.book ? ` · ${T.esc(row.book)}` : ""}</span>
      </div>
      <h3>${T.esc(row.player_name)} ${SIDE[b.side]} ${row.line} ${st.short} <span class="odds">${PM.fmtOdds(b.american)}</span></h3>
      <p class="matchup">${pr.pl.pos} · ${g.away} @ ${g.home}</p>
      <div class="meter" title="Model probability vs. break-even">
        <div class="fill" style="width:${(b.prob * 100).toFixed(1)}%"></div>
        <div class="mark" style="left:${(b.breakeven * 100).toFixed(1)}%"></div>
      </div>
      <dl class="stats">
        <div><dt>Win chance</dt><dd>${pct(b.prob, 1)}</dd></div>
        <div><dt>Edge (EV)</dt><dd class="${b.ev >= 0 ? "pos" : "neg"}">${signed(b.ev * 100)}%</dd></div>
        <div><dt>Suggested stake</dt><dd>$${stake.toFixed(2)}</dd></div>
      </dl>
      <ul class="why">${reasonsFor(row, pr).map(r => `<li>${T.esc(r)}</li>`).join("")}</ul>
      <div class="card-actions">
        <button type="button" class="track-btn" data-track="${row.id}">Track ${SIDE[b.side].toLowerCase()}</button>
        <button type="button" class="link" data-edit="${row.id}">Edit</button>
        <button type="button" class="link" data-del="${row.id}">Delete</button>
      </div>`;
    box.appendChild(card);
  }
}

$("#mine").addEventListener("click", async e => {
  const t = e.target;
  if (t.dataset.track) {
    const row = saved.find(r => r.id === t.dataset.track), pr = price(row);
    const stake = stakeFor(pr.ev.best) || settings().bankroll * 0.01;
    T.trackButton(t, propBet(row, pr, pr.ev.best, stake));
  } else if (t.dataset.edit) {
    editInCalc(saved.find(r => r.id === t.dataset.edit));
  } else if (t.dataset.del) {
    if (!confirm("Delete this saved prop?")) return;
    const { error } = await db().from("props").delete().eq("id", t.dataset.del);
    if (error) { T.toast(`Couldn't delete: ${error.message}`, "error"); return; }
    saved = saved.filter(r => r.id !== t.dataset.del);
    if (editingId === t.dataset.del) editingId = null;
    renderMine();
    renderPast();
  }
});

// ---- Price a prop ----------------------------------------------------------
function fillGames() {
  $("#c-game").innerHTML = upcomingGames.map(g => `<option value="${g.id}">Wk ${g.week}: ${g.away} @ ${g.home} · ${kickoff(g)}</option>`).join("") ||
    "<option>No upcoming games</option>";
}

function fillPlayers(keepId) {
  const gid = $("#c-game").value;
  const list = players.filter(p => p.game.id === gid && Object.keys(p.props).length)
    .sort((a, b) => (a.team === b.team ? 0 : a.team === a.game.away ? -1 : 1) || POS_ORDER[a.pos] - POS_ORDER[b.pos] ||
      Object.values(b.props)[0].mean - Object.values(a.props)[0].mean);
  $("#c-player").innerHTML = list.map(p => `<option value="${p.id}">${T.esc(p.name)} · ${p.pos} ${p.team}</option>`).join("");
  if (keepId && list.some(p => p.id === keepId)) $("#c-player").value = keepId;
}

function fillStats(keepKey) {
  const pl = findPlayer($("#c-player").value, $("#c-game").value);
  const keys = pl ? Object.keys(pl.props) : [];
  const current = keepKey || $("#c-stat").value;
  $("#c-stat").innerHTML = keys.map(k => `<option value="${k}">${PM.STATS[k].label}</option>`).join("");
  if (keys.includes(current)) $("#c-stat").value = current;
}

function setFairLine() {
  const pl = findPlayer($("#c-player").value, $("#c-game").value);
  const proj = pl && pl.props[$("#c-stat").value];
  if (proj) $("#c-line").value = PM.fairLine(proj);
}

function calcInputs() {
  const pl = findPlayer($("#c-player").value, $("#c-game").value);
  const key = $("#c-stat").value;
  return {
    pl, key, proj: pl && pl.props[key], line: Number($("#c-line").value),
    over: Number($("#c-over").value), under: Number($("#c-under").value), book: $("#c-book").value.trim(),
  };
}

function renderCalc() {
  const out = $("#calc-out");
  const c = calcInputs();
  if (!c.proj) { out.innerHTML = '<p class="muted">Pick a player and prop.</p>'; return; }
  if (!(c.line >= 0) || $("#c-line").value === "") { out.innerHTML = '<p class="error-text">Enter a line of 0 or more.</p>'; return; }
  if (!oddsOk(c.over) || !oddsOk(c.under)) {
    out.innerHTML = '<p class="error-text">Odds must be American odds like -110 or +120 (at least 100 either way).</p>';
    return;
  }
  const s = settings(), st = PM.STATS[c.key];
  const ev = PM.evaluate(c.proj, c.line, c.over, c.under);
  const best = ev.best, suggested = best.ev >= s.minEdge;
  const stake = stakeFor(best);
  const row = side => {
    const x = ev.sides.find(v => v.side === side);
    return `<tr><td><strong>${SIDE[side]} ${c.line}</strong></td><td>${PM.fmtOdds(x.american)}</td><td>${pct(x.prob, 1)}</td>
      <td>${pct(x.breakeven, 1)}</td><td class="${x.ev >= 0 ? "pos" : "neg"}">${signed(x.ev * 100)}%</td>
      <td>${x.fair != null ? PM.fmtOdds(x.fair) : "–"}</td></tr>`;
  };
  out.innerHTML = `
    <p class="calc-proj"><strong>${T.esc(c.pl.name)}</strong> ${st.label.toLowerCase()}: model average <strong>${fmtNum(c.proj.mean, c.key)}</strong>,
      fair line <strong>${PM.fairLine(c.proj)}</strong>${ev.probs.push > 0.001 ? `, push chance ${pct(ev.probs.push, 1)}` : ""}.</p>
    <div class="scroll"><table class="table">
      <thead><tr><th>Side</th><th>Odds</th><th>Win chance</th><th>Break-even</th><th>Edge (EV)</th><th>Fair odds</th></tr></thead>
      <tbody>${row("over")}${row("under")}</tbody></table></div>
    <p class="verdict ${suggested ? "pos" : ""}">${suggested
      ? `Suggested: ${SIDE[best.side]} ${c.line} at ${PM.fmtOdds(best.american)}, a ${signed(best.ev * 100)}% edge. Suggested stake $${stake.toFixed(2)}.`
      : best.ev > 0
        ? `Lean ${SIDE[best.side].toLowerCase()} (${signed(best.ev * 100)}% edge), below your ${pct(s.minEdge)} minimum. Pass.`
        : "No edge on either side at these odds. Pass."}</p>
    <div class="calc-actions">
      <label class="inline">Stake ($) <input id="c-stake" type="number" min="0" step="1" value="${(stake || s.bankroll * 0.01).toFixed(2)}"></label>
      <button type="button" class="primary small-btn" id="c-save">${editingId ? "Update saved prop" : "Save to my props"}</button>
      <button type="button" class="track-btn" data-side="over">Track over</button>
      <button type="button" class="track-btn" data-side="under">Track under</button>
      ${editingId ? '<button type="button" class="link" id="c-cancel">Cancel edit</button>' : ""}
    </div>`;
}

$("#calc-out").addEventListener("click", async e => {
  const t = e.target, c = calcInputs();
  if (!c.proj) return;
  const g = c.pl.game;
  const row = { season: g.season, week: g.week, game_id: g.id, player_id: c.pl.id, player_name: c.pl.name,
    team: c.pl.team, opponent: c.pl.opp, stat: c.key, line: c.line, over_odds: c.over, under_odds: c.under, book: c.book || null };
  if (t.id === "c-save") {
    const snap = snapshot({ proj: c.proj, ev: PM.evaluate(c.proj, c.line, c.over, c.under) });
    t.disabled = true;
    const q = editingId
      ? db().from("props").update({ ...row, ...snap }).eq("id", editingId)
      : db().from("props").insert({ ...row, ...snap });
    const { error } = await q;
    t.disabled = false;
    if (error) { T.toast(`Couldn't save: ${error.message}`, "error"); return; }
    T.toast(editingId ? "Saved prop updated" : `Saved: ${c.pl.name} ${PM.STATS[c.key].short} ${c.line}`, "ok");
    editingId = null;
    await loadSaved();
    renderMine();
    renderCalc();
  } else if (t.dataset.side) {
    const side = PM.evaluate(c.proj, c.line, c.over, c.under).sides.find(x => x.side === t.dataset.side);
    const stake = Math.max(0, Number($("#c-stake").value) || 0);
    T.trackButton(t, propBet(row, { pl: c.pl }, side, stake));
  } else if (t.id === "c-cancel") {
    editingId = null;
    renderCalc();
  }
});

function editInCalc(row) {
  if (!upcomingGames.some(g => g.id === row.game_id)) return;
  editingId = row.id;
  $("#c-game").value = row.game_id;
  fillPlayers(row.player_id);
  fillStats(row.stat);
  $("#c-line").value = row.line;
  $("#c-over").value = row.over_odds ?? -110;
  $("#c-under").value = row.under_odds ?? -110;
  $("#c-book").value = row.book || "";
  renderCalc();
  $("#calc-h").scrollIntoView({ behavior: "smooth" });
}

function priceInCalc(id, gameId, key) {
  editingId = null;
  $("#c-game").value = gameId;
  fillPlayers(id);
  fillStats(key);
  setFairLine();
  renderCalc();
  $("#calc-h").scrollIntoView({ behavior: "smooth" });
}

$("#c-game").addEventListener("change", () => { fillPlayers(); fillStats(); setFairLine(); renderCalc(); });
$("#c-player").addEventListener("change", () => { fillStats(); setFairLine(); renderCalc(); });
$("#c-stat").addEventListener("change", () => { setFairLine(); renderCalc(); });
for (const id of ["#c-line", "#c-over", "#c-under", "#c-book"]) $(id).addEventListener("input", renderCalc);
$("#calc").addEventListener("submit", e => e.preventDefault());

// ---- Projections table ----------------------------------------------------
function renderProj() {
  const key = $("#p-stat").value, pos = $("#p-pos").value, term = $("#p-search").value.trim().toLowerCase();
  const st = PM.STATS[key];
  const list = players.filter(p => p.props[key] && (!pos || p.pos === pos) &&
      (!term || p.name.toLowerCase().includes(term) || p.team.toLowerCase() === term || p.opp.toLowerCase() === term))
    .sort((a, b) => b.props[key].mean - a.props[key].mean);
  const shown = showAllProj ? list : list.slice(0, PROJ_ROWS);
  $("#proj").innerHTML = `<thead><tr><th>Player</th><th>Game</th><th>Avg ${st.short}</th><th>Fair line</th>
    <th>Over fair line</th><th>Games</th><th></th></tr></thead><tbody>${shown.map(p => {
      const pr = p.props[key], fl = PM.fairLine(pr), probs = PM.lineProbs(pr, fl);
      return `<tr><td><strong>${T.esc(p.name)}</strong> <span class="muted small">${p.pos}</span></td>
        <td>${p.team} ${p.team === p.game.home ? "vs" : "@"} ${p.opp}</td><td>${fmtNum(pr.mean, key)}</td><td>${fl}</td>
        <td>${pct(probs.over, 0)}</td><td>${pr.games}</td>
        <td><button type="button" class="link" data-price="${p.id}" data-game="${p.game.id}">Price it</button></td></tr>`;
    }).join("") || `<tr><td colspan="7" class="muted">No players match.</td></tr>`}</tbody>`;
  $("#p-more").hidden = showAllProj || list.length <= PROJ_ROWS;
  $("#p-more").textContent = `Show all ${list.length}`;
}

$("#proj").addEventListener("click", e => {
  if (e.target.dataset.price) priceInCalc(e.target.dataset.price, e.target.dataset.game, $("#p-stat").value);
});
$("#p-more").addEventListener("click", () => { showAllProj = true; renderProj(); });
for (const id of ["#p-stat", "#p-pos"]) $(id).addEventListener("change", () => { showAllProj = false; renderProj(); });
$("#p-search").addEventListener("input", () => { showAllProj = false; renderProj(); });

// ---- Past props ------------------------------------------------------------
function renderPast() {
  const past = saved.filter(r => !isUpcoming(r));
  let n = 0, w = 0, l = 0, p = 0, sugN = 0, sugUnits = 0, sugW = 0, sugL = 0;
  const s = settings();
  const rows = past.map(r => {
    const st = PM.STATS[r.stat];
    const actual = model.actual(r.player_id, r.season, r.week, r.stat);
    let res = "–", cls = "";
    if (actual != null && r.model_side) {
      const outcome = actual === r.line ? "push" : (actual > r.line) === (r.model_side === "over") ? "win" : "loss";
      res = { win: "Won", loss: "Lost", push: "Push" }[outcome];
      cls = { win: "pos", loss: "neg", push: "" }[outcome];
      n++;
      if (outcome === "win") w++; else if (outcome === "loss") l++; else p++;
      if (r.model_ev != null && r.model_ev >= s.minEdge) {
        sugN++;
        const am = r.model_side === "over" ? r.over_odds : r.under_odds;
        if (outcome === "win") { sugW++; sugUnits += PM.decimalOdds(am) - 1; } else if (outcome === "loss") { sugL++; sugUnits -= 1; }
      }
    }
    return `<tr><td>${r.season} Wk ${r.week}</td><td><strong>${T.esc(r.player_name)}</strong></td><td>${st ? st.short : T.esc(r.stat)} ${r.line}</td>
      <td>${r.over_odds != null ? PM.fmtOdds(r.over_odds) : "–"} / ${r.under_odds != null ? PM.fmtOdds(r.under_odds) : "–"}</td>
      <td>${r.model_side ? `${SIDE[r.model_side]} (${pct(r.model_prob, 0)}, ${signed(r.model_ev * 100)}%)` : "–"}</td>
      <td>${actual == null ? '<span class="muted">No stats yet</span>' : actual}</td><td class="${cls}">${res}</td>
      <td><button type="button" class="link" data-del-past="${r.id}">Delete</button></td></tr>`;
  });
  const tile = (label, value, c = "") => `<div class="tile"><div class="muted small">${label}</div><div class="big ${c}">${value}</div></div>`;
  $("#past-sum").innerHTML = past.length
    ? tile("Graded props", n) + tile("Model side (W-L-P)", `${w}-${l}-${p}`) +
      tile("Hit rate", w + l ? pct(w / (w + l), 1) : "–") +
      tile(`Suggested at ${pct(s.minEdge)}+ (W-L)`, `${sugW}-${sugL}`) +
      tile("Suggested units won", sugN ? signed(sugUnits, 2) : "–", sugUnits >= 0 ? "pos" : "neg")
    : "";
  $("#past").innerHTML = `<thead><tr><th>Week</th><th>Player</th><th>Prop</th><th>Odds (o/u)</th><th>Model side</th>
    <th>Actual</th><th>Model side result</th><th></th></tr></thead><tbody>${rows.join("") ||
    '<tr><td colspan="8" class="muted">No past props yet. Props you save show up here after their game.</td></tr>'}</tbody>`;
}

$("#past").addEventListener("click", async e => {
  const id = e.target.dataset.delPast;
  if (!id || !confirm("Delete this saved prop?")) return;
  const { error } = await db().from("props").delete().eq("id", id);
  if (error) { T.toast(`Couldn't delete: ${error.message}`, "error"); return; }
  saved = saved.filter(r => r.id !== id);
  renderPast();
});

// ---- Startup ---------------------------------------------------------------
function renderAll() {
  $("#edge-out").textContent = `${$("#edge").value}%`;
  renderMine();
  renderCalc();
  renderPast();
}

async function init() {
  try {
    await loadModel();
  } catch (err) {
    $("#status").textContent = `Couldn't load player stats: ${err.message}. The props model runs on the deployed site; opening the file directly can't reach it.`;
    $("#status").classList.add("error");
    return;
  }
  $("#p-stat").innerHTML = Object.entries(PM.STATS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
  $("#p-stat").value = "rec_yds";
  fillGames();
  fillPlayers();
  fillStats();
  setFairLine();
  renderProj();
  await refreshUser();
  $("#edge").addEventListener("input", renderAll);
  $("#bankroll").addEventListener("input", () => { renderMine(); renderCalc(); });
}

// Saved props belong to whoever is signed in, so reload them on every sign-in.
async function refreshUser() {
  try {
    await loadSaved();
    await refreshSnapshots();
  } catch (err) {
    T.toast(`Couldn't load your saved props: ${err.message}`, "error");
  }
  renderAll();
}

window.GridIron = {
  start() {
    if (!started) { started = true; init(); }
    else if (model) refreshUser();
  },
};
