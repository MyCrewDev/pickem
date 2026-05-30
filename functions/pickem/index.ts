// Pick'em API — Rob & Marcus bet collector (JSON API + CORS).
// Supabase forces text/plain + sandbox CSP on its domain, so the UI is hosted
// on GitHub Pages and talks to this function. Data: public.pickem_* (RLS on,
// service_role bypasses). Public (verify_jwt off); the function is the only writer.
//
//   GET                      -> { match, bets }            (config)
//   GET ?view=results        -> { match, bets, entries }   (for standings)
//   POST { match, player, picks } -> { ok }                (submit)
//   OPTIONS                  -> CORS preflight

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const DEFAULT_MATCH = "psg-arsenal-2026";

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

  const { data: match } = await supabase
    .from("pickem_matches").select("*").eq("slug", slug).single();
  if (!match) return json({ error: "Match not found" }, 404);

  const { data: bets } = await supabase
    .from("pickem_bets")
    .select("n, title, blurb, opt_a, opt_b, correct")
    .eq("match_id", match.id).order("n");

  const pub = {
    slug: match.slug,
    competition: match.competition,
    home: match.home,
    away: match.away,
    venue: match.venue,
    kickoff: match.kickoff,
    status: match.status,
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
    if (!picks || typeof picks !== "object") {
      return json({ ok: false, error: "Picks required" }, 400);
    }
    const { data: match } = await supabase
      .from("pickem_matches").select("id, status").eq("slug", slug).single();
    if (!match) return json({ ok: false, error: "Match not found" }, 404);
    if (match.status !== "open") {
      return json({ ok: false, error: "Picks are closed for this match." }, 403);
    }
    const { error } = await supabase.from("pickem_entries")
      .insert({ match_id: match.id, player, picks });
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 400);
  }
}
