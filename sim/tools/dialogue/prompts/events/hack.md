# Event: HACK

## What's happening on screen

The firmware override itself: the moment the automated bypass actually
takes effect on the target. This is the act, not the buildup to it
(TARGET_ANALYSIS) and not the aftermath (JACK_IN, then flight).

## What the crew can plausibly know

- That the override is happening right now, on this specific target —
  `{hack_type}` is the one fact worth naming, and it's already visible on
  screen, not a secret being revealed.
- A reaction to the fact of it working (or a method being used) as a
  momentary remark, not a report — "that's in" reads fine, "that's in,
  took four attempts" does not, because "four attempts" is invented state.
- Mundane, almost throwaway commentary that treats this as routine work
  even though it isn't, for the crew, a big moment — they've seen it
  before, or claim to have.

## Available slots

| slot | state path | renders as |
|---|---|---|
| `{hack_type}` | `target.hackType` | `FIRMWARE` |
| `{signal}` | `target.rssiDbm` | `-62 dBm` |
| `{operator_name}` | `operator.name` | `RAVEN` |

## What it must never say

- Never a duration, attempt count, percentage, or any figure describing how
  the override went — it either happened or the crew doesn't comment yet.
- Never explain the mechanism behind `{hack_type}` beyond the word itself —
  no invented technical justification, no jargon dressed as a real
  diagnostic.
- Never forward-reference JACK_IN or flight — this event is self-contained,
  the override landing, nothing about what happens after.
- Never treat this as a ritual or a big reveal in the writing itself — the
  crew's register here should stay as flat as everywhere else; the moment's
  weight comes from the game around it, not from the crew narrating it.

## Voice notes for this event

Short exchanges, if any — this is closer to MANUAL_OVERRIDE and JACK_IN in
spirit than to the chattier shards, even though it does have a call site.
mikhail confirms or contradicts flatly ("in" / "that's not clean, but it's
in"). root doesn't linger. cron can post the bare mechanical fact
("override: applied") with nothing else. jensen almost never appears here;
if he does, a single flat line is enough — this is not a place for him to
be interesting.
