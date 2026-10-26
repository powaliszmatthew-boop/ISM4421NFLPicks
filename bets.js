const M = window.NFLModel;
const PM = window.PropsModel;
const T = window.GridIronTrack;
const $ = sel => document.querySelector(sel);
const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
const STATS_URL = "/.netlify/functions/player-stats";
const RESULTS = { pending: "Pending", win: "Win", loss: "Loss", push: "Push", void: "Void" };
const GREEN = "var(--green)", RED = "var(--red)";
// Status chip text, chip background, chip text color, row accent.
const STATUS = {
  pending: ["Open", "rgba(255,214,10,.14)", "#ffd60a", "#ffd60a"],
  win: ["Won", "oklch(0.85 0.2 140 / .14)", GREEN, GREEN],
  loss: ["Lost", "oklch(0.7 0.2 25 / .14)", RED, RED],
  push: ["Push", "rgba(142,142,147,.16)", "#aeaeb2", "#636366"],
  void: ["Void", "rgba(142,142,147,.16)", "#aeaeb2", "#636366"],
};
const TYPE_MARKET = { Spread: "ATS", Moneyline: "ML", Total: "TOT", Prop: "PROP" };
const MARKET_TYPE = { ATS: "Spread", ML: "Moneyline", TOT: "Total", PROP: "Prop" };
const PLACEHOLDER = { Spread: "e.g. Bills +2.5", Moneyline: "e.g. Chiefs ML", Total: "e.g. Over 48.5", Prop: "e.g. Mahomes o274.5 pass yds" };
const MAX_BARS = 40;

let bets = [];
let games = new Map();        // game id -> game, from the nflverse schedule
let upcoming = [];            // games not yet played this season, soonest first
let filter = "all";
let betType = "Spread";
let openId = null;            // the row whose edit panel is open

// $1,234 / $57.50 / $50, with an optional + or − sign.
function money(n, signed = false) {
  const a = Math.abs(n);
  const s = "$" + a.toLocaleString("en-US", {
    maximumFractionDigits: a >= 1000 ? 0 : 2,
    minimumFractionDigits: a >= 1000 || Math.round(a * 100) % 100 === 0 ? 0 : 2,
  });
  return signed ? (n > 0.004 ? "+" : n < -0.004 ? "−" : "") + s : s;
}
const oddsStr = o => (o > 0 ? "+" : "−") + Math.abs(o);
const toWin = (odds, stake) => stake * (T.decimal(odds) - 1);
const parseOdds = v => Number(String(v).trim().replace(/^[−–]/, "-").replace(/^\+/, ""));

const db = () => window.GridIronAuth.client;
const today = () => new Date().toLocaleDateString("en-CA");   // YYYY-MM-DD in local time
const oddsOk = am => Number.isInteger(am) && (am <= -100 || am >= 100);

// ---- Parlay math -------------------------------------------------------------
// A parlay loses if any leg loses and wins once every leg is decided with at least one win.
// Pushed or voided legs drop out, and the payout uses only the legs that won.
function parlayResult(legs) {
  if (legs.some(l => l.result === "loss")) return "loss";
  if (legs.some(l => l.result === "pending")) return "pending";
  return legs.some(l => l.result === "win") ? "win" : "push";
}

function payoutOdds(b) {
  if (b.kind !== "parlay" || !b.legs.some(l => l.result === "push" || l.result === "void")) return b.odds;
  return T.american(b.legs.filter(l => l.result === "win").reduce((a, l) => a * T.decimal(l.odds), 1));
}

function profit(b) {
  if (b.result === "win") return b.stake * (T.decimal(payoutOdds(b)) - 1);
  if (b.result === "loss") return -b.stake;
  return 0;
}

const num = v => (v == null ? null : Number(v));

async function loadBets() {
  // The college football site shares this database; its bets are tagged sport = 'cfb'.
  const { data, error } = await db().from("bets").select("*, bet_legs(*)").eq("sport", "nfl")
    .order("placed_on", { ascending: false }).order("created_at", { ascending: false });
  if (error) throw error;
  bets = data.map(b => ({
    ...b, stake: Number(b.stake), line: num(b.line), model_prob: num(b.model_prob), edge: num(b.edge),
    legs: (b.bet_legs || []).map(l => ({ ...l, line: num(l.line), model_prob: num(l.model_prob) }))
      .sort((x, y) => x.position - y.position),
  }));
}

