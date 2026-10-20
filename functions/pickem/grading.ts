// Pure grading logic: reads ESPN's soccer summary feed and decides each bet from its rule.
// No database access here, so it can be proven against real matches (see test/grade_test.ts).

export const ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions";
// ESPN rejects requests whose user agent says "Deno", which is what Supabase edge functions send.
export const ESPN_HEADERS = { "user-agent": "Mozilla/5.0 (compatible; pickem/1.0)", accept: "application/json" };
export const espnFetch = (path: string) => fetch(`${ESPN}${path}`, { headers: ESPN_HEADERS });

export const norm = (s: string) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const periodOf = (ev: any): number => Number(ev?.period?.number ?? 0);
const minuteOf = (ev: any): number => {
  const m = String(ev?.clock?.displayValue ?? "").match(/(\d+)/);
  return m ? parseInt(m[1], 10) : -1;
};

export type Feed = {
  state: string; over: boolean; clock: string; detail: string;
  home: number; away: number; winner: "home" | "away" | null;
  events: any[]; teamSide: Record<string, string>;
  ninetyDone: boolean; etReached: boolean; elapsed: number;
};

export async function readFeed(eventId: string): Promise<Feed | null> {
  try {
    const r = await espnFetch(`/summary?event=${eventId}`);
    return parseFeed(await r.json());
  } catch (_) { return null; }
}

export function parseFeed(d: any): Feed | null {
  try {
    const comp = d?.header?.competitions?.[0] ?? {};
    const competitors = comp.competitors ?? [];
    const teamSide: Record<string, string> = {};
    for (const c of competitors) teamSide[String(c?.team?.id)] = c?.homeAway;
    const st = comp?.status ?? {};
    const type = st.type ?? {};
    const over = !!type.completed;
    const events: any[] = d?.keyEvents ?? [];
    const sc = (side: string) => Number(competitors.find((c: any) => c?.homeAway === side)?.score ?? 0) || 0;
    const w = competitors.find((c: any) => c?.winner === true);
    const etReached = events.some((e) => periodOf(e) >= 3) || /extra|pen/i.test(`${type.detail} ${type.name}`);
    const m = String(st.displayClock ?? "").match(/(\d+)/);
    const elapsed = m ? parseInt(m[1], 10) : (over ? 999 : 0);
    return {
      state: type.state ?? "pre", over, clock: type.shortDetail || st.displayClock || "",
      detail: type.description || type.detail || "",
      home: sc("home"), away: sc("away"), winner: w ? w.homeAway : null,
      events, teamSide, etReached, ninetyDone: over || etReached, elapsed,
    };
  } catch (_) { return null; }
}

// Returns "A", "B" or undefined (not decided yet).
export function decide(rule: any, f: Feed | undefined, feeds: Record<string, Feed>): string | undefined {
  if (!rule) return undefined;
  if (rule.type === "compare_totals") {
    const a = feeds[rule.a], b = feeds[rule.b];
    if (!a?.over || !b?.over) return undefined;
    return (a.home + a.away) > (b.home + b.away) ? "A" : "B";
  }
  if (!f || f.state === "pre") return undefined;
  const goals = f.events.filter((e) => e?.scoringPlay && periodOf(e) <= 4);
  const notOwn = goals.filter((g) => !/own goal/i.test(g?.type?.text ?? ""));
  const sideGoals = (side: string) => goals.filter((g) => f.teamSide[String(g?.team?.id)] === side).length;
  switch (rule.type) {
    case "winner_home": {
      if (!f.over) return undefined;
      if (f.winner) return f.winner === "home" ? "A" : "B";
      return f.home > f.away ? "A" : "B";
    }
    case "margin_home":
      return f.over ? (f.home - f.away >= rule.min ? "A" : "B") : undefined;
    case "team_scores": {
      const n = rule.side === "home" ? f.home : f.away;
      if (n >= 1) return "A";
      return f.over ? "B" : undefined;
    }
    case "total_over":
      if (f.home + f.away > rule.line) return "A";
      return f.over ? "B" : undefined;
    case "btts":
      if (sideGoals("home") >= 1 && sideGoals("away") >= 1) return "A";
      return f.ninetyDone ? "B" : undefined;
    case "player": {
      const name = norm(rule.name);
      const hit = notOwn.some((g) => {
        const ps = (g?.participants ?? []).map((p: any) => norm(p?.athlete?.displayName));
        return rule.mode === "scores" ? (ps[0] ?? "").includes(name) : ps.some((p: string) => p.includes(name));
      });
      if (hit) return "A";
      return f.over ? "B" : undefined;
    }
    case "goal_before": {
      if (goals.some((g) => minuteOf(g) >= 0 && minuteOf(g) <= rule.minute && periodOf(g) === 1)) return "A";
      const passed = f.over || f.elapsed > rule.minute || f.events.some((e) => periodOf(e) >= 2);
      return passed ? "B" : undefined;
    }
    case "extra_time":
      if (f.etReached) return "A";
      return f.over ? "B" : undefined;
    case "red_card":
      if (f.events.some((e) => /red card/i.test(e?.type?.text ?? ""))) return "A";
      return f.over ? "B" : undefined;
    case "penalty":
      if (f.events.some((e) => periodOf(e) < 5 && /penalt/i.test(e?.type?.text ?? ""))) return "A";
      return f.over ? "B" : undefined;
  }
  return undefined;
}

