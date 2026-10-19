// Live NFL betting splits (% of money and % of bets on each side) from
// DraftKings Network's public splits page, parsed into JSON for the app.
// Runs server-side because the page can't be fetched from the browser (CORS).

const PAGE = "https://dknetwork.draftkings.com/draftkings-sportsbook-betting-splits/";
const NFL_GROUP = "88808";
const MAX_PAGES = 4;
const TEAM_FIX = { LAR: "LA", JAC: "JAX", WSH: "WAS", LVR: "LV" };

const team = abbr => TEAM_FIX[abbr] || abbr;
const text = html => html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const odds = s => Number(s.replace("−", "-").replace("+", ""));

function parseRow(row) {
  const side = text((row.match(/tb-slipline[^>]*>([\s\S]*?)<\/div>/) || [])[1] || "");
  const price = text((row.match(/tb-odd-s[^>]*>([\s\S]*?)<\/a>/) || [])[1] || "");
  const pcts = [...row.matchAll(/<div class="flex-1">\s*(\d+)%/g)].map(m => Number(m[1]));
  return { side, odds: price ? odds(price) : null, handle: pcts[0] ?? null, bets: pcts[1] ?? null };
}

export function parsePage(html) {
  const games = [];
  for (const block of html.split(/class="tb-se /).slice(1)) {
    const logos = [...block.matchAll(/logos\/teams\/nfl\/([A-Z]+)\.png/g)].map(m => team(m[1]));
    if (logos.length < 2) continue;
    const [away, home] = logos;
    const names = text((block.match(/<h5[^>]*>([\s\S]*?)<\/h5>/) || [])[1] || "").split(" @ ");
    const time = text((block.match(/<\/h5>\s*<span[^>]*>([\s\S]*?)<\/span>/) || [])[1] || "");
    const game = { away, home, time, ml: null, spread: null, total: null };
    for (const m of block.split(/tb-se-head/).slice(1)) {
      const name = text((m.match(/<div class="flex-1">([\s\S]*?)<\/div>/) || [])[1] || "");
      const rows = m.split(/tb-sodd/).slice(1).map(parseRow);
      const bySide = {};
      for (const r of rows) {
        if (name === "Total") {
          bySide[r.side.split(" ")[0].toLowerCase()] = { ...r, line: Number(r.side.split(" ")[1]) };
        } else {
          const key = r.side.startsWith(names[1]) ? "home" : r.side.startsWith(names[0]) ? "away" : null;
          const line = name === "Spread" ? Number(r.side.split(" ").pop()) : undefined;
          if (key) bySide[key] = { ...r, line };
        }
      }
      if (name === "Moneyline") game.ml = bySide;
      else if (name === "Spread") game.spread = bySide;
      else if (name === "Total") game.total = bySide;
    }
    games.push(game);
  }
  return games;
}

const json = (status, body, cache) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": cache || "no-store" },
  });

export default async () => {
  try {
    const games = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${PAGE}?tb_eg=${NFL_GROUP}&tb_edate=n7days&tb_emt=0&tb_page=${page}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; ISM4421NFLPicks/1.0)", Accept: "text/html" },
      });
      if (!res.ok) throw new Error(`DraftKings Network returned ${res.status}`);
      const found = parsePage(await res.text());
      games.push(...found);
      if (found.length < 10) break;
    }
    return json(200, { source: "DraftKings Sportsbook (all jurisdictions)", fetchedAt: new Date().toISOString(), games },
      "public, max-age=300");
  } catch (err) {
    return json(502, { error: err.message });
  }
};