// ---- Automatic settling -----------------------------------------------------
// Game bets settle from final scores; props from the player's stat line once the game is final.
// The same rules grade single bets and parlay legs.
const canAutoGrade = b => b.result === "pending" && b.game_id && b.side && (
  (b.kind === "game" && b.market && (b.market === "ML" || b.line != null)) ||
  (b.kind === "prop" && b.player_id && b.stat && PM.STATS[b.stat] && b.line != null));

function gradeGame(b, g) {
  const margin = g.homeScore - g.awayScore;
  if (b.market === "ML") return margin === 0 ? "push" : (margin > 0) === (b.side === "home") ? "win" : "loss";
  if (b.market === "ATS") {
    const cover = (b.side === "home" ? margin : -margin) + b.line;
    return cover === 0 ? "push" : cover > 0 ? "win" : "loss";
  }
  const total = g.homeScore + g.awayScore;
  return total === b.line ? "push" : (total > b.line) === (b.side === "over") ? "win" : "loss";
}

// Returns "waiting" when the game is final but the player has no stat line yet.
function grade(b, games, stats) {
  const g = games.get(b.game_id);
  if (!g || !g.played) return null;
  if (b.kind === "game") return gradeGame(b, g);
  if (!stats) return null;
  const s = stats.get(`${b.player_id}|${b.season}|${b.week}`);
  if (!s) return "waiting";
  const actual = PM.STATS[b.stat].f(s);
  return actual === b.line ? "push" : (actual > b.line) === (b.side === "over") ? "win" : "loss";
}

async function setParlayFromLegs(b) {
  const result = parlayResult(b.legs);
  if (result === b.result) return false;
  const { error } = await db().from("bets")
    .update({ result, settled_at: result === "pending" ? null : new Date().toISOString() }).eq("id", b.id);
  if (error) return false;
  b.result = result;
  return true;
}

async function autoSettle() {
  const singles = bets.filter(b => b.kind !== "parlay" && canAutoGrade(b));
  const parlays = bets.filter(b => b.kind === "parlay" && b.result === "pending");
  const legs = parlays.flatMap(b => b.legs.filter(canAutoGrade));
  const items = [...singles, ...legs];
  if (!items.length) return { settled: 0, waiting: 0 };
  await loadGames();
  let stats = null;
  if (items.some(b => b.kind === "prop")) {
    const res = await fetch(STATS_URL);
    const body = await res.json().catch(() => ({}));
    if (res.ok && Array.isArray(body.rows)) {
      stats = new Map(body.rows.map(r => {
        const s = {};
        body.cols.forEach((c, i) => { s[c] = r[5 + i]; });
        return [`${r[0]}|${r[3]}|${r[4]}`, s];
      }));
    }
  }
  let settled = 0, waiting = 0;
  for (const b of singles) {
    const result = grade(b, games, stats);
    if (result === "waiting") { waiting++; continue; }
    if (!result) continue;
    const { error } = await db().from("bets").update({ result, settled_at: new Date().toISOString() }).eq("id", b.id);
    if (!error) { b.result = result; settled++; }
  }
  for (const p of parlays) {
    let changed = false;
    for (const l of p.legs.filter(canAutoGrade)) {
      const result = grade(l, games, stats);
      if (result === "waiting") { waiting++; continue; }
      if (!result) continue;
      const { error } = await db().from("bet_legs").update({ result }).eq("id", l.id);
      if (!error) { l.result = result; changed = true; }
    }
    if (changed && await setParlayFromLegs(p) && p.result !== "pending") settled++;
  }
  return { settled, waiting };
}

// ---- Games (for the form, matchups, and final scores) ----------------------------
let gamesLoad = null;
function loadGames() {
  if (!gamesLoad) {
    gamesLoad = M.load().then(list => {
      games = new Map(list.map(g => [g.id, g]));
      const played = list.filter(g => g.played);
      const season = played.length ? played[played.length - 1].season : null;
      const left = list.filter(g => !g.played && g.season === season && g.date)
        .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
      // The form lists the next slate: games within 8 days of the next kickoff.
      const cutoff = left.length ? new Date(Date.parse(`${left[0].date}T12:00:00Z`) + 8 * 864e5).toISOString().slice(0, 10) : "";
      upcoming = left.filter(g => g.date <= cutoff);
    }).catch(err => { gamesLoad = null; throw err; });
  }
  return gamesLoad;
}

