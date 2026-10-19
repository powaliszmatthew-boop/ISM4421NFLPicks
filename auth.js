// Email + password accounts (Supabase Auth), shared by every page.
// Each page's <main> stays hidden until sign-in, then auth.js calls window.GridIron.start().
// Pages with #edge / #bankroll / .markets controls also get those settings saved per user.
(function () {
  "use strict";

  const q = sel => document.querySelector(sel);
  const main = q("main");
  const SAVE_DELAY = 600;

  // Account widget in the header and the sign-in form above <main>.
  q(".topbar").insertAdjacentHTML("beforeend", `
    <div id="account" class="account" hidden>
      <span id="user-email"></span>
      <button id="signout" type="button">Sign out</button>
    </div>`);
  main.insertAdjacentHTML("beforebegin", `
    <section id="auth" class="auth wrap" aria-labelledby="auth-title" hidden>
      <form id="auth-form" class="card auth-card">
        <h2 id="auth-title">Sign in</h2>
        <label id="auth-email-row">
          <span>Email</span>
          <input id="auth-email" type="email" autocomplete="email" required>
        </label>
        <label id="auth-password-row">
          <span>Password</span>
          <input id="auth-password" type="password" minlength="6" autocomplete="current-password" required>
        </label>
        <button id="auth-submit" type="submit" class="primary">Sign in</button>
        <p id="auth-msg" class="auth-msg" role="status"></p>
        <div id="auth-links" class="auth-links"></div>
      </form>
    </section>`);

  const authBox = q("#auth"), account = q("#account");
  const form = q("#auth-form"), msg = q("#auth-msg");
  const emailIn = q("#auth-email"), passIn = q("#auth-password");

  // Recovery links land with "#...type=recovery" in the URL. Read it before the
  // client consumes the hash, so the app doesn't flash before the reset form.
  let recovering = /type=recovery/.test(location.hash);
  // Expired or reused email links come back as "#error_description=...".
  let linkError = new URLSearchParams(location.hash.slice(1)).get("error_description");
  let mode = recovering ? "reset" : "signin";
  let user = null, saveTimer = null;

  const VIEWS = {
    signin: { title: "Sign in", button: "Sign in", password: true, links: ["signup", "forgot"] },
    signup: { title: "Create an account", button: "Create account", password: true, links: ["signin"] },
    forgot: { title: "Reset your password", button: "Email me a reset link", password: false, links: ["signin"] },
    reset: { title: "Choose a new password", button: "Save new password", password: true, email: false, links: [] },
  };
  const LINK_TEXT = { signin: "Have an account? Sign in", signup: "New here? Create an account", forgot: "Forgot password?" };

  // Settings controls on this page, if any. Defaults come from the markup.
  const controls = () => ({
    edge: q("#edge"), bankroll: q("#bankroll"),
    markets: [...document.querySelectorAll(".markets input")],
  });
  const hasSettings = !!(q("#edge") || q("#bankroll"));
  const defaults = (() => {
    const c = controls();
    return { min_edge: c.edge ? Number(c.edge.value) : 3, bankroll: c.bankroll ? Number(c.bankroll.value) : 500,
      markets: c.markets.filter(i => i.checked).map(i => i.value) };
  })();

  function say(text, kind = "") {
    msg.textContent = text;
    msg.className = `auth-msg ${kind}`;
  }

  function setMode(next) {
    mode = next;
    const v = VIEWS[mode];
    q("#auth-title").textContent = v.title;
    q("#auth-submit").textContent = v.button;
    q("#auth-email-row").hidden = v.email === false;
    emailIn.required = v.email !== false;
    q("#auth-password-row").hidden = !v.password;
    passIn.required = v.password;
    passIn.autocomplete = mode === "signin" ? "current-password" : "new-password";
    q("#auth-links").innerHTML = v.links
      .map(l => `<button type="button" class="link" data-mode="${l}">${LINK_TEXT[l]}</button>`).join("");
    say("");
  }

  function showAuth(next) {
    main.hidden = true;
    account.hidden = true;
    authBox.hidden = false;
    setMode(next);
  }

  async function showApp(u) {
    const firstLoad = !user || user.id !== u.id;
    user = u;
    window.GridIronAuth.user = u;
    authBox.hidden = true;
    account.hidden = false;
    q("#user-email").textContent = u.email;
    if (firstLoad && hasSettings) await loadSettings();
    main.hidden = false;
    if (window.GridIron) window.GridIron.start(u);
  }

  function applySettings(s) {
    const c = controls();
    if (c.edge) {
      c.edge.value = s.min_edge;
      const out = q("#edge-out");
      if (out) out.textContent = `${s.min_edge}%`;
    }
    if (c.bankroll) c.bankroll.value = s.bankroll;
    c.markets.forEach(i => { i.checked = s.markets.includes(i.value); });
  }

  const saveState = text => { const el = q("#save-state"); if (el) el.textContent = text; };

  async function loadSettings() {
    applySettings(defaults);
    const { data, error } = await sb.from("user_settings")
      .select("min_edge, markets, bankroll").eq("user_id", user.id).maybeSingle();
    if (error) { saveState("Couldn't load your saved settings."); return; }
    if (data) applySettings({ ...data, bankroll: Number(data.bankroll) });
    saveState(data ? "Loaded your saved settings." : "");
  }

  function queueSave() {
    if (!user) return;
    clearTimeout(saveTimer);
    saveState("Saving…");
    saveTimer = setTimeout(async () => {
      const c = controls();
      // Only send what this page has controls for, so pages don't overwrite each other.
      const row = { user_id: user.id, updated_at: new Date().toISOString() };
      if (c.edge) row.min_edge = Number(c.edge.value);
      if (c.bankroll) row.bankroll = Math.min(1e9, Math.max(0, Number(c.bankroll.value) || 0));
      if (c.markets.length) row.markets = c.markets.filter(i => i.checked).map(i => i.value);
      const { error } = await sb.from("user_settings").upsert(row);
      saveState(error ? `Couldn't save settings: ${error.message}` : "Settings saved to your account.");
    }, SAVE_DELAY);
  }

  async function submit(e) {
    e.preventDefault();
    const email = emailIn.value.trim(), password = passIn.value;
    const back = location.origin + location.pathname;
    const btn = q("#auth-submit");
    btn.disabled = true;
    say("Working…");
    try {
      if (mode === "signin") {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else if (mode === "signup") {
        const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: back } });
        if (error) throw error;
        // No session means the project requires email confirmation first.
        if (!data.session) say(`Check ${email} for a confirmation link, then come back and sign in.`, "ok");
      } else if (mode === "forgot") {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: back });
        if (error) throw error;
        say(`If ${email} has an account, a reset link is on its way.`, "ok");
      } else if (mode === "reset") {
        const { data, error } = await sb.auth.updateUser({ password });
        if (error) throw error;
        recovering = false;
        history.replaceState(null, "", back);
        passIn.value = "";
        await showApp(data.user);
      }
    } catch (err) {
      say(err.message || String(err), "error");
    } finally {
      btn.disabled = false;
    }
  }

  window.GridIronAuth = { client: null, user: null };

  if (!window.supabase || !window.GRIDIRON_CONFIG) {
    showAuth("signin");
    say("Couldn't load the sign-in service. Check your connection and reload.", "error");
    q("#auth-submit").disabled = true;
    return;
  }

  const { supabaseUrl, supabaseKey } = window.GRIDIRON_CONFIG;
  const sb = window.supabase.createClient(supabaseUrl, supabaseKey);
  window.GridIronAuth.client = sb;

  form.addEventListener("submit", submit);
  q("#auth-links").addEventListener("click", e => {
    if (e.target.dataset.mode) setMode(e.target.dataset.mode);
  });
  q("#signout").addEventListener("click", () => sb.auth.signOut());
  if (q("#edge")) q("#edge").addEventListener("change", queueSave);
  if (q("#bankroll")) q("#bankroll").addEventListener("input", queueSave);
  document.querySelectorAll(".markets input").forEach(i => i.addEventListener("change", queueSave));

  // Supabase warns against awaiting its own calls inside this callback, so defer the work.
  sb.auth.onAuthStateChange((event, session) => {
    setTimeout(() => {
      if (event === "PASSWORD_RECOVERY") recovering = true;
      if (recovering && session) {
        // Don't redraw an open reset form; that would wipe what the user typed.
        if (authBox.hidden || mode !== "reset") showAuth("reset");
        return;
      }
      if (session) { showApp(session.user); return; }
      user = null;
      window.GridIronAuth.user = null;
      showAuth("signin");
      if (linkError) {
        say(`${linkError}. Request a new link below.`, "error");
        history.replaceState(null, "", location.origin + location.pathname);
        linkError = null;
      }
    }, 0);
  });
})();
