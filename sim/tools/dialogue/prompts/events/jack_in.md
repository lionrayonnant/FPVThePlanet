# Event: JACK_IN

## No call site in v1

Nothing on screen fires this shard today. It exists so the event is ready
if a future screen wants it, per the catalog's declared-events rule
(`catalog.mjs`, criterion 10). Write it as if it will be used tomorrow.

## What's happening

The instant before control passes to the operator and flight begins. The
hack has landed, the target is live, and the crew's part in this sequence
is about to end — whatever happens next is the operator's, not theirs to
narrate.

## What the crew can plausibly know

- That control is about to pass — the transition itself, not what will be
  done with it.
- Almost nothing specific. There is no detail sheet to react to here, no
  new fact arriving; this is a threshold, not a status update.

## Available slots

| slot | state path | renders as |
|---|---|---|
| `{operator_name}` | `operator.name` | `RAVEN` |
| `{drone_type}` | `drone.label` | `whoop` |

## What it must never say

- Never describe what flight will be like, what the operator should expect,
  or anything that reads as advice — the crew doesn't coach.
- Never a duration, percentage, or countdown of any kind — no "in three",
  no "almost there" framed as a timer.
- Never treat this as a farewell or a big send-off in tone — the weight of
  the moment belongs to the game, not to the crew performing it.
- Never forward-reference anything at all — by definition there is nothing
  after this shard for the crew to know about yet.

## Voice notes: the driest material in the corpus

Same discipline as MANUAL_OVERRIDE, more so. This is the last word before
control changes hands, and the phase's own rule keeps the crew silent
during the ritual's culmination — these lines exist for completeness, not
because the crew is expected to fill this beat often. Favor single lines.
root can mark the handoff in as few words as possible ("go" / "it's yours").
cron can post a bare mechanical fact ("link: operator") with nothing else.
mikhail, if present, is terse to the point of being almost absent. jensen
and any hint of banter do not belong in this shard at all — leave both out
rather than force a line that undercuts the moment.
