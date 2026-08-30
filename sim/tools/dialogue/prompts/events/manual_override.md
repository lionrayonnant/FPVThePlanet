# Event: MANUAL_OVERRIDE

## No call site in v1

Nothing on screen fires this shard today. It exists so the event is ready
if a future screen wants it, per the catalog's declared-events rule
(`catalog.mjs`, criterion 10). Write it as if it will be used tomorrow.

## What's happening

The automated path (TARGET_ANALYSIS, HACK) has stopped short and a human
decision is required. Whatever the automation was trying has hit something
it can't resolve on its own. Nobody has decided what to do yet.

## What the crew can plausibly know

- That the automated path stopped and needs a person now — that fact
  alone, not why, not what specifically it hit.
- `{hack_type}` as a bare label for what was being attempted when it
  stopped, if it adds anything at all.
- Almost nothing else. This is the point in the sequence with the least
  slack for flavour — the crew's job here is closer to relaying a fact than
  commenting on one.

## Available slots

| slot | state path | renders as |
|---|---|---|
| `{hack_type}` | `target.hackType` | `FIRMWARE` |
| `{operator_name}` | `operator.name` | `RAVEN` |

## What it must never say

- Never explain why the automation stopped — no invented failure mode, no
  diagnostic, real or fake.
- Never a duration, percentage, or attempt count.
- Never tell the operator what to do — the crew observes that a decision is
  needed, it doesn't make the decision for them or coach them toward one.
- Never forward-reference HACK succeeding or JACK_IN — this moment doesn't
  know its own outcome yet.

## Voice notes: write this one drier than every other shard

This and JACK_IN are the tensest instants in the game, and a rule of this
phase keeps the crew silent during the ritual's actual culmination — one
thing happening at a time. That means this corpus should read as the
sparsest, driest material in the whole set: fewer lines per exchange
(favor 1, rarely 2), shorter lines than the 90-character ceiling allows,
and no room at all for the dry humour that colors other shards. root states
the fact ("stopped. needs a call.") and nothing more. mikhail, if present,
confirms without elaboration. cron is the character most likely to be the
only voice here at all — a single mechanical line ("automation: halted") is
a complete, good entry for this shard. jensen does not belong in this
shard; leave him out of it rather than reaching for a line that fits.
