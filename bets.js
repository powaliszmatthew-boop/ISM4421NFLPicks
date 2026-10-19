const M = window.NFLModel;
const PM = window.PropsModel;
const T = window.GridIronTrack;
const $ = sel => document.querySelector(sel);
const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
const money = x => `${x < 0 ? "−" : ""}$${Math.abs(x).toFixed(2)}`;
const STATS_URL = "/.netlify/functions/player-stats";
const RESULTS = { pending: "Pending", win: "Win", loss: "Loss", push: "Push", void: "Void" };
const KIND = { game: "Game", prop: "Prop", parlay: "Parlay" };
const BADGE = { game: "ATS", prop: "PROP", parlay: "PARLAY" };

let bets = [];

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
  const games = new Map((await M.load()).map(g => [g.id, g]));
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

// ---- Summary ------------------------------------------------------------------
function summarize(list) {
  const s = { n: 0, w: 0, l: 0, p: 0, staked: 0, profit: 0, pending: 0, pendingStake: 0 };
  for (const b of list) {
    if (b.result === "pending") { s.pending++; s.pendingStake += b.stake; continue; }
    s.n++;
    if (b.result === "win") s.w++; else if (b.result === "loss") s.l++; else s.p++;
    s.staked += b.stake;
    s.profit += profit(b);
  }
  s.roi = s.staked ? s.profit / s.staked : 0;
  return s;
}

function renderSummary() {
  const kind = $("#f-kind").value;
  const list = bets.filter(b => !kind || b.kind === kind);
  const s = summarize(list);
  const tile = (label, value, cls = "") => `<div class="tile"><div class="muted small">${label}</div><div class="big ${cls}">${value}</div></div>`;
  $("#tiles").innerHTML =
    tile("Settled bets", s.n) +
    tile("Record (W-L-P)", `${s.w}-${s.l}-${s.p}`) +
    tile("Win rate", s.w + s.l ? pct(s.w / (s.w + s.l), 1) : "–") +
    tile("Total staked", money(s.staked)) +
    tile("Profit", money(s.profit), s.profit >= 0 ? "pos" : "neg") +
    tile("ROI", s.staked ? `${(s.roi * 100).toFixed(1)}%` : "–", s.roi >= 0 ? "pos" : "neg") +
    tile("Pending", `${s.pending} (${money(s.pendingStake)})`);
  renderChart(list);
}

