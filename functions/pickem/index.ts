// Pick'em API: Rob & Marcus bet collector (JSON API + CORS + self-grading).
// UI lives on GitHub Pages and talks to this. Data: public.pickem_* (RLS on; service_role only).
//
// A "card" (pickem_matches row) is one betting night. It holds one or more games
// (pickem_games, each tied to an ESPN event) and its bets (pickem_bets). Every bet
// carries its own grading rule (pickem_bets.rule), so new nights need no code.
//
//   GET ?action=cards                  -> { seasons, cards }           (navigation lists)
//   GET ?action=fixtures               -> { fixtures }                 (next Champions League games, ESPN)
//   GET ?match=<slug>                  -> { match, games, bets }
//   GET ?view=results&match=<slug>     -> { match, games, bets, entries }   (grades first, throttled)
//   GET ?view=season&season=<slug>     -> { season, cards:[{ match, games, bets, entries }] }
//   POST { match, player, picks }      -> { ok }
//
// Grading is automatic: viewing a results board refreshes it from ESPN's free feed,
// at most once every 45 seconds per card. It only ever writes what ESPN reports,
// so there's no admin key. Manual override: set pickem_bets.correct by SQL.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decide, espnFetch, type Feed, readFeed } from "./grading.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const PLAYERS = ["RobitityRob", "MeisterMarkus"];
const GRADE_EVERY_MS = 45_000;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });

const pubMatch = (m: any) => ({
  slug: m.slug, title: m.title, competition: m.competition, season: m.season,
  venue: m.venue, kickoff: m.kickoff, status: m.status, home: m.home, away: m.away,
  mode: m.mode ?? "both", chooser: m.chooser ?? null,
});
const other = (player: string) => PLAYERS.find((p) => p !== player)!;
const flip = (c: string) => (c === "A" ? "B" : "A");
const pubGame = (g: any) => ({
  key: g.key, home: g.home, away: g.away, home_short: g.home_short, away_short: g.away_short,
  home_color: g.home_color, away_color: g.away_color, venue: g.venue, kickoff: g.kickoff,
  home_score: g.home_score, away_score: g.away_score, state: g.state, clock: g.clock,
});
const BET_COLS = "n, game_key, title, blurb, opt_a, opt_b, correct";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    if (req.method === "POST") return await handleSubmit(req);
    const url = new URL(req.url);
    const action = url.searchParams.get("action");
    const view = url.searchParams.get("view");
    if (action === "cards") return await listCards();
    if (action === "fixtures") return await fixtures();
    if (view === "season") return await seasonView(url.searchParams.get("season"));

    const slug = url.searchParams.get("match");
    if (!slug) return json({ error: "match required" }, 400);
    const { data: match } = await supabase.from("pickem_matches").select("*").eq("slug", slug).single();
    if (!match) return json({ error: "Match not found" }, 404);
    if (view === "results") await maybeGrade(match);
    return json(await loadCard(match, view === "results"));
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

async function loadCard(match: any, withEntries: boolean) {
  const [{ data: m2 }, { data: games }, { data: bets }] = await Promise.all([
    supabase.from("pickem_matches").select("*").eq("id", match.id).single(),
    supabase.from("pickem_games").select("*").eq("match_id", match.id).order("key"),
    supabase.from("pickem_bets").select(BET_COLS).eq("match_id", match.id).order("n"),
  ]);
  const out: any = { match: pubMatch(m2 ?? match), games: (games ?? []).map(pubGame), bets: bets ?? [] };
  if (withEntries) {
    const { data: entries } = await supabase.from("pickem_entries")
      .select("player, picks, submitted_at").eq("match_id", match.id).order("submitted_at");
    out.entries = latestPerPlayer(entries ?? []);
    // One chooser means there is nothing to copy: both sides are known the moment
    // the card is answered, so the board is open straight away.
    if ((m2 ?? match).mode !== "chooser" && Date.now() < lockTime(m2 ?? match, games ?? [])) {
      out.entries = out.entries.map((e: any) => ({ player: e.player, submitted_at: e.submitted_at, picks: null, hidden: true }));
    }
  }
  return out;
}

