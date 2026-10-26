// Weekly offensive player stats (QB/RB/WR/TE) for this season and last, from
// nflverse, trimmed to the columns the player props model uses.
// Runs server-side because GitHub release files can't be fetched from the browser (CORS).

const URL_FOR = season =>
  `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`;
const POSITIONS = new Set(["QB", "RB", "WR", "TE"]);
const TEAM_RE = /^[A-Z]{2,3}$/;
export const STAT_COLS = [
  "completions", "attempts", "passing_yards", "passing_tds", "passing_interceptions",
  "carries", "rushing_yards", "rushing_tds", "receptions", "targets", "receiving_yards", "receiving_tds",
];

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Compact form: players {id: [name, position]} and rows [id, team, opp, season, week, ...STAT_COLS].
export function compact(csvTexts) {
  const players = {}, rows = [];
  for (const text of csvTexts) {
    const [header, ...data] = parseCSV(text);
    const at = name => header.indexOf(name);
    const ix = { id: at("player_id"), name: at("player_display_name"), pos: at("position"), team: at("team"),
      opp: at("opponent_team"), season: at("season"), week: at("week"), type: at("season_type") };
    const statIx = STAT_COLS.map(at);
    for (const r of data) {
      if (r.length !== header.length || !POSITIONS.has(r[ix.pos]) || r[ix.type] === "PRE") continue;
      // IDs and team codes end up in the page's HTML unescaped, so skip rows that don't look like them.
      if (!/^[\w-]{1,20}$/.test(r[ix.id]) || !TEAM_RE.test(r[ix.team]) || !TEAM_RE.test(r[ix.opp])) continue;
      players[r[ix.id]] = [r[ix.name], r[ix.pos]];
      rows.push([r[ix.id], r[ix.team], r[ix.opp], Number(r[ix.season]), Number(r[ix.week]),
        ...statIx.map(i => Number(r[i]) || 0)]);
    }
  }
  rows.sort((a, b) => a[3] - b[3] || a[4] - b[4]);
  return { cols: STAT_COLS, players, rows };
}

const json = (status, body, cache) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": cache || "no-store" },
  });

export default async () => {
  // The NFL season starts in September, so January to August belongs to last year's season.
  const now = new Date();
  const season = now.getUTCMonth() >= 8 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  try {
    const texts = [];
    for (const s of [season - 1, season]) {
      const res = await fetch(URL_FOR(s));
      if (res.status === 404 && s === season) continue;   // season file not published yet
      if (!res.ok) throw new Error(`nflverse returned ${res.status} for ${s}`);
      texts.push(await res.text());
    }
    return json(200, { source: "nflverse", season, fetchedAt: now.toISOString(), ...compact(texts) },
      "public, max-age=1800");
  } catch (err) {
    return json(502, { error: err.message });
  }
};
