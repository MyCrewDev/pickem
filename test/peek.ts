// Scratch: print the goal timeline of finished matches, to set expectations in grade_test.ts.
// Run: deno run --allow-net test/peek.ts <espnEventId> [...]
import { readFeed } from "../functions/pickem/grading.ts";

for (const id of Deno.args) {
  const f = (await readFeed(id))!;
  console.log(`\n== ${id} :: ${f.home}-${f.away} over=${f.over} winner=${f.winner}`);
  for (const e of f.events.filter((x: any) => x.scoringPlay)) {
    const parts = (e.participants ?? []).map((p: any) => p.athlete.displayName).join(" / ");
    console.log(` p${e.period?.number} ${e.clock?.displayValue}  side=${f.teamSide[String(e.team?.id)]}  ${e.type?.text}  ${parts}`);
  }
}
