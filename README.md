# Pick'em — Rob & Marcus bet collector

A branded match-day "pick'em" page. Rob presents a set of two-way bets, Marcus
(or anyone) taps a side per bet and submits. Picks land in Supabase and Rafa can
read them back instantly. After the match the bets get graded and a head-to-head
tally appears. Reusable for every match (one row per match, season tally across them).

## Live URLs (PSG v Arsenal, 2026 CL final)

- Picks page: https://mycrewdev.github.io/pickem/
- Results / standings: https://mycrewdev.github.io/pickem/?view=results&match=psg-arsenal-2026

## Architecture

- **UI**: static `docs/index.html`, hosted on GitHub Pages (`MyCrewDev/pickem`).
  Data-driven: it fetches the match + bets from the API and renders the form.
- **API**: Supabase Edge Function `pickem` (project `fluentry-prod`,
  `functions/pickem/index.ts`). JSON API with CORS. `verify_jwt` off so the page
  can call it; the function is the only writer (uses service_role server-side).
  - `GET` -> `{ match, bets }`
  - `GET ?view=results` -> `{ match, bets, entries }`
  - `GET ?action=grade&key=robmeister` -> auto-grades from the live feed, returns `{ settled, pending, status }`
  - `POST { match, player, picks }` -> `{ ok }`
- **Picks lock** at kick-off: the API rejects submissions once `kickoff` passes.
- **Auto-grading** reads ESPN's free, no-key soccer summary feed
  (`site.api.espn.com/.../uefa.champions/summary?event=<espn_event_id>`), which
  exposes goal minutes, scorers/assisters, cards, penalties, and the result incl.
  extra time. The ESPN event id is stored on `pickem_matches.espn_event_id`
  (this final = `401862897`). Mapping logic validated against the 2025 final.
  (The football-data.org token obtained during setup went unused; ESPN alone
  covers all ten markets.)
- **Data**: `public.pickem_matches`, `public.pickem_bets`, `public.pickem_entries`
  (RLS on; only service_role reaches them). See `schema.sql`.

> Why GitHub Pages and not Supabase? Supabase forces `content-type: text/plain`
> and a sandbox CSP on everything served from `*.supabase.co` (edge functions and
> storage alike), so it can't render an HTML app. The page lives off-platform and
> talks to the function.

## Grading (automatic)

Open the admin results page:

```
https://mycrewdev.github.io/pickem/?view=results&admin=robmeister
```

It shows an "Update results" button. Press it any time during/after the match;
it pulls live ESPN events and settles every bet that's now decided (the rest stay
pending until they happen). The standings/tally update on the page automatically.
"Yes"-type outcomes settle the moment they occur (goal in 15', red card, etc.);
"No"-type and the winner settle once the relevant point has passed (HT, 90 mins, FT).

Manual override (if ever needed): set `correct` to `A`/`B` per bet.

```sql
update public.pickem_bets b set correct = 'A'
from public.pickem_matches m
where b.match_id = m.id and m.slug = 'psg-arsenal-2026' and b.n = 1;
```

## Close picks at kickoff

```sql
update public.pickem_matches set status = 'closed' where slug = 'psg-arsenal-2026';
```

## Add a new match

Insert a row into `pickem_matches` (new `slug`) and 10 rows into `pickem_bets`,
then share `https://mycrewdev.github.io/pickem/?match=<slug>`.

## Deploy

- UI: `bash deploy-pages.sh` (run on the host; copies `site/` -> `docs/`, pushes, enables Pages).
- API: redeploy `functions/pickem/index.ts` via the Supabase MCP `deploy_edge_function`.
