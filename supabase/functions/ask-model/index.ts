// Edge Function "ask-model": the "Ask the model" chatbot on the Player props page.
// Signed-in users only. Holds the AI provider keys (read from Vault), counts each user's
// questions per day, falls back between providers, and logs tokens per call. The model's
// tools run in the browser; this function hands tool calls to the page and passes the
// numbers it sends back to the provider.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { type Msg, type ProviderCfg, type TurnState, redact, step, systemPrompt } from "./core.ts";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
  (() => { try { return JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default; } catch { return ""; } })();
const db = createClient(URL_, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const ALLOWED_ORIGIN = /^(https:\/\/([a-z0-9-]+--)?gridironedgenfl\.netlify\.app|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;
const MAX_QUESTION = 500, MAX_ANSWER_HISTORY = 900, MAX_RESULT = 6000, MAX_TOTAL_ROUNDS = 10;
const BUSY = "Chat is busy right now. The free AI services it uses are at their limit, so please try again later. " +
  "You can still price any prop yourself with Price a prop.";
const FAILED = "Sorry, the chatbot ran into a problem. Please try again, or price the prop yourself with Price a prop.";

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN.test(origin) ? origin : "https://gridironedgenfl.netlify.app",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

// Config and keys are cached for a minute per worker.
let cfgCache: { at: number; v: any } | null = null;
async function config() {
  if (cfgCache && Date.now() - cfgCache.at < 60000) return cfgCache.v;
  const { data, error } = await db.from("chat_config").select("*").eq("id", 1).single();
  if (error) throw error;
  cfgCache = { at: Date.now(), v: data };
  return data;
}
const keyCache = new Map<string, { at: number; v: string | null }>();
async function providerKey(name: string): Promise<string | null> {
  const hit = keyCache.get(name);
  if (hit && Date.now() - hit.at < 60000) return hit.v;
  const { data, error } = await db.rpc("chat_provider_key", { p_name: name });
  const v = !error && typeof data === "string" && data.length > 16 ? data : null;
  keyCache.set(name, { at: Date.now(), v });
  return v;
}

const todayET = () => new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", year: "numeric" });

async function remaining(userId: string, limit: number) {
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const { count } = await db.from("chat_turns").select("id", { count: "exact", head: true })
    .eq("user_id", userId).eq("day", day).in("status", ["pending", "done"]);
  return Math.max(0, limit - (count || 0));
}

Deno.serve(async (req) => {
  const headers = { ...cors(req), "Content-Type": "application/json" };
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return reply({ type: "error", message: "POST only" }, 405);

  // Signed-in users only: the gateway checks the JWT, and this confirms it's a real user.
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await db.auth.getUser(token);
  const user = auth && auth.user;
  if (!user || user.is_anonymous) return reply({ type: "error", message: "Sign in to use the chat." }, 401);

  let body: any;
  try { body = await req.json(); } catch { return reply({ type: "error", message: "Bad request" }, 400); }
  let cfg: any;
  try { cfg = await config(); } catch { return reply({ type: "error", message: FAILED }); }
  const limit = Number(cfg.daily_limit);

  if (body.action === "status") return reply({ type: "status", remaining: await remaining(user.id, limit), limit });

  const providers: ProviderCfg[] = (cfg.providers || []).filter((p: any) => p && p.provider && p.model && p.key);
  const deps = (turnId: string, rounds: number, week: number | null) => ({
    providers, fetch, rounds, maxRounds: Number(cfg.max_rounds), maxTokens: Number(cfg.max_output_tokens),
    system: systemPrompt(todayET(), week),
    key: providerKey,
    isCooling: async (provider: string) => {
      const { data } = await db.from("chat_provider_state").select("cooldown_until").eq("provider", provider).maybeSingle();
      return !!(data && data.cooldown_until && new Date(data.cooldown_until).getTime() > Date.now());
    },
    cool: async (provider: string, sec: number, reason: string) => {
      await db.from("chat_provider_state").upsert({ provider, cooldown_until: new Date(Date.now() + sec * 1000).toISOString(), reason, updated_at: new Date().toISOString() });
    },
    log: async (row: any) => {
      await db.from("chat_log").insert({
        turn_id: turnId, user_id: user.id, provider: row.provider, model: row.model, round: row.round, status: row.status,
        http_status: row.http_status ?? null, latency_ms: row.latency_ms, error: row.error ? String(row.error).slice(0, 300) : null,
        input_tokens: row.usage ? row.usage.input : null, output_tokens: row.usage ? row.usage.output : null,
        thought_tokens: row.usage ? row.usage.thought : null, cached_tokens: row.usage ? row.usage.cached : null,
      });
    },
  });

  // Runs one provider call and saves where the question stands.
  async function advance(turnId: string, state: TurnState, rounds: number, week: number | null) {
    const out = await step(state, deps(turnId, rounds, week));
    const now = new Date().toISOString();
    if (out.type === "tool_calls") {
      await db.from("chat_turns").update({ rounds: out.rounds, provider: out.provider, model: out.model,
        pending_calls: out.calls.map(c => ({ id: c.id, name: c.name })), transcript: { ...state, week } }).eq("id", turnId);
      return reply({ type: "tool_calls", turn_id: turnId, calls: out.calls.map(c => ({ id: c.id, name: c.name, args: c.args })) });
    }
    if (out.type === "answer") {
      await db.from("chat_turns").update({ status: "done", rounds: out.rounds, provider: out.provider, model: out.model,
        pending_calls: null, transcript: null, finished_at: now }).eq("id", turnId);
      return reply({ type: "answer", turn_id: turnId, text: out.text, provider: out.provider, model: out.model,
        remaining: await remaining(user!.id, limit), limit });
    }
    // Busy and failed questions don't count against the daily limit.
    await db.from("chat_turns").update({ status: out.type === "busy" ? "busy" : "error", rounds: out.rounds,
      pending_calls: null, transcript: null, finished_at: now }).eq("id", turnId);
    return reply(out.type === "busy" ? { type: "busy", message: BUSY } : { type: "error", message: FAILED });
  }

  try {
    // ---- A follow-up with tool results for a question in progress ----
    if (body.turn_id) {
      const { data: turn } = await db.from("chat_turns").select("*").eq("id", String(body.turn_id)).eq("user_id", user.id).maybeSingle();
      if (!turn || turn.status !== "pending" || !turn.transcript || !Array.isArray(turn.pending_calls)) {
        return reply({ type: "error", message: "That question has expired. Please ask again." });
      }
      if (turn.rounds >= MAX_TOTAL_ROUNDS) return reply({ type: "error", message: FAILED });
      const sent = Array.isArray(body.tool_results) ? body.tool_results : [];
      const results = turn.pending_calls.map((c: any) => {
        const r = sent.find((x: any) => x && x.id === c.id);
        let result: unknown = r ? r.result : { status: "error", note: "No result" };
        const text = JSON.stringify(result ?? null);
        if (text.length > MAX_RESULT) result = { status: "error", note: "Result too large" };
        return { id: c.id, name: c.name, result };
      });
      const state: TurnState = turn.transcript;
      const week = turn.transcript.week ?? null;
      state.msgs.push({ role: "tool", results });
      return await advance(turn.id, state, turn.rounds, week);
    }

    // ---- A new question ----
    const question = redact(String(body.question || "").trim());
    if (!question) return reply({ type: "error", message: "Type a question first." });
    if (question.length > MAX_QUESTION) return reply({ type: "error", message: `Please keep questions under ${MAX_QUESTION} characters.` });
    const { data: started, error: startErr } = await db.rpc("chat_start_turn", { p_user: user.id, p_limit: limit });
    if (startErr) throw startErr;
    const row = Array.isArray(started) ? started[0] : started;
    if (!row || !row.turn_id) {
      return reply({ type: "limit", message: `You've used all ${limit} questions for today. The limit resets at midnight Eastern.`, remaining: 0, limit });
    }
    const history: Msg[] = [];
    const past = Array.isArray(body.history) ? body.history.slice(-Number(cfg.history_turns)) : [];
    for (const h of past) {
      if (!h || typeof h.q !== "string" || typeof h.a !== "string") continue;
      history.push({ role: "user", text: redact(h.q).slice(0, MAX_QUESTION) });
      history.push({ role: "assistant", text: redact(h.a).slice(0, MAX_ANSWER_HISTORY) });
    }
    const context = typeof body.context === "string" && body.context ? `\n(Context from the last answer: ${redact(body.context).slice(0, 240)})` : "";
    const week = Number.isInteger(body.week) && body.week >= 1 && body.week <= 23 ? body.week : null;
    const msgs: Msg[] = [...history, { role: "user", text: question + context }];
    const state: TurnState = { msgs, base: msgs.length, tried: [] };
    return await advance(row.turn_id, state, 0, week);
  } catch (err) {
    console.error("ask-model failed", err instanceof Error ? err.message : String(err));
    return reply({ type: "error", message: FAILED });
  }
});
