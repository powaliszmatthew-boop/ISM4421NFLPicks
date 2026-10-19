// Saving bets to "My bets" from any page, plus small helpers the pages share.
(function () {
  "use strict";

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

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
    box._timer = setTimeout(() => { box.className = "toast"; }, 3500);
  }

  // Inserts one row into the bets table. Returns the saved row, or throws.
  async function addBet(bet) {
    const sb = window.GridIronAuth && window.GridIronAuth.client;
    if (!sb || !window.GridIronAuth.user) throw new Error("Sign in to track bets");
    const { data, error } = await sb.from("bets").insert(bet).select().single();
    if (error) throw error;
    return data;
  }

  // Wires a "Track bet" button: disables it while saving and confirms with a toast.
  async function trackButton(btn, bet) {
    btn.disabled = true;
    try {
      await addBet(bet);
      btn.textContent = "Tracked ✓";
      toast(`Added to My bets: ${bet.description}`, "ok");
    } catch (err) {
      btn.disabled = false;
      toast(`Couldn't save the bet: ${err.message}`, "error");
    }
  }

  window.GridIronTrack = { esc, toast, addBet, trackButton };
})();
