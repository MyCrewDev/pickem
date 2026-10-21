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

// 3. The rule types added for Matchday 4, against three finished matches whose
//    timelines are known (see test/peek.ts):
//      Liverpool 4-3 Villarreal  - Villarreal scored first (4'), last goal 87'
//      PSG 4-2 Barcelona         - PSG scored first (38', Doué), goals at 81' and 86'
//      PSG 1-1 Arsenal (final)   - Arsenal scored first (6', Havertz), nothing after 65'
const liv = (await readFeed("401915397"))!;
const psg = (await readFeed("401915399"))!;
const md4: [string, any, Feed, string][] = [
  // no_loss: a draw counts as not losing, which winner_home got wrong.
  ["Liverpool don't lose (won 4-3)", { type: "no_loss", side: "home" }, liv, "A"],
  ["Villarreal don't lose (lost 3-4)", { type: "no_loss", side: "away" }, liv, "B"],
  ["PSG don't lose the final (1-1 draw)", { type: "no_loss", side: "home" }, final, "A"],
  ["Arsenal don't lose the final (1-1 draw)", { type: "no_loss", side: "away" }, final, "A"],
  // first_goal: who opened the scoring.
  ["Villarreal scored first", { type: "first_goal", side: "away" }, liv, "A"],
  ["Liverpool scored first", { type: "first_goal", side: "home" }, liv, "B"],
  ["PSG scored first v Barcelona", { type: "first_goal", side: "home" }, psg, "A"],
  ["PSG scored first in the final", { type: "first_goal", side: "home" }, final, "B"],
  // first_scorer: named player opens the scoring (accent-insensitive).
  ["Mikautadze opened v Liverpool", { type: "first_scorer", name: "mikautadze" }, liv, "A"],
  ["Doue opened v Barcelona", { type: "first_scorer", name: "doue" }, psg, "A"],
  ["Vitinha opened v Barcelona (he scored 81')", { type: "first_scorer", name: "vitinha" }, psg, "B"],
  ["Havertz opened the final", { type: "first_scorer", name: "havertz" }, final, "A"],
  ["Dembele opened the final (he scored 65')", { type: "first_scorer", name: "dembele" }, final, "B"],
  // goal_after: a goal from minute N on, stoppage time included.
  ["Goal from 80' on, Liverpool game (87')", { type: "goal_after", minute: 80 }, liv, "A"],
  ["Goal from 80' on, PSG game (81', 86')", { type: "goal_after", minute: 80 }, psg, "A"],
  ["Goal from 88' on, PSG game (last was 86')", { type: "goal_after", minute: 88 }, psg, "B"],
  ["Goal from 80' on, the final (last was 65')", { type: "goal_after", minute: 80 }, final, "B"],
  ["Goal from 45' on, Liverpool game (45'+2 counts)", { type: "goal_after", minute: 45 }, liv, "A"],
  // all: every part must land, one miss kills it.
  ["Villarreal score and Liverpool still win", { type: "all", rules: [{ type: "team_scores", side: "away" }, { type: "winner_home" }] }, liv, "A"],
  ["Barcelona score and PSG still win", { type: "all", rules: [{ type: "team_scores", side: "away" }, { type: "winner_home" }] }, psg, "A"],
  // The final went to penalties, and ESPN names PSG the winner, so "still win" lands.
  // In the league phase there are no penalties, so a draw falls through to the
  // scoreline and settles as B - see the full-time draw case below.
  ["Arsenal score and PSG still win the final (on pens)", { type: "all", rules: [{ type: "team_scores", side: "away" }, { type: "winner_home" }] }, final, "A"],
  ["Both score and 4+ goals, Liverpool game (7)", { type: "all", rules: [{ type: "btts" }, { type: "total_over", line: 3 }] }, liv, "A"],
  ["Both score and 4+ goals, the final (2)", { type: "all", rules: [{ type: "btts" }, { type: "total_over", line: 3 }] }, final, "B"],
];
for (const [label, rule, feed, want] of md4) check(label, decide(rule, feed, {}), want);

// 4. Half-time, 0-1: the compound bet must stay open, not guess.
const halfTime: Feed = {
  state: "in", over: false, clock: "HT", detail: "Halftime", home: 0, away: 1, winner: null,
  events: [{ scoringPlay: true, period: { number: 1 }, clock: { displayValue: "22'" }, type: { text: "Goal" }, team: { id: "99" }, participants: [{ athlete: { displayName: "A Player" } }] }],
  teamSide: { "1": "home", "99": "away" }, ninetyDone: false, etReached: false, elapsed: 45,
};
check("compound stays open at half-time", decide({ type: "all", rules: [{ type: "team_scores", side: "away" }, { type: "winner_home" }] }, halfTime, {}) ?? "undecided", "undecided");
check("no_loss stays open at half-time", decide({ type: "no_loss", side: "home" }, halfTime, {}) ?? "undecided", "undecided");
check("first_goal settles live, away led first", decide({ type: "first_goal", side: "away" }, halfTime, {}), "A");
check("goal_after 80 stays open at half-time", decide({ type: "goal_after", minute: 80 }, halfTime, {}) ?? "undecided", "undecided");

// A league-phase 1-1: nobody wins, so "they score but we still win" must settle as B.
const drawFT: Feed = {
  ...halfTime, state: "post", over: true, clock: "FT", detail: "Full Time", home: 1, away: 1, ninetyDone: true, elapsed: 90,
  events: [
    { scoringPlay: true, period: { number: 1 }, clock: { displayValue: "22'" }, type: { text: "Goal" }, team: { id: "99" }, participants: [{ athlete: { displayName: "A Player" } }] },
    { scoringPlay: true, period: { number: 2 }, clock: { displayValue: "70'" }, type: { text: "Goal" }, team: { id: "1" }, participants: [{ athlete: { displayName: "B Player" } }] },
  ],
};
check("away score but home only draw", decide({ type: "all", rules: [{ type: "team_scores", side: "away" }, { type: "winner_home" }] }, drawFT, {}), "B");
check("home don't lose a 1-1 draw", decide({ type: "no_loss", side: "home" }, drawFT, {}), "A");

// 5. A game that has not kicked off decides nothing.
const pre: Feed = { state: "pre", over: false, clock: "", detail: "", home: 0, away: 0, winner: null, events: [], teamSide: {}, ninetyDone: false, etReached: false, elapsed: 0 };
check("pre-match decides nothing", decide({ type: "total_over", line: 4.5 }, pre, {}) ?? "undecided", "undecided");
check("compare waits for both games", decide({ type: "compare_totals", a: "g1", b: "g2" }, undefined, { g1: lask, g2: pre }) ?? "undecided", "undecided");

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
if (fails) Deno.exit(1);