function kickoff(g) {
  if (!g.date) return "";
  const day = new Date(`${g.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  if (!g.time) return day;
  const [h, m] = g.time.split(":").map(Number);
  return `${day}, ${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"} ET`;
}
const ROUND = { WC: "Wild Card", DIV: "Divisional round", CON: "Conference title", SB: "Super Bowl" };
const weekName = g => (g.type === "REG" || !ROUND[g.type] ? `Week ${g.week}` : ROUND[g.type]);
const shortDate = d => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

// ---- How a bet reads in the list ---------------------------------------------------
// Tracked bets are described as "Pick (AWAY @ HOME) · Book".
const DESC_RE = /^(.*?) \(([A-Z]{2,3}) @ ([A-Z]{2,3})\)(?: · (.+))?$/;

function view(b) {
  const g = b.game_id ? games.get(b.game_id) : null;
  let pick = b.description, matchup = "", book = "", type;
  if (b.kind === "parlay") {
    pick = `${b.legs.length}-leg parlay`;
    matchup = b.description.replace(/^\d+-leg parlay: /, "");
    type = "Parlay";
  } else {
    const m = DESC_RE.exec(b.description);
    if (m) { pick = m[1]; matchup = `${m[2]} @ ${m[3]}`; book = m[4] || ""; }
    if (!matchup && g) matchup = `${g.away} @ ${g.home}`;
    type = b.kind === "prop" ? "Prop" : MARKET_TYPE[b.market] || "Game";
  }
  const when = b.result === "pending" && g && !g.played ? kickoff(g) : shortDate(b.placed_on);
  const note = [];
  if (b.result === "pending") {
    const auto = b.kind === "parlay" ? b.legs.some(canAutoGrade) : canAutoGrade(b);
    note.push(auto ? "Settles automatically at final" : "Open it to set the result when it's final");
  } else {
    note.push(g && g.played && b.kind !== "parlay" ? `Settled · Final ${g.awayScore}–${g.homeScore}` : "Settled");
    if (b.result === "push" || b.result === "void") note.push("stake returned");
  }
  if (book) note.push(book);
  if (b.notes) note.push(b.notes);
  return { pick, matchup, type, when, note: note.join(" · ") };
}

// ---- Summary ------------------------------------------------------------------------
function summarize() {
  const settled = bets.filter(b => b.result !== "pending");
  const open = bets.filter(b => b.result === "pending");
  const count = r => settled.filter(b => b.result === r).length;
  const staked = bets.reduce((a, b) => a + b.stake, 0);
  return {
    settled, open, staked,
    w: count("win"), l: count("loss"), p: count("push") + count("void"),
    profit: settled.reduce((a, b) => a + profit(b), 0),
    risked: settled.reduce((a, b) => a + b.stake, 0),
    avgStake: bets.length ? staked / bets.length : 0,
  };
}

function renderSummary() {
  const s = summarize();
  const sign = s.profit >= 0 ? GREEN : RED;
  $("#profit").textContent = money(s.profit, true);
  $("#profit").style.color = s.settled.length ? sign : "";
  // 1 unit = your average stake, so units read as "standard bets won".
  const units = s.avgStake ? s.profit / s.avgStake : 0;
  $("#units").textContent = `${units >= 0 ? "+" : "−"}${Math.abs(units).toFixed(1)}u`;
  $("#roi").textContent = `${s.risked ? (s.profit / s.risked * 100).toFixed(1) : "0.0"}% ROI`;
  $("#settled-count").textContent = `${s.settled.length} settled`;

  const chrono = s.settled.slice().sort((a, b) => a.placed_on.localeCompare(b.placed_on) || a.created_at.localeCompare(b.created_at));
  let cum = 0;
  const series = chrono.map(b => (cum += profit(b))).slice(-MAX_BARS);
  const max = Math.max(1, ...series.map(Math.abs));
  $("#bars").innerHTML = series.length
    ? series.map(v => `<div><div style="height:${Math.max(4, Math.abs(v) / max * 100).toFixed(1)}%;background:${v >= 0 ? GREEN : RED}"></div></div>`).join("")
    : '<p class="bars-empty">Your running profit appears here once bets settle.</p>';
  $("#bars").setAttribute("aria-label", series.length
    ? `Running profit after each of the last ${series.length} settled bets, ending at ${money(series[series.length - 1], true)}`
    : "No settled bets yet");

  $("#rec-w").textContent = s.w;
  $("#rec-l").textContent = s.l;
  $("#rec-p").textContent = s.p;
  const rate = s.w + s.l ? Math.round(s.w / (s.w + s.l) * 100) : 0;
  $("#win-rate").textContent = `${rate}%`;
  $("#win-rate-bar").style.width = `${rate}%`;
  $("#wagered").textContent = money(Math.round(s.staked));
  $("#avg-stake").textContent = `Avg stake ${money(Math.round(s.avgStake))}`;
  $("#open-count").textContent = s.open.length;
  $("#open-payout").textContent = `${money(s.open.reduce((a, b) => a + b.stake + toWin(b.odds, b.stake), 0))} potential payout`;

  const best = s.settled.filter(b => b.result === "win").sort((a, b) => profit(b) - profit(a))[0];
  if (best) {
    const v = view(best);
    $("#best-pick").textContent = v.pick;
    $("#best-meta").textContent = [v.matchup, oddsStr(payoutOdds(best))].filter(Boolean).join(" · ");
    $("#best-win").textContent = money(profit(best), true);
  } else {
    $("#best-pick").textContent = "—";
    $("#best-meta").textContent = "Your biggest winning bet shows up here.";
    $("#best-win").textContent = "";
  }
}

// ---- All bets -------------------------------------------------------------------------
const resultSelect = (value, attr) => `<select ${attr} aria-label="Result">${Object.entries(RESULTS).map(([k, v]) =>
  `<option value="${k}"${k === value ? " selected" : ""}>${v}</option>`).join("")}</select>`;

function editPanel(b) {
  const legs = b.kind === "parlay" ? `<ul class="legs">${b.legs.map(l => `<li data-leg="${l.id}">
      <span>${T.esc(l.description)} <span class="muted small mono">${T.fmtOdds(l.odds)}</span>${l.model_prob != null ? ` <span class="muted small">· model ${pct(l.model_prob)}</span>` : ""}</span>
      ${resultSelect(l.result, "data-leg-result")}</li>`).join("")}</ul>
    ${payoutOdds(b) !== b.odds && b.result !== "loss" ? `<div class="muted small">Pushed or voided legs drop out: pays at ${T.fmtOdds(payoutOdds(b))}</div>` : ""}` : "";
  const model = b.model_prob != null
    ? `<div class="muted small">Model ${pct(b.model_prob, 1)}${b.edge != null ? ` · edge ${b.edge >= 0 ? "+" : ""}${(b.edge * 100).toFixed(1)}%` : ""}</div>` : "";
  return `<div class="bet-edit">${legs}${model}
    <div class="edit-fields">
      <label>Odds<input type="number" step="1" value="${b.odds}" data-odds></label>
      <label>Stake ($)<input type="number" min="0" step="1" value="${b.stake.toFixed(2)}" data-stake></label>
      <label>Result${resultSelect(b.result, "data-result")}</label>
      <button type="button" class="danger" data-del>Delete bet</button>
    </div>
  </div>`;
}

function renderList() {
  const counts = { all: bets.length, pending: 0, win: 0, loss: 0 };
  for (const b of bets) if (b.result in counts) counts[b.result]++;
  for (const btn of document.querySelectorAll("#filters button")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.filter === filter));
    btn.querySelector(".count").textContent = counts[btn.dataset.filter];
  }
  const list = filter === "all" ? bets : bets.filter(b => b.result === filter);
  $("#list").innerHTML = list.map(b => {
    const v = view(b), [status, chipBg, chipColor, accent] = STATUS[b.result];
    const p = profit(b);
    const result = b.result === "pending" ? `To win ${money(toWin(b.odds, b.stake))}`
      : b.result === "push" || b.result === "void" ? "$0" : money(p, true);
    const color = b.result === "pending" ? "var(--text)" : p > 0 ? GREEN : p < 0 ? RED : "var(--muted)";
    return `<details class="bet-row" data-id="${b.id}"${b.id === openId ? " open" : ""}>
      <summary>
        <div class="bet-main">
          <div class="accent" style="background:${accent}"></div>
          <div style="min-width:0">
            <div class="bet-meta"><span class="bet-type">${v.type}</span>${v.matchup ? `<span>·</span><span>${T.esc(v.matchup)}</span>` : ""}<span>·</span><span>${T.esc(v.when)}</span></div>
            <div class="bet-pick">${T.esc(v.pick)} <span class="odds">${oddsStr(b.odds)}</span></div>
            <div class="bet-note">${T.esc(v.note)}</div>
          </div>
        </div>
        <div class="bet-side">
          <span class="status-chip" style="background:${chipBg};color:${chipColor}">${status}</span>
          <div class="bet-result" style="color:${color}">${result}</div>
          <div class="bet-risk">Risk ${money(b.stake)}</div>
        </div>
      </summary>
      ${editPanel(b)}
    </details>`;
  }).join("") || `<div class="list-empty">${bets.length ? "No bets here yet." : "No bets yet. Add one above, or use Track on the Game picks and Player props pages."}</div>`;
}

