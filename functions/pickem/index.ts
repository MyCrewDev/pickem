// Pick'em API — Rob & Marcus bet collector (JSON API + CORS + auto-grading).
// UI on GitHub Pages talks to this. Data: public.pickem_* (RLS on, service_role bypasses).
// Auto-grading reads ESPN's free soccer summary feed (scorers, assists, minutes,
// cards, penalties, result incl. extra time) and settles whatever's concluded.
//
//   GET                           -> { match, bets }
//   GET ?view=results             -> { match, bets, entries }
//   GET ?action=grade&key=ADMIN   -> runs auto-grade, returns { settled, pending, status }
//   POST { match, player, picks } -> { ok }
//   OPTIONS                       -> CORS preflight

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const DEFAULT_MATCH = "psg-arsenal-2026";
const ADMIN_KEY = "robmeister";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const slug = url.searchParams.get("match") || DEFAULT_MATCH;

  if (req.method === "POST") return handleSubmit(req);

  if (url.searchParams.get("action") === "grade") {
    if (url.searchParams.get("key") !== ADMIN_KEY) {
      return json({ error: "Not authorised" }, 403);
    }
    return gradeMatch(slug);
  }

  const { data: match } = await supabase
    .from("pickem_matches").select("*").eq("slug", slug).single();
  if (!match) return json({ error: "Match not found" }, 404);

  const { data: bets } = await supabase
    .from("pickem_bets").select("n, title, blurb, opt_a, opt_b, correct")
    .eq("match_id", match.id).order("n");

  const pub = {
    slug: match.slug, competition: match.competition, home: match.home,
    away: match.away, venue: match.venue, kickoff: match.kickoff, status: match.status,
  };

  if (url.searchParams.get("view") === "results") {
    const { data: entries } = await supabase
      .from("pickem_entries").select("player, picks, submitted_at")
      .eq("match_id", match.id).order("submitted_at");
    return json({ match: pub, bets: bets ?? [], entries: entries ?? [] });
  }
  return json({ match: pub, bets: bets ?? [] });
});

async function handleSubmit(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const slug = String(body.match || DEFAULT_MATCH);
    const player = String(body.player || "").trim().slice(0, 40);
    const picks = body.picks;
    if (!player) return json({ ok: false, error: "Name required" }, 400);
    if (!picks || typeof picks !== "object") return json({ ok: false, error: "Picks required" }, 400);
    const { data: match } = await supabase
      .from("pickem_matches").select("id, status, kickoff").eq("slug", slug).single();
    if (!match) return json({ ok: false, error: "Match not found" }, 404);
    if (match.status !== "open") return json({ ok: false, error: "Picks are closed for this match." }, 403);
    if (match.kickoff && new Date(match.kickoff).getTime() <= Date.now()) {
      return json({ ok: false, error: "Picks closed at kick-off. Too late!" }, 403);
    }
    const { error } = await supabase.from("pickem_entries")
      .insert({ match_id: match.id, player, picks });
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 400);
  }
}

// ---------- AUTO-GRADING (ESPN feed) ----------

const minuteOf = (ev: any): number => {
  const m = String(ev?.clock?.displayValue ?? "").match(/(\d+)/);
  return m ? parseInt(m[1], 10) : -1;
};
const periodOf = (ev: any): number => Number(ev?.period?.number ?? 0);

