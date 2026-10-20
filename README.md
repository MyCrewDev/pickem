# Pick'em: Rob & Marcus bet collector

A match-night "pick'em". Rob sets a handful of two-way bets for a night of football,
both players tap a side on each, picks lock at kick-off, and the board grades itself
from ESPN's live feed. A season account tracks the € balance night by night.

- Site: https://mycrewdev.github.io/pickem/
- Tabs: Tonight (picks, then a live board) · Upcoming (our nights + next Champions League
  fixtures) · Results (every past night) · Season (running € account, chart, 2025-26 archive)

## Money

€5 a bet. A bet only moves money when the two of you picked opposite sides. Balance is
stored as "positive = RobitityRob up". 2025-26 opened at Rob +€25 and closed at Rob +€15
after the final; that €15 is the 2026-27 opening balance (`pickem_seasons`).

## Architecture

- **UI**: `site/index.html` (copied to `docs/` for GitHub Pages, repo `MyCrewDev/pickem`).
- **API**: Supabase edge function `pickem` (project `fluentry-prod`), `functions/pickem/`.
  `index.ts` = routes + database; `grading.ts` = pure grading rules.
- **Data** (RLS on, only the function reads/writes):
  - `pickem_seasons`: name, opening balance, stake
  - `pickem_matches`: one row per night ("card"): slug, title, season, kickoff, status open/closed/settled
  - `pickem_games`: the fixtures on a card, each with its ESPN event id and live score
  - `pickem_bets`: per-bet `rule` (JSON) and `game_key`; `correct` = A/B once settled
  - `pickem_entries`: submissions; latest per player counts

## Grading: automatic, no admin key

Opening a board refreshes it from ESPN, at most every 45 seconds per night. Bet rules:
`winner_home`, `margin_home {min}`, `team_scores {side}`, `total_over {line}`, `btts`,
`player {name, mode: involved|scores}`, `goal_before {minute}`, `extra_time`, `red_card`,
`penalty`, `compare_totals {a, b}` (across two games). "Yes" outcomes settle the moment
they happen; the rest settle at full time.

ESPN blocks requests whose user agent says "Deno", so `grading.ts` sends a browser one.
Proof against real matches: `deno run --allow-net test/grade_test.ts`.

Manual override: `update pickem_bets set correct='A' where ...`.

## Picks are private until kick-off

Before kick-off the API only says who has picked, not what. You can change your
picks until then (latest submission wins).

## Adding a night

Insert a `pickem_matches` row (season, title, kickoff), its `pickem_games` (ESPN event ids
from `site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard?dates=YYYYMMDD`)
and its `pickem_bets` with rules. It appears on Tonight on the day.

## Deploy

- UI: `bash deploy-pages.sh` on the Mac (copies `site/` to `docs/`, pushes).
- API: redeploy `functions/pickem/` via the Supabase MCP `deploy_edge_function`.