function renderAll() {
  renderSummary();
  renderList();
}

// ---- Editing --------------------------------------------------------------------------
async function updateBet(id, fields) {
  const { error } = await db().from("bets").update(fields).eq("id", id);
  if (error) { T.toast(`Couldn't save: ${error.message}`, "error"); renderList(); return false; }
  Object.assign(bets.find(b => b.id === id), fields);
  renderAll();
  T.toast("Saved", "ok");
  return true;
}

const list = $("#list");
// One edit panel open at a time; remember it across re-renders.
list.addEventListener("toggle", e => {
  const row = e.target;
  if (!row.matches || !row.matches(".bet-row")) return;
  if (row.open) {
    openId = row.dataset.id;
    for (const other of list.querySelectorAll(".bet-row[open]")) if (other !== row) other.open = false;
  } else if (openId === row.dataset.id) openId = null;
}, true);

list.addEventListener("change", async e => {
  const row = e.target.closest(".bet-row");
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.matches("[data-result]")) {
    const result = e.target.value;
    updateBet(id, { result, settled_at: result === "pending" ? null : new Date().toISOString() });
  } else if (e.target.matches("[data-stake]")) {
    const stake = Number(e.target.value);
    if (!(stake >= 0) || e.target.value === "") { T.toast("Stake must be 0 or more", "error"); renderList(); return; }
    updateBet(id, { stake: Math.round(stake * 100) / 100 });
  } else if (e.target.matches("[data-odds]")) {
    const odds = Number(e.target.value);
    if (!oddsOk(odds)) { T.toast("Odds must be like -110 or +150 (at least 100 either way)", "error"); renderList(); return; }
    updateBet(id, { odds });
  } else if (e.target.matches("[data-leg-result]")) {
    const b = bets.find(x => x.id === id), legId = e.target.closest("[data-leg]").dataset.leg;
    const result = e.target.value;
    const { error } = await db().from("bet_legs").update({ result }).eq("id", legId);
    if (error) { T.toast(`Couldn't save: ${error.message}`, "error"); renderList(); return; }
    b.legs.find(l => l.id === legId).result = result;
    await setParlayFromLegs(b);
    renderAll();
    T.toast("Saved", "ok");
  }
});