async function gradeMatch(slug: string): Promise<Response> {
  const { data: match } = await supabase
    .from("pickem_matches").select("id, espn_event_id").eq("slug", slug).single();
  if (!match) return json({ error: "Match not found" }, 404);
  if (!match.espn_event_id) return json({ error: "No ESPN event id set for this match" }, 400);

  let d: any;
  try {
    const r = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/summary?event=${match.espn_event_id}`,
    );
    d = await r.json();
  } catch (e) {
    return json({ error: "Could not reach the live feed: " + String(e) }, 502);
  }

  const comp = d?.header?.competitions?.[0] ?? {};
  const competitors = comp.competitors ?? [];
  const teamSide: Record<string, string> = {};
  for (const c of competitors) teamSide[String(c?.team?.id)] = c?.homeAway;
  const statusType = comp?.status?.type ?? {};
  const matchOver = !!statusType.completed;
  const events: any[] = d?.keyEvents ?? [];

  const elapsedM = (() => {
    const m = String(comp?.status?.displayClock ?? "").match(/(\d+)/);
    return m ? parseInt(m[1], 10) : (matchOver ? 999 : 0);
  })();

  const goals = events.filter((e) => e?.scoringPlay && periodOf(e) <= 4);
  const goalNames = (g: any) =>
    (g?.participants ?? []).map((p: any) => p?.athlete?.displayName ?? "").join(" ").toLowerCase();

  const regGoals = goals.filter((g) => periodOf(g) <= 2);
  const homeGoals = regGoals.filter((g) => teamSide[String(g?.team?.id)] === "home").length;
  const awayGoals = regGoals.filter((g) => teamSide[String(g?.team?.id)] === "away").length;
  const totalReg = regGoals.length;

  const etReached = events.some((e) => periodOf(e) >= 3) ||
    /extra|penalt/i.test(statusType?.detail ?? "") || /extra|penalt/i.test(statusType?.name ?? "");
  const ninetyDone = matchOver || etReached;
  const htReached = matchOver || etReached || events.some((e) => periodOf(e) >= 2) || elapsedM > 45;
  const past15 = matchOver || elapsedM > 15 || events.some((e) => periodOf(e) >= 1 && minuteOf(e) > 15);

  const involves = (name: string) => goals.some((g) => goalNames(g).includes(name));
  const firstHalfGoal = goals.some((g) => periodOf(g) === 1);
  const early = goals.some((g) => periodOf(g) === 1 && minuteOf(g) >= 0 && minuteOf(g) <= 15);
  const redCard = events.some((e) => /red card/i.test(e?.type?.text ?? ""));
  const penalty = events.some((e) => {
    if (periodOf(e) >= 5) return false;
    if (/penalt/i.test(e?.type?.text ?? "")) return true;
    return !!e?.scoringPlay && (e?.penaltyKick === true || /penalt/i.test(e?.text ?? ""));
  });

  const v: Record<number, string | undefined> = {};
  // 1 winner (A=PSG/home, B=Arsenal/away)
  if (matchOver) {
    const w = competitors.find((c: any) => c?.winner === true);
    if (w) v[1] = w.homeAway === "home" ? "A" : "B";
    else {
      const h = Number(competitors.find((c: any) => c?.homeAway === "home")?.score);
      const a = Number(competitors.find((c: any) => c?.homeAway === "away")?.score);
      if (h > a) v[1] = "A"; else if (a > h) v[1] = "B";
    }
  }
  // 2 total goals O/U 2.5 (90 min)
  if (totalReg >= 3) v[2] = "A"; else if (ninetyDone) v[2] = "B";
  // 3 both teams to score (90 min)
  if (homeGoals >= 1 && awayGoals >= 1) v[3] = "A"; else if (ninetyDone) v[3] = "B";
  // 4 Kvaratskhelia goal or assist
  if (involves("kvaratskhelia")) v[4] = "A"; else if (matchOver) v[4] = "B";
  // 5 Saka goal or assist
  if (involves("saka")) v[5] = "A"; else if (matchOver) v[5] = "B";
  // 6 first goal before half-time
  if (firstHalfGoal) v[6] = "A"; else if (htReached) v[6] = "B";
  // 7 extra time
  if (etReached) v[7] = "A"; else if (matchOver) v[7] = "B";
  // 8 goal in first 15'
  if (early) v[8] = "A"; else if (past15) v[8] = "B";
  // 9 red card
  if (redCard) v[9] = "A"; else if (matchOver) v[9] = "B";
  // 10 penalty in play
  if (penalty) v[10] = "A"; else if (matchOver) v[10] = "B";

  const { data: bets } = await supabase
    .from("pickem_bets").select("id, n, opt_a, opt_b").eq("match_id", match.id).order("n");

  const settled: any[] = [];
  const pending: number[] = [];
  for (const b of bets ?? []) {
    const val = v[b.n];
    if (val) {
      await supabase.from("pickem_bets").update({ correct: val }).eq("id", b.id);
      settled.push({ n: b.n, outcome: val === "A" ? b.opt_a : b.opt_b });
    } else {
      pending.push(b.n);
    }
  }

  const statusLabel = statusType?.description || statusType?.detail || statusType?.name || "unknown";
  return json({ ok: true, status: statusLabel, matchOver, settled, pending });
}