function lockTime(match: any, games: any[]) {
  const t = [match.kickoff, ...games.map((g: any) => g.kickoff)].filter(Boolean).map((k) => new Date(k).getTime());
  return t.length ? Math.min(...t) : 0;
}

// One entry per player: the most recent submission counts.
function latestPerPlayer(entries: any[]) {
  const by: Record<string, any> = {};
  for (const e of entries) by[e.player] = e;
  const order = (p: string) => { const i = PLAYERS.indexOf(p); return i < 0 ? 99 : i; };
  return Object.values(by).sort((a: any, b: any) => order(a.player) - order(b.player));
}

async function listCards() {
  const [{ data: seasons }, { data: matches }, { data: games }, { data: bets }, { data: entries }] = await Promise.all([
    supabase.from("pickem_seasons").select("slug, name, opening_balance, stake, opening_note, starts_on").order("slug"),
    supabase.from("pickem_matches").select("*").order("kickoff"),
    supabase.from("pickem_games").select("*").order("key"),
    supabase.from("pickem_bets").select("match_id, n, correct"),
    supabase.from("pickem_entries").select("match_id, player, submitted_at").order("submitted_at"),
  ]);
  const cards = (matches ?? []).map((m: any) => {
    const mb = (bets ?? []).filter((b: any) => b.match_id === m.id);
    const players = [...new Set((entries ?? []).filter((e: any) => e.match_id === m.id).map((e: any) => e.player))];
    return {
      ...pubMatch(m),
      games: (games ?? []).filter((g: any) => g.match_id === m.id).map(pubGame),
      bet_count: mb.length,
      settled_count: mb.filter((b: any) => b.correct).length,
      players,
    };
  });
  return json({ seasons: seasons ?? [], cards });
}

async function seasonView(slug: string | null) {
  const { data: seasons } = await supabase.from("pickem_seasons").select("*").order("slug");
  const season = (seasons ?? []).find((s: any) => s.slug === slug) ?? (seasons ?? []).at(-1);
  if (!season) return json({ error: "No season" }, 404);
  const { data: matches } = await supabase.from("pickem_matches").select("*")
    .eq("season", season.slug).order("kickoff");
  const cards = [];
  for (const m of matches ?? []) cards.push(await loadCard(m, true));
  return json({ seasons: seasons ?? [], season, cards });
}

async function handleSubmit(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body) return json({ ok: false, error: "Bad request" }, 400);
  const slug = String(body.match || "");
  const player = String(body.player || "").trim().slice(0, 40);
  const picks = body.picks;
  if (!PLAYERS.includes(player)) return json({ ok: false, error: "Pick who you are first" }, 400);
  if (!picks || typeof picks !== "object") return json({ ok: false, error: "Picks required" }, 400);
  const { data: match } = await supabase.from("pickem_matches")
    .select("id, status, kickoff, mode").eq("slug", slug).single();
  if (!match) return json({ ok: false, error: "Match not found" }, 404);
  if (match.status !== "open") return json({ ok: false, error: "Picks are closed for this night." }, 403);
  const { data: games } = await supabase.from("pickem_games").select("kickoff").eq("match_id", match.id);
  const lock = lockTime(match, games ?? []);
  if (lock && lock <= Date.now()) {
    return json({ ok: false, error: "Picks closed at kick-off. Too late!" }, 403);
  }
  const { data: bets } = await supabase.from("pickem_bets").select("n").eq("match_id", match.id);
  const clean: Record<string, string> = {};
  for (const b of bets ?? []) {
    const v = picks[String(b.n)];
    if (v !== "A" && v !== "B") return json({ ok: false, error: "Every bet needs a pick" }, 400);
    clean[String(b.n)] = v;
  }
  // In chooser mode the submitter answers for the night and the other player is
  // put on the opposite side of every bet, so each one moves money.
  const rows = [{ match_id: match.id, player, picks: clean }];
  if (match.mode === "chooser") {
    const mirrored: Record<string, string> = {};
    for (const [n, c] of Object.entries(clean)) mirrored[n] = flip(c);
    rows.push({ match_id: match.id, player: other(player), picks: mirrored });
  }
  const { error } = await supabase.from("pickem_entries").insert(rows);
  if (error) return json({ ok: false, error: error.message }, 500);
  if (match.mode === "chooser") {
    await supabase.from("pickem_matches").update({ chooser: player }).eq("id", match.id);
  }
  return json({ ok: true, chooser: match.mode === "chooser" ? player : null, opponent: other(player) });
}