function renderChart(list) {
  const settled = list.filter(b => b.result !== "pending")
    .sort((a, b) => a.placed_on.localeCompare(b.placed_on) || a.created_at.localeCompare(b.created_at));
  if (settled.length < 2) { $("#chart").innerHTML = ""; return; }
  let cum = 0;
  const vals = [0, ...settled.map(b => (cum += profit(b)))];
  const W = 600, H = 160, pad = 28, padRight = 70;
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const x = i => pad + (i * (W - pad - padRight)) / (vals.length - 1);
  const y = v => pad / 2 + ((hi - v) * (H - pad)) / span;
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = vals[vals.length - 1];
  $("#chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Running profit over ${settled.length} settled bets, ending at ${money(last)}">
    <line x1="${pad}" x2="${W - padRight}" y1="${y(0)}" y2="${y(0)}" class="zero"/>
    <text x="${pad - 4}" y="${y(0) + 4}" text-anchor="end" class="axis">$0</text>
    <polyline points="${pts}" class="${last >= 0 ? "up" : "down"}"/>
    <text x="${W - padRight + 6}" y="${y(last) + 4}" class="axis">${money(last)}</text>
  </svg>`;
}

// ---- Table ----------------------------------------------------------------------
const resultSelect = (value, attr) => `<select ${attr} aria-label="Result">${Object.entries(RESULTS).map(([k, v]) =>
  `<option value="${k}"${k === value ? " selected" : ""}>${v}</option>`).join("")}</select>`;

function legsList(b) {
  const reduced = payoutOdds(b) !== b.odds;
  return `<ol class="legs">${b.legs.map(l => `<li data-leg="${l.id}">
      <span>${T.esc(l.description)} <span class="muted small">${T.fmtOdds(l.odds)}${l.model_prob != null ? ` · model ${pct(l.model_prob)}` : ""}</span></span>
      ${resultSelect(l.result, "data-leg-result")}</li>`).join("")}</ol>
    ${reduced && b.result !== "loss" ? `<div class="muted small">Pushed or voided legs drop out: pays at ${T.fmtOdds(payoutOdds(b))}</div>` : ""}`;
}

function renderList() {
  const kind = $("#f-kind").value, status = $("#f-status").value;
  const list = bets.filter(b => (!kind || b.kind === kind) &&
    (!status || (status === "pending" ? b.result === "pending" : b.result !== "pending")));
  $("#list").innerHTML = `<thead><tr><th>Date</th><th>Type</th><th>Bet</th><th>Odds</th><th>Stake</th>
    <th>Model</th><th>Result</th><th>Profit</th><th></th></tr></thead><tbody>${list.map(b => {
      const p = profit(b);
      const model = b.model_prob != null ? `${pct(b.model_prob, 1)}${b.edge != null ? ` · ${b.edge >= 0 ? "+" : ""}${(b.edge * 100).toFixed(1)}%` : ""}` : "–";
      const auto = b.result === "pending" && (b.kind === "parlay" ? b.legs.some(l => l.game_id) : b.game_id);
      return `<tr data-id="${b.id}">
        <td>${b.placed_on}</td><td><span class="badge ${BADGE[b.kind]}">${KIND[b.kind]}</span></td>
        <td class="wrap-cell"><strong>${T.esc(b.kind === "parlay" ? `${b.legs.length}-leg parlay` : b.description)}</strong>
          ${b.kind === "parlay" ? legsList(b) : ""}
          ${b.notes ? `<div class="muted small">${T.esc(b.notes)}</div>` : ""}
          ${auto ? '<div class="muted small">Settles automatically</div>' : ""}</td>
        <td><input class="cell-input odds-input" type="number" step="1" value="${b.odds}" data-odds aria-label="Odds"></td>
        <td><input class="cell-input" type="number" min="0" step="1" value="${b.stake.toFixed(2)}" data-stake aria-label="Stake"></td>
        <td class="small">${model}</td>
        <td>${resultSelect(b.result, "data-result")}</td>
        <td class="${p > 0 ? "pos" : p < 0 ? "neg" : ""}">${b.result === "pending" ? "–" : money(p)}</td>
        <td><button type="button" class="link" data-del>Delete</button></td></tr>`;
    }).join("") || `<tr><td colspan="9" class="muted">No bets yet. Add one above, or use Track on the picks pages.</td></tr>`}</tbody>`;
}

function renderAll() {
  renderSummary();
  renderList();
}

async function updateBet(id, fields) {
  const { error } = await db().from("bets").update(fields).eq("id", id);
  if (error) { T.toast(`Couldn't save: ${error.message}`, "error"); renderList(); return false; }
  Object.assign(bets.find(b => b.id === id), fields);
  renderAll();
  T.toast("Saved", "ok");
  return true;
}

$("#list").addEventListener("change", async e => {
  const id = e.target.closest("tr").dataset.id;
  if (e.target.matches("[data-result]")) {
    const result = e.target.value;
    updateBet(id, { result, settled_at: result === "pending" ? null : new Date().toISOString() });
  } else if (e.target.matches("[data-stake]")) {
    const stake = Number(e.target.value);
    if (!(stake >= 0)) { T.toast("Stake must be 0 or more", "error"); renderList(); return; }
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

$("#list").addEventListener("click", async e => {
  if (!e.target.matches("[data-del]")) return;
  const id = e.target.closest("tr").dataset.id;
  if (!confirm("Delete this bet?")) return;
  const { error } = await db().from("bets").delete().eq("id", id);
  if (error) { T.toast(`Couldn't delete: ${error.message}`, "error"); return; }
  bets = bets.filter(b => b.id !== id);
  renderAll();
});

$("#add").addEventListener("submit", async e => {
  e.preventDefault();
  const msg = $("#add-msg");
  const odds = Number($("#a-odds").value), stake = Number($("#a-stake").value);
  if (!oddsOk(odds)) {
    msg.textContent = "Odds must be American odds like -110 or +150 (at least 100 either way).";
    msg.className = "auth-msg error";
    return;
  }
  const result = $("#a-result").value;
  const row = {
    kind: $("#a-kind").value, description: $("#a-desc").value.trim(), odds, stake: Math.round(stake * 100) / 100,
    placed_on: $("#a-date").value, result, notes: $("#a-notes").value.trim() || null,
    settled_at: result === "pending" ? null : new Date().toISOString(),
  };
  try {
    await T.addBet(row);
    msg.textContent = `Added: ${row.description}`;
    msg.className = "auth-msg ok";
    $("#a-desc").value = "";
    $("#a-notes").value = "";
    await loadBets();
    renderAll();
  } catch (err) {
    msg.textContent = `Couldn't add the bet: ${err.message}`;
    msg.className = "auth-msg error";
  }
});

// "Add as parlay leg" puts the form's bet in the parlay slip instead of saving it.
$("#a-slip").addEventListener("click", () => {
  const odds = Number($("#a-odds").value), desc = $("#a-desc").value.trim();
  if (!desc || !oddsOk(odds)) { T.toast("Enter the bet and its odds first", "error"); return; }
  window.GridIronSlip.add({ kind: $("#a-kind").value, description: desc, odds });
  $("#a-desc").value = "";
});

$("#f-kind").addEventListener("change", renderAll);
$("#f-status").addEventListener("change", renderList);
document.addEventListener("gridiron:bets-changed", async () => { await loadBets(); renderAll(); });

// ---- Startup ----------------------------------------------------------------------
async function refresh() {
  $("#a-date").value = today();
  try {
    await loadBets();
    renderAll();
    $("#status").textContent = `${bets.length} bet${bets.length === 1 ? "" : "s"} tracked.`;
    let settled = 0, waiting = 0, settleError = null;
    try {
      ({ settled, waiting } = await autoSettle());
    } catch (err) {
      settleError = err.message;
    }
    if (settled) {
      renderAll();
      T.toast(`Settled ${settled} bet${settled === 1 ? "" : "s"} from final results`, "ok");
    } else renderList();
    $("#status").textContent = `${bets.length} bet${bets.length === 1 ? "" : "s"} tracked.` +
      (settled ? ` Just settled ${settled} from final results.` : "") +
      (waiting ? ` ${waiting} prop${waiting === 1 ? " is" : "s are"} waiting on stat lines (if the player didn't play, mark it Void).` : "") +
      (settleError ? ` Couldn't check results for automatic settling (${settleError}).` : "");
  } catch (err) {
    $("#status").textContent = `Couldn't load your bets: ${err.message}`;
    $("#status").classList.add("error");
  }
}

window.GridIron = {
  start() {
    refresh();
  },
};
