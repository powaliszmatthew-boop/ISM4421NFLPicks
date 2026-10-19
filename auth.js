// Email + password accounts (Supabase Auth) and per-user saved settings.
(function () {
  "use strict";

  const q = sel => document.querySelector(sel);
  const authBox = q("#auth"), main = q("main"), account = q("#account");
  const form = q("#auth-form"), msg = q("#auth-msg");
  const emailIn = q("#auth-email"), passIn = q("#auth-password");
  const SAVE_DELAY = 600;

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

  // Defaults come from the markup, so a new account starts from the same settings.
  const controls = () => ({
    edge: q("#edge"), bankroll: q("#bankroll"),
    markets: [...document.querySelectorAll(".markets input")],
  });
  const defaults = (() => {
    const c = controls();
    return { min_edge: Number(c.edge.value), bankroll: Number(c.bankroll.value),
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
    authBox.hidden = true;
    account.hidden = false;
    q("#user-email").textContent = u.email;
    if (firstLoad) await loadSettings();
    main.hidden = false;
    window.GridIron.start();
  }

  function applySettings(s) {
    const c = controls();
    c.edge.value = s.min_edge;
    c.bankroll.value = s.bankroll;
    c.markets.forEach(i => { i.checked = s.markets.includes(i.value); });
  }

  async function loadSettings() {
    applySettings(defaults);
    const { data, error } = await sb.from("user_settings")
      .select("min_edge, markets, bankroll").eq("user_id", user.id).maybeSingle();
    if (error) { q("#save-state").textContent = "Couldn't load your saved settings."; return; }
    if (data) applySettings({ ...data, bankroll: Number(data.bankroll) });
    q("#save-state").textContent = data ? "Loaded your saved settings." : "";
  }

  function queueSave() {
    if (!user) return;
    clearTimeout(saveTimer);
    q("#save-state").textContent = "Saving…";
    saveTimer = setTimeout(async () => {
      const c = controls();
      const { error } = await sb.from("user_settings").upsert({
        user_id: user.id,
        min_edge: Number(c.edge.value),
        markets: c.markets.filter(i => i.checked).map(i => i.value),
        bankroll: Math.min(1e9, Math.max(0, Number(c.bankroll.value) || 0)),
        updated_at: new Date().toISOString(),
      });
      q("#save-state").textContent = error ? `Couldn't save settings: ${error.message}` : "Settings saved to your account.";
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

  if (!window.supabase || !window.GRIDIRON_CONFIG) {
    showAuth("signin");
    say("Couldn't load the sign-in service. Check your connection and reload.", "error");
    q("#auth-submit").disabled = true;
    return;
  }

  const { supabaseUrl, supabaseKey } = window.GRIDIRON_CONFIG;
  const sb = window.supabase.createClient(supabaseUrl, supabaseKey);

  form.addEventListener("submit", submit);
  q("#auth-links").addEventListener("click", e => {
    if (e.target.dataset.mode) setMode(e.target.dataset.mode);
  });
  q("#signout").addEventListener("click", () => sb.auth.signOut());
  q("#edge").addEventListener("change", queueSave);
  q("#bankroll").addEventListener("input", queueSave);
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
      showAuth("signin");
      if (linkError) {
        say(`${linkError}. Request a new link below.`, "error");
        history.replaceState(null, "", location.origin + location.pathname);
        linkError = null;
      }
    }, 0);
  });
})();