// ---------- FIXTURES (next Champions League games, for the Upcoming tab) ----------

let fixtureCache: { at: number; data: any[] } | null = null;
async function fixtures() {
  if (fixtureCache && Date.now() - fixtureCache.at < 30 * 60_000) return json({ fixtures: fixtureCache.data });
  // ESPN refuses date ranges, so ask day by day (in parallel) for the next 30 days.
  const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const days = Array.from({ length: 30 }, (_, i) => ymd(new Date(Date.now() + i * 86400_000)));
  let out: any[] = [];
  try {
    const pages = await Promise.all(days.map((day) =>
      espnFetch(`/scoreboard?dates=${day}`).then((r) => r.json()).catch(() => null)
    ));
    const events = pages.flatMap((d: any) => d?.events ?? []);
    out = events.map((e: any) => {
      const c = e?.competitions?.[0] ?? {};
      const team = (side: string) => c?.competitors?.find((x: any) => x.homeAway === side)?.team ?? {};
      const h = team("home"), a = team("away");
      return {
        id: e.id, date: e.date, state: c?.status?.type?.state,
        home: h.shortDisplayName || h.displayName, away: a.shortDisplayName || a.displayName,
        home_short: h.abbreviation, away_short: a.abbreviation,
        home_color: h.color ? "#" + h.color : null, away_color: a.color ? "#" + a.color : null,
        venue: c?.venue?.fullName ?? null,
      };
    }).filter((f: any) => f.state === "pre");
  } catch (_) { out = []; }
  if (out.length) fixtureCache = { at: Date.now(), data: out };
  return json({ fixtures: out });
}

// ---------- AUTO-GRADING (rules live in grading.ts) ----------

async function maybeGrade(match: any) {
  if (match.status === "settled") return;
  const now = Date.now();
  if (match.graded_at && now - new Date(match.graded_at).getTime() < GRADE_EVERY_MS) return;
  const { data: games } = await supabase.from("pickem_games").select("*").eq("match_id", match.id);
  const firstKick = Math.min(...(games ?? []).map((g: any) => new Date(g.kickoff ?? match.kickoff).getTime()));
  // Nothing to grade before kick-off; also close picks once kick-off passes.
  if (Number.isFinite(firstKick) && now < firstKick - 5 * 60_000) return;
  await supabase.from("pickem_matches").update({ graded_at: new Date().toISOString() }).eq("id", match.id);

  const feeds: Record<string, Feed> = {};
  for (const g of games ?? []) {
    if (!g.espn_event_id) continue;
    const f = await readFeed(g.espn_event_id);
    if (!f) continue;
    feeds[g.key] = f;
    await supabase.from("pickem_games").update({
      home_score: f.state === "pre" ? null : f.home, away_score: f.state === "pre" ? null : f.away,
      state: f.state, clock: f.clock,
    }).eq("id", g.id);
  }

  const { data: bets } = await supabase.from("pickem_bets")
    .select("id, n, game_key, rule, correct").eq("match_id", match.id);
  let open = 0;
  for (const b of bets ?? []) {
    const v = decide(b.rule, b.game_key ? feeds[b.game_key] : undefined, feeds);
    if (v && v !== b.correct) await supabase.from("pickem_bets").update({ correct: v }).eq("id", b.id);
    if (!v && !b.correct) open++;
  }
  const allOver = (games ?? []).length > 0 && (games ?? []).every((g: any) => feeds[g.key]?.over);
  const status = allOver && open === 0 ? "settled"
    : (now >= firstKick ? "closed" : match.status);
  if (status !== match.status) await supabase.from("pickem_matches").update({ status }).eq("id", match.id);
}
