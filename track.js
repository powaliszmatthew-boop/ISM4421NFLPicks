// Tracking bets from any page: one-click "Track" buttons, the parlay slip, and small shared helpers.
(function () {
  "use strict";

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const decimal = am => (am < 0 ? 1 + 100 / -am : 1 + am / 100);
  const american = dec => (dec >= 2 ? Math.round((dec - 1) * 100) : -Math.round(100 / (dec - 1)));
  const fmtOdds = am => (am > 0 ? `+${am}` : `${am}`);
  const pct = x => `${(x * 100).toFixed(1)}%`;
  const LEG_FIELDS = ["kind", "description", "odds", "model_prob", "market", "game_id", "side", "line",
    "player_id", "player_name", "stat", "season", "week"];
  const SLIP_KEY = "gridiron-parlay-slip";

  // A short message at the bottom of the screen.
  function toast(text, kind = "") {
    let box = document.querySelector(".toast");
    if (!box) {
      box = document.createElement("div");
      box.className = "toast";
      box.setAttribute("role", "status");
      document.body.appendChild(box);
    }
    box.textContent = text;
    box.className = `toast show ${kind}`;
    clearTimeout(box._timer);
    box._timer = setTimeout(() => { box.className = "toast"; }, 4000);
  }

  const client = () => {
    const a = window.GridIronAuth;
    if (!a || !a.client || !a.user) throw new Error("Sign in to track bets");
    return a.client;
  };

  // Stake used when a button doesn't name one: 1% of the bankroll on this page, else $10.
  function defaultStake() {
    const b = Number(document.querySelector("#bankroll") && document.querySelector("#bankroll").value);
    return b > 0 ? Math.max(1, Math.round(b) / 100) : 10;
  }

  // Inserts one row into the bets table. Returns the saved row, or throws.
  async function addBet(bet) {
    const row = { ...bet, stake: Math.round((bet.stake ?? defaultStake()) * 100) / 100 };
    const { data, error } = await client().from("bets").insert(row).select().single();
    if (error) throw error;
    return data;
  }

  async function trackButton(btn, bet) {
    btn.disabled = true;
    try {
      const saved = await addBet(bet);
      btn.textContent = "Tracked ✓";
      toast(`Tracked: ${bet.description} at ${fmtOdds(bet.odds)}, $${Number(saved.stake).toFixed(2)}. Edit odds or stake in My bets.`, "ok");
    } catch (err) {
      btn.disabled = false;
      toast(`Couldn't save the bet: ${err.message}`, "error");
    }
  }

  // ---- "Track" and "+ Parlay" buttons ----------------------------------------
  // Pages call actions(bet) while rendering. bet can be an object or a function that
  // returns one when clicked (for inputs like a stake box that change after rendering).
  const registry = new Map();
  let nextKey = 1;
  function actions(bet, { track = "Track", parlay = true } = {}) {
    const key = String(nextKey++);
    registry.set(key, bet);
    return `<span class="bet-actions"><button type="button" class="track-btn" data-track-key="${key}">${esc(track)}</button>` +
      (parlay ? `<button type="button" class="slip-btn" data-slip-key="${key}" title="Add to parlay slip">+ Parlay</button>` : "") +
      "</span>";
  }
  const resolve = key => { const b = registry.get(key); return typeof b === "function" ? b() : b; };

  document.addEventListener("click", e => {
    const t = e.target.closest("[data-track-key], [data-slip-key]");
    if (!t) return;
    if (t.dataset.trackKey) trackButton(t, resolve(t.dataset.trackKey));
    else slipAdd(resolve(t.dataset.slipKey));
  });

  // ---- Parlay slip -------------------------------------------------------------
  let legs = [];
  try { legs = JSON.parse(localStorage.getItem(SLIP_KEY) || "[]"); } catch { legs = []; }
  let open = false, oddsOverride = "", stake = "";
  const store = () => { try { localStorage.setItem(SLIP_KEY, JSON.stringify(legs)); } catch { /* storage unavailable */ } };

  function slipAdd(bet) {
    const leg = {};
    for (const f of LEG_FIELDS) if (bet[f] != null) leg[f] = bet[f];
    if (leg.kind === "parlay") return;
    if (legs.some(l => l.description === leg.description)) { toast("That leg is already in your parlay slip"); return; }
    if (legs.length >= 20) { toast("A parlay can have at most 20 legs", "error"); return; }
    legs.push(leg);
    oddsOverride = "";
    store();
    renderSlip();
    toast(`Added to parlay slip (${legs.length} leg${legs.length === 1 ? "" : "s"})`, "ok");
  }

  function combined() {
    const dec = legs.reduce((a, l) => a * decimal(l.odds), 1);
    const probs = legs.map(l => l.model_prob);
    const prob = probs.length && probs.every(p => p != null) ? probs.reduce((a, p) => a * Number(p), 1) : null;
    const games = legs.map(l => l.game_id).filter(Boolean);
    return { dec, odds: legs.length ? american(dec) : null, prob, sameGame: new Set(games).size < games.length };
  }

  function slipEls() {
    let root = document.querySelector("#slip");
    if (root) return root;
    root = document.createElement("aside");
    root.id = "slip";
    root.className = "slip";
    root.setAttribute("aria-label", "Parlay slip");
    document.body.appendChild(root);
    root.addEventListener("click", onSlipClick);
    root.addEventListener("input", onSlipInput);
    root.addEventListener("submit", onSlipSubmit);
    return root;
  }

  function renderSlip() {
    const root = slipEls();
    const signedIn = !!(window.GridIronAuth && window.GridIronAuth.user);
    root.hidden = !signedIn;
    if (!signedIn) return;
    const c = combined();
    const oddsUsed = Number(oddsOverride) || c.odds;
    const st = stake === "" ? defaultStake() : Number(stake);
    const payout = oddsUsed ? st * decimal(oddsUsed) : 0;
    const ev = c.prob != null && oddsUsed ? c.prob * decimal(oddsUsed) - 1 : null;
    root.classList.toggle("open", open);
    root.innerHTML = `
      <button type="button" class="slip-toggle" data-slip="toggle" aria-expanded="${open}">
        Parlay slip <span class="slip-count">${legs.length}</span></button>
      <div class="slip-panel"${open ? "" : " hidden"}>
        <div class="slip-head"><strong>Parlay slip</strong>
          <button type="button" class="link" data-slip="toggle">Close</button></div>
        ${legs.length ? `<ol class="slip-legs">${legs.map((l, i) => `<li>
          <div><strong>${esc(l.description)}</strong>
            <div class="muted small">${fmtOdds(l.odds)}${l.model_prob != null ? ` · model ${pct(l.model_prob)}` : ""}</div></div>
          <button type="button" class="link" data-slip-remove="${i}" aria-label="Remove leg">✕</button></li>`).join("")}</ol>`
          : '<p class="muted small">Use the <strong>+ Parlay</strong> buttons on any pick or prop, or add your own leg below.</p>'}
        <form class="slip-custom" data-slip-form="leg">
          <input name="desc" type="text" maxlength="200" placeholder="Custom leg, e.g. Lions ML" required>
          <input name="odds" type="number" step="1" placeholder="Odds" required>
          <button type="submit" class="link">Add leg</button>
        </form>
        ${legs.length >= 2 ? `
          <dl class="slip-sum">
            <div><dt>Combined odds</dt><dd>${fmtOdds(c.odds)}</dd></div>
            <div><dt>Model chance</dt><dd>${c.prob != null ? pct(c.prob) : "–"}</dd></div>
            <div><dt>Edge (EV)</dt><dd class="${ev == null ? "" : ev >= 0 ? "pos" : "neg"}">${ev == null ? "–" : `${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(1)}%`}</dd></div>
            <div><dt>Pays</dt><dd>$${payout.toFixed(2)}</dd></div>
          </dl>
          ${c.sameGame ? '<p class="small warn">Two or more legs are from the same game. Their results are linked, so the real chance can differ from the model\'s, and books price same-game parlays differently.</p>' : ""}
          <div class="slip-fields">
            <label>Book's odds (optional)<input data-slip-input="odds" type="number" step="1" placeholder="${fmtOdds(c.odds)}" value="${esc(oddsOverride)}"></label>
            <label>Stake ($)<input data-slip-input="stake" type="number" min="0" step="1" value="${esc(stake === "" ? st.toFixed(2) : stake)}"></label>
          </div>
          <div class="slip-buttons">
            <button type="button" class="primary small-btn" data-slip="track">Track parlay</button>
            <button type="button" class="link" data-slip="clear">Clear</button>
          </div>` : legs.length ? '<p class="muted small">Add at least one more leg to make a parlay.</p><button type="button" class="link" data-slip="clear">Clear</button>' : ""}
      </div>`;
  }

  async function trackParlay(btn) {
    const c = combined();
    const odds = Number(oddsOverride) || c.odds;
    const st = stake === "" ? defaultStake() : Number(stake);
    if (!Number.isInteger(odds) || (odds > -100 && odds < 100)) { toast("Parlay odds must be like +250 or -120", "error"); return; }
    if (!(st >= 0)) { toast("Stake must be 0 or more", "error"); return; }
    btn.disabled = true;
    const bet = {
      description: `${legs.length}-leg parlay: ${legs.map(l => l.description.replace(/ \(.*\)$/, "")).join(" + ")}`.slice(0, 200),
      odds, stake: Math.round(st * 100) / 100,
      model_prob: c.prob != null ? Number(c.prob.toFixed(5)) : null,
      edge: c.prob != null ? Number((c.prob * decimal(odds) - 1).toFixed(5)) : null,
    };
    try {
      const { error } = await client().rpc("create_parlay", { p_bet: bet, p_legs: legs });
      if (error) throw error;
      toast(`Tracked ${legs.length}-leg parlay at ${fmtOdds(odds)} for $${bet.stake.toFixed(2)}`, "ok");
      legs = []; oddsOverride = ""; stake = ""; open = false;
      store();
      renderSlip();
      document.dispatchEvent(new CustomEvent("gridiron:bets-changed"));
    } catch (err) {
      btn.disabled = false;
      toast(`Couldn't save the parlay: ${err.message}`, "error");
    }
  }

  function onSlipClick(e) {
    const t = e.target;
    if (t.dataset.slip === "toggle") { open = !open; renderSlip(); }
    else if (t.dataset.slip === "clear") { legs = []; oddsOverride = ""; store(); renderSlip(); }
    else if (t.dataset.slip === "track") trackParlay(t);
    else if (t.dataset.slipRemove != null) { legs.splice(Number(t.dataset.slipRemove), 1); oddsOverride = ""; store(); renderSlip(); }
  }

  // Typing in the odds or stake box updates the totals without losing focus.
  function onSlipInput(e) {
    const which = e.target.dataset.slipInput;
    if (!which) return;
    if (which === "odds") oddsOverride = e.target.value; else stake = e.target.value;
    const pos = e.target.selectionStart;
    renderSlip();
    const again = document.querySelector(`[data-slip-input="${which}"]`);
    again.focus();
    try { again.setSelectionRange(pos, pos); } catch { /* number inputs don't support selection */ }
  }

  function onSlipSubmit(e) {
    e.preventDefault();
    const f = e.target;
    const odds = Number(f.odds.value);
    if (!Number.isInteger(odds) || (odds > -100 && odds < 100)) { toast("Odds must be like -110 or +150", "error"); return; }
    slipAdd({ kind: "game", description: f.desc.value.trim(), odds });
  }

  document.addEventListener("gridiron:auth", renderSlip);

  window.GridIronTrack = { esc, toast, addBet, trackButton, actions, decimal, american, fmtOdds, defaultStake };
  window.GridIronSlip = { add: slipAdd };
})();