list.addEventListener("click", async e => {
  if (!e.target.matches("[data-del]")) return;
  const id = e.target.closest(".bet-row").dataset.id;
  if (!confirm("Delete this bet?")) return;
  const { error } = await db().from("bets").delete().eq("id", id);
  if (error) { T.toast(`Couldn't delete: ${error.message}`, "error"); return; }
  bets = bets.filter(b => b.id !== id);
  if (openId === id) openId = null;
  renderAll();
  T.toast("Bet deleted", "ok");
});

$("#filters").addEventListener("click", e => {
  const btn = e.target.closest("[data-filter]");
  if (!btn) return;
  filter = btn.dataset.filter;
  renderList();
});

// ---- Add a bet ------------------------------------------------------------------------
function fillGames() {
  const opts = upcoming.map(g => `<option value="${g.id}">${weekName(g)}: ${g.away} @ ${g.home} — ${kickoff(g)}</option>`);
  $("#a-game").innerHTML = opts.join("") + '<option value="">Another game or bet (not listed)</option>';
  renderTicket();
}

function form() {
  const odds = parseOdds($("#a-odds").value), stake = Number($("#a-stake").value);
  const g = games.get($("#a-game").value) || null;
  const pick = $("#a-pick").value.trim();
  return { g, pick, odds, stake, valid: !!pick && oddsOk(odds) && stake > 0 };
}

