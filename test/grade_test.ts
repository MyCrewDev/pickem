// Proof for the grading rules against real, finished matches.
// Run: deno run --allow-net test/grade_test.ts
import { decide, type Feed, readFeed } from "../functions/pickem/grading.ts";

let fails = 0;
const check = (label: string, got: string | undefined, want: string) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: got ${got ?? "undecided"}, want ${want}`);
};

// 1. The 2026 final (PSG 1-1 Arsenal, PSG on penalties). The new rules must
//    reproduce exactly what was settled in May.
const final = (await readFeed("401862897"))!;
const finalRules: [number, any, string][] = [
  [1, { type: "winner_home" }, "A"],
  [2, { type: "total_over", line: 2.5 }, "B"],
  [3, { type: "btts" }, "A"],
  [4, { type: "player", name: "kvaratskhelia", mode: "involved" }, "B"],
  [5, { type: "player", name: "saka", mode: "involved" }, "B"],
  [6, { type: "goal_before", minute: 45 }, "A"],
  [7, { type: "extra_time" }, "A"],
  [8, { type: "goal_before", minute: 15 }, "A"],
  [9, { type: "red_card" }, "B"],
  [10, { type: "penalty" }, "A"],
];
for (const [n, rule, want] of finalRules) check(`Final bet ${n} (${rule.type})`, decide(rule, final, { g1: final }), want);

// 2. Tonight's rule types, run on last week's LASK 3-6 Liverpool (Liverpool away),
//    and PSG's 4-2 win at Man City (PSG away).
const lask = (await readFeed("401915415"))!;
const city = (await readFeed("401915407"))!;
console.log(`LASK ${lask.home}-${lask.away} Liverpool; City ${city.home}-${city.away} PSG`);
const scorers = (f: Feed) => f.events.filter((e) => e.scoringPlay)
  .map((e) => `${e.clock?.displayValue} ${e.type?.text}: ${(e.participants ?? []).map((p: any) => p.athlete.displayName).join(" / ")}`);
console.log(scorers(lask).join("\n"));
console.log(scorers(city).join("\n"));
check("margin_home 2 (LASK home, lost 3-6)", decide({ type: "margin_home", min: 2 }, lask, {}), "B");
check("team_scores away (Liverpool scored)", decide({ type: "team_scores", side: "away" }, lask, {}), "A");
check("total_over 4.5 (9 goals)", decide({ type: "total_over", line: 4.5 }, lask, {}), "A");
check("winner_home (City lost)", decide({ type: "winner_home" }, city, {}), "B");
check("compare_totals LASK game (9) > City game (6)", decide({ type: "compare_totals", a: "g1", b: "g2" }, undefined, { g1: lask, g2: city }), "A");
check("compare_totals City game (6) > LASK game (9)", decide({ type: "compare_totals", a: "g2", b: "g1" }, undefined, { g1: lask, g2: city }), "B");
check("player nobody-at-all", decide({ type: "player", name: "zzznobody", mode: "involved" }, city, {}), "B");
// Accent handling: Dembélé written without the accent in the rule.
const dembScored = city.events.some((e) => e.scoringPlay && /demb/i.test(e.participants?.[0]?.athlete?.displayName ?? ""));
check("player dembele scores (accent-insensitive)", decide({ type: "player", name: "dembele", mode: "scores" }, city, {}), dembScored ? "A" : "B");

// 3. A game that has not kicked off decides nothing.
const pre: Feed = { state: "pre", over: false, clock: "", detail: "", home: 0, away: 0, winner: null, events: [], teamSide: {}, ninetyDone: false, etReached: false, elapsed: 0 };
check("pre-match decides nothing", decide({ type: "total_over", line: 4.5 }, pre, {}) ?? "undecided", "undecided");
check("compare waits for both games", decide({ type: "compare_totals", a: "g1", b: "g2" }, undefined, { g1: lask, g2: pre }) ?? "undecided", "undecided");

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
if (fails) Deno.exit(1);
