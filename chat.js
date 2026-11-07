// "Ask the model" chat panel on the Player props page. Signed-in users only.
// Questions go to the Supabase Edge Function `ask-model`, which talks to the AI provider.
// When the AI asks for numbers, the tools in chat-tools.js run here, on the model and saved
// props this page already loaded, and only their results go back. Dollar stakes stay on
// this page: the AI sees a % of bankroll and a token like [[S1]] that's filled in below.
(function () {
  "use strict";

  const T = window.GridIronTrack, PM = window.PropsModel, D = () => window.GridIronProps;
  const q = sel => document.querySelector(sel);
  const pct = x => `${(x * 100).toFixed(1)}%`;
  const signed = x => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
  const money = x => `$${(Math.round(x * 100) / 100).toFixed(2)}`;
  const HISTORY = 3;             // past exchanges sent with each question (the server caps this too)
  const MAX_LEN = 500;

  let open = false, busy = false, newsEdge = 0.15, tools = null;
  let history = [];              // [{ q, a }] with stake tokens, never dollars
  let lastContext = "";          // the last bet priced, so "what about the under?" works

  document.body.insertAdjacentHTML("beforeend", `
    <button id="chat-toggle" class="chat-toggle" type="button" aria-expanded="false" aria-controls="chat-panel" hidden>
      <span class="chat-dot" aria-hidden="true"></span>Ask the model
    </button>
    <section id="chat-panel" class="chat-panel" role="dialog" aria-modal="false" aria-labelledby="chat-title" hidden>
      <header class="chat-head">
        <strong id="chat-title">Ask the model</strong>
        <button type="button" class="link chat-close" id="chat-close" aria-label="Close chat">Close</button>
      </header>
      <p class="chat-notice">Questions are processed by a third-party AI service. Don't include personal details.</p>
      <div id="chat-log" class="chat-log" aria-live="polite"></div>
      <form id="chat-form" class="chat-form">
        <textarea id="chat-input" rows="2" maxlength="${MAX_LEN}" placeholder="Ask about a prop, e.g. Should I take the over 85.5 rush yards at -115?" aria-label="Your question"></textarea>
        <button id="chat-send" type="submit" class="primary small-btn">Ask</button>
      </form>
      <footer class="chat-foot">
        <span>Model estimates, not guarantees. Gambling problem? Call <a href="tel:18004264537">1-800-GAMBLER</a>.</span>
        <span id="chat-left" class="chat-left"></span>
      </footer>
    </section>`);

  // A second way in, from the page's menu bar, in case something else covers the corner button
  // (Netlify can show its own badge in the bottom-right corner).
  const navBar = q(".lnav .nav");
  if (navBar) navBar.insertAdjacentHTML("afterbegin", '<a href="#chat" id="chat-nav" class="pill-link" hidden>Ask the model</a>');
  const navBtn = q("#chat-nav");

  const toggle = q("#chat-toggle"), panel = q("#chat-panel"), log = q("#chat-log");
  const form = q("#chat-form"), input = q("#chat-input"), send = q("#chat-send");
  const client = () => window.GridIronAuth && window.GridIronAuth.client;

  function getTools() {
    if (tools) return tools;
    const d = D();
    tools = window.ChatTools.create({ PM, players: d.players, saved: d.saved, upcomingGames: d.upcomingGames,
      settings: d.settings, kickoff: d.kickoff, config: () => ({ newsEdge }) });
    return tools;
  }

  // ---- Rendering --------------------------------------------------------------
  const scroll = () => { log.scrollTop = log.scrollHeight; };
  function bubble(kind, html) {
    const el = document.createElement("div");
    el.className = `chat-msg ${kind}`;
    el.innerHTML = html;
    log.appendChild(el);
    scroll();
    return el;
  }

  // Plain text from the AI: escaped, with **bold**, line breaks, stake tokens filled in,
  // and "Price a prop" linked to the calculator.
  function format(text, cards) {
    let s = T.esc(text);
    // The AI sometimes writes "$[[S1]]"; either way it becomes one dollar amount.
    for (const c of cards) s = s.replace(new RegExp(`\\$?${c.token.replace(/[[\]]/g, "\\$&")}`, "g"), () => `<strong>${money(c.stake)}</strong>`);
    s = s.replace(/\$?\[\[S\d+\]\]/g, "");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>");
    return s.replace(/Price a prop/g, '<a href="#calc-h" data-chat-link>Price a prop</a>');
  }

  function flags(c) {
    return (c.news ? `<p class="chat-flag warn">Edge is unusually large (${Math.round(newsEdge * 100)}%+). Check injury and lineup news before betting: the market may know something the model doesn't.</p>` : "") +
      (c.little ? `<p class="chat-flag muted">Little history: the model has seen only ${c.games ?? "a few"} game${c.games === 1 ? "" : "s"} from this player.</p>` : "");
  }

  function stats(c, stakeLabel = "Stake") {
    return `<div class="meter" title="Win chance vs. break-even"><div class="fill" style="width:${(Math.min(1, c.win) * 100).toFixed(1)}%"></div>
        <div class="mark" style="left:${(Math.min(1, c.breakeven) * 100).toFixed(1)}%"></div></div>
      <dl class="chat-stats">
        <div><dt>Win chance</dt><dd>${pct(c.win)}</dd></div>
        <div><dt>Break-even</dt><dd>${pct(c.breakeven)}</dd></div>
        <div><dt>Edge</dt><dd class="${c.edge >= 0 ? "pos" : "neg"}">${signed(c.edge)}</dd></div>
        <div><dt>${stakeLabel}</dt><dd>${money(c.stake)}</dd></div>
      </dl>`;
  }

  function card(c) {
    const ok = c.action === "Suggested";
    if (c.kind === "parlay") {
      return `<div class="chat-card${ok ? "" : " pass"}">
        <div class="chat-card-top"><span class="badge ${ok ? "PARLAY" : "PASS"}">${ok ? "Suggested" : "Pass"}</span>
          <span class="muted small">${c.legs.length}-leg parlay · ${T.esc(c.odds)}</span></div>
        <ul class="chat-legs">${c.legs.map(l => `<li><strong>${T.esc(l.player)}</strong> ${T.esc(l.bet)} <span class="mono small">${T.esc(l.odds)}</span>
          <span class="muted small">· ${T.esc(l.win_chance)} win · <span class="${l.edge.startsWith("-") ? "neg" : "pos"}">${T.esc(l.edge)}</span></span></li>`).join("")}</ul>
        ${stats(c)}
        <p class="chat-verdict">${T.esc(c.verdict)}</p>
        ${c.singlesBetter ? `<p class="chat-flag warn">Singles are better: ${T.esc(c.why)}.</p>` : ""}
        ${flags(c)}
      </div>`;
    }
    return `<div class="chat-card${ok ? "" : " pass"}">
      <div class="chat-card-top"><span class="badge ${ok ? "PROP" : "PASS"}">${ok ? "Suggested" : "Pass"}</span>
        <span class="muted small">${T.esc(c.game)}</span></div>
      <p class="chat-bet"><strong>${T.esc(c.player)}</strong> ${T.esc(c.bet)} <span class="mono">${T.esc(c.odds)}</span></p>
      ${stats(c)}
      <p class="chat-verdict">${T.esc(c.verdict)}</p>
      ${flags(c)}
      ${c.source !== "your numbers" ? `<p class="chat-flag muted">Line and odds from ${T.esc(c.source)}.</p>` : ""}
    </div>`;
  }

  function busyMessage(text) {
    return `<p>${T.esc(text).replace(/Price a prop/g, '<a href="#calc-h" data-chat-link>Price a prop</a>')}</p>`;
  }

  function setLeft(remaining, limit) {
    if (remaining == null) return;
    q("#chat-left").textContent = `${remaining} of ${limit} questions left today`;
  }

  // Example questions built from this week's projections, so they always name a real player.
  function examples() {
    const d = D();
    const out = [];
    if (d && d.ready()) {
      const rb = d.players().filter(p => p.props.rush_yds).sort((a, b) => b.props.rush_yds.mean - a.props.rush_yds.mean)[0];
      if (rb) out.push(`Should I take ${rb.name} over ${PM.fairLine(rb.props.rush_yds)} rush yards at -115?`);
      const wr = d.players().filter(p => p.pos === "WR" && p.props.rec_yds).sort((a, b) => b.props.rec_yds.mean - a.props.rec_yds.mean)[0];
      if (wr) out.push(`What does the model expect from ${wr.name}?`);
    }
    out.push("What are this week's top suggestions?");
    return out;
  }

  function showEmpty() {
    if (log.children.length) return;
    bubble("bot intro", `<p>Ask whether the model likes a player prop or parlay this week. Every number comes from the same model as the rest of this page.</p>
      <div class="chat-examples">${examples().map(e => `<button type="button" class="chat-example">${T.esc(e)}</button>`).join("")}</div>`);
  }

  // ---- Talking to the Edge Function -------------------------------------------
  async function invoke(body) {
    const { data, error } = await client().functions.invoke("ask-model", { body });
    if (error) {
      let msg = "";
      try { msg = (await error.context.json()).message; } catch { /* no body */ }
      return { type: "error", message: msg || "Couldn't reach the chat. Check your connection and try again." };
    }
    return data;
  }

  async function status() {
    const r = await invoke({ action: "status" });
    if (r && r.type === "status") setLeft(r.remaining, r.limit);
  }

  async function ask(question) {
    if (busy) return;
    const d = D();
    if (!d || !d.ready()) { bubble("bot", "<p>The model is still loading this week's players. Try again in a moment.</p>"); return; }
    busy = true;
    send.disabled = true;
    input.value = "";
    log.querySelectorAll(".chat-examples").forEach(el => el.remove());
    bubble("user", `<p>${T.esc(question)}</p>`);
    const wait = bubble("bot typing", '<span class="chat-typing" aria-label="Thinking"><i></i><i></i><i></i></span>');
    const t = getTools();
    t.newQuestion();
    try {
      let res = await invoke({ question, history: history.slice(-HISTORY), context: lastContext, week: d.upcomingGames()[0] ? d.upcomingGames()[0].week : null });
      let guard = 0;
      while (res && res.type === "tool_calls" && guard++ < 10) {
        const results = res.calls.map(c => ({ id: c.id, result: t.run(c.name, c.args) }));
        res = await invoke({ turn_id: res.turn_id, tool_results: results });
      }
      wait.remove();
      const cards = t.takeCards();
      if (res && res.type === "answer") {
        bubble("bot", `<p>${format(res.text, cards)}</p>${cards.map(card).join("")}`);
        history.push({ q: question, a: res.text });
        history = history.slice(-HISTORY);
        const last = cards[cards.length - 1];
        if (last) lastContext = last.kind === "parlay"
          ? `parlay of ${last.legs.map(l => `${l.player} ${l.bet} ${l.odds}`).join(", ")}`
          : `${last.player} ${last.bet} at ${last.odds}`;
        setLeft(res.remaining, res.limit);
      } else if (res && (res.type === "busy" || res.type === "limit")) {
        bubble("bot notice", busyMessage(res.message));
        if (res.type === "limit") setLeft(0, res.limit);
      } else {
        bubble("bot notice", busyMessage((res && res.message) || "Sorry, the chatbot ran into a problem. Please try again, or price the prop yourself with Price a prop."));
      }
    } catch (err) {
      wait.remove();
      bubble("bot notice", busyMessage("Sorry, the chatbot ran into a problem. Please try again, or price the prop yourself with Price a prop."));
    } finally {
      busy = false;
      send.disabled = false;
      if (open) input.focus();
    }
  }

  // ---- Panel ---------------------------------------------------------------------
  function setOpen(next) {
    open = next;
    panel.hidden = !open;
    toggle.hidden = open || !(window.GridIronAuth && window.GridIronAuth.user);
    toggle.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("chat-open", open);
    if (open) { showEmpty(); input.focus(); status(); }
    else if (!toggle.hidden) toggle.focus();
  }

  toggle.addEventListener("click", () => setOpen(true));
  if (navBtn) navBtn.addEventListener("click", e => { e.preventDefault(); setOpen(true); });
  q("#chat-close").addEventListener("click", () => setOpen(false));
  panel.addEventListener("keydown", e => { if (e.key === "Escape") setOpen(false); });
  form.addEventListener("submit", e => {
    e.preventDefault();
    const text = input.value.trim();
    if (text) ask(text.slice(0, MAX_LEN));
  });
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  log.addEventListener("click", e => {
    if (e.target.classList.contains("chat-example")) ask(e.target.textContent);
    if (e.target.matches("[data-chat-link]") && window.matchMedia("(max-width: 640px)").matches) setOpen(false);
  });

  // Signed-in users only. Signing out closes the panel and forgets the conversation.
  document.addEventListener("gridiron:auth", async e => {
    const user = e.detail && e.detail.user;
    if (navBtn) navBtn.hidden = !user;
    if (!user) { history = []; lastContext = ""; log.innerHTML = ""; setOpen(false); toggle.hidden = true; return; }
    toggle.hidden = open;
    try {
      const { data } = await client().from("chat_config").select("news_flag_edge").eq("id", 1).maybeSingle();
      if (data && data.news_flag_edge != null) newsEdge = Number(data.news_flag_edge);
    } catch { /* keep the default */ }
  });
})();
