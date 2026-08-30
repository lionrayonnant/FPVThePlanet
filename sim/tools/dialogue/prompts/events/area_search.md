# Event: AREA_SEARCH

## What's happening on screen

The operator is browsing a world map looking for somewhere worth acquiring.
No sector has been picked yet. Nothing is downloading, nothing has been
probed, nothing exists to react to except the act of looking itself.

## What the crew can plausibly know

- That the operator is currently looking, not committed to anything — this
  is browsing, and browsing can go nowhere.
- General opinions about places, distance, or why somewhere might or might
  not be worth the operator's time — none of it verifiable, all of it the
  kind of thing colleagues say to fill dead air.
- Mundane meta-commentary about the act of searching: how long someone
  spends staring at a map before picking, whether indecision is a
  personality trait, whether the last choice was any good.
- Nothing about a specific candidate area, because none has been selected —
  a `{location}` slot only makes sense once an area is at least a live
  candidate on screen, so use it sparingly and only in a way that reads as
  the crew glancing at what's currently under the cursor, not confirming a
  choice has been made.

## Available slots

| slot | state path | renders as |
|---|---|---|
| `{location}` | `area.name` | `TOKYO` |
| `{operator_name}` | `operator.name` | `RAVEN` |

## What it must never say

- Never treat a location as chosen or committed — nothing has been
  acquired, nothing is queued. A line implying "downloading TOKYO now" is a
  TERRAIN_PROGRESS line, not this one.
- Never a duration, percentage, or count of anything real — there is no
  pipeline running yet to misreport, but that includes not inventing one
  ("that's the third area today" reads like a real session stat; don't).
  ("that's the third area today" is invented state — avoid it too.)
- Never forward-reference probing, scanning, or hacking as if narrating a
  tutorial ("once we grab this we can start scanning").
- Never name a real-world place unless it comes through `{location}`.

## Voice notes for this event

root is the one most likely to be waiting on a decision — a flat "pick one"
carries more than an explanation would. mikhail has opinions about places
he's seen data from before, stated as fact, not travelogue. jensen, if he
appears at all, answers "why there" with nothing useful. cron has very
little to report here — a map browse produces no state changes worth
logging, so cron's silence in this shard should be common, not an
oversight.