function renderTicket() {
  const f = form();
  $("#a-pick").placeholder = PLACEHOLDER[betType];
  $("#t-meta").textContent = f.g ? `${f.g.away} @ ${f.g.home} · ${kickoff(f.g)}` : "Any game or event";
  $("#t-pick").textContent = f.pick || PLACEHOLDER[betType].replace("e.g. ", "");
  $("#t-type").textContent = betType;
  $("#t-odds").textContent = oddsOk(f.odds) ? oddsStr(f.odds) : "—";
  $("#t-risk").textContent = f.stake > 0 ? money(f.stake) : "$0";
  $("#t-win").textContent = f.valid ? money(toWin(f.odds, f.stake)) : "$0";
  $("#a-submit").textContent = f.valid ? `Add bet · to win ${money(toWin(f.odds, f.stake))}` : "Enter pick, odds & stake";
}

function newBet(f) {
  return {
    kind: betType === "Prop" ? "prop" : "game", market: TYPE_MARKET[betType],
    description: f.g ? `${f.pick} (${f.g.away} @ ${f.g.home})` : f.pick,
    odds: f.odds, stake: Math.round(f.stake * 100) / 100,
    ...(f.g ? { game_id: f.g.id, season: f.g.season, week: f.g.week } : {}),
  };
}

$("#a-type").addEventListener("click", e => {
  const btn = e.target.closest("[data-type]");
  if (!btn) return;
  betType = btn.dataset.type;
  for (const b of $("#a-type").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === btn));
  renderTicket();
});
for (const id of ["#a-game", "#a-pick", "#a-odds", "#a-stake"]) $(id).addEventListener("input", renderTicket);

$("#add-form").addEventListener("submit", async e => {
  e.preventDefault();
  const f = form();
  if (!f.pick) { T.toast("Enter your pick", "error"); $("#a-pick").focus(); return; }
  if (!oddsOk(f.odds)) { T.toast("Odds must be like -110 or +150 (at least 100 either way)", "error"); $("#a-odds").focus(); return; }
  if (!(f.stake > 0)) { T.toast("Enter a stake above $0", "error"); $("#a-stake").focus(); return; }
  const btn = $("#a-submit");
  btn.disabled = true;
  try {
    await T.addBet({ ...newBet(f), placed_on: today() });
    $("#a-pick").value = "";
    filter = "all";
    await loadBets();
    renderAll();
    renderTicket();
    T.toast("Bet added. Set its result in All bets when it's final.", "ok");
  } catch (err) {
    T.toast(`Couldn't add the bet: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
  }
});

// "Add to parlay slip instead" puts the ticket in the parlay slip without saving it.
$("#a-slip").addEventListener("click", () => {
  const f = form();
  if (!f.valid) { T.toast("Enter the pick, odds, and stake first", "error"); return; }
  const { stake, ...leg } = newBet(f);
  window.GridIronSlip.add(leg);
  $("#a-pick").value = "";
  renderTicket();
});

document.addEventListener("gridiron:bets-changed", async () => { await loadBets(); renderAll(); });

// ---- Startup ------------------------------------------------------------------------------
const READY = "Newest first. Tap a bet to edit it.";
function setStatus(text, isError = false) {
  $("#status").textContent = text;
  $("#status").classList.toggle("error", isError);
}

async function refresh() {
  renderTicket();
  try {
    await loadBets();
  } catch (err) {
    setStatus(`Couldn't load your bets: ${err.message}`, true);
    return;
  }
  renderAll();
  setStatus(READY);
  try {
    await loadGames();
    fillGames();
    const g = upcoming[0] || [...games.values()].filter(x => x.played).pop();
    if (g) $("#week-label").textContent = `${weekName(g)} · ${g.season} Season`;
    renderAll();
  } catch (err) {
    $("#a-game").innerHTML = '<option value="">Another game or bet (not listed)</option>';
    setStatus(`${READY} Couldn't load the NFL schedule (${err.message}), so automatic settling is paused.`, true);
    return;
  }
  let settled = 0, waiting = 0, settleError = null;
  try {
    ({ settled, waiting } = await autoSettle());
  } catch (err) {
    settleError = err.message;
  }
  renderAll();
  if (settled) T.toast(`Settled ${settled} bet${settled === 1 ? "" : "s"} from final results`, "ok");
  setStatus(READY +
    (settled ? ` Just settled ${settled} from final results.` : "") +
    (waiting ? ` ${waiting} prop${waiting === 1 ? " is" : "s are"} waiting on stat lines (if the player didn't play, mark it Void).` : "") +
    (settleError ? ` Couldn't check results for automatic settling (${settleError}).` : ""), !!settleError);
}

window.GridIron = {
  start() {
    refresh();
  },
};
