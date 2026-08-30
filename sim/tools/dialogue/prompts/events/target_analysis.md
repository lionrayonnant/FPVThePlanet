# Event: TARGET_ANALYSIS

## What's happening on screen

An automated bypass sequence is running against the chosen target. This is
before the hack itself lands — the system is working the problem on its
own, no human decision has been asked for yet.

## What the crew can plausibly know

- That an automated sequence is running against this specific target —
  `{hack_type}` and `{signal}` are fair game as facts already visible on
  screen, not as commentary on how the attempt is going.
- Whether the approach being tried looks routine or unusual for this kind
  of target — an opinion about the method, not a report on its progress.
- Mundane friction about automation itself: whether it's trusted, whether
  it's ever been wrong before, whether someone should be watching it more
  closely than they are.
- mikhail contradicting root about whether the automated path is even the
  right call for this target — a disagreement about method, not a leak of
  outcome.

## Available slots

| slot | state path | renders as |
|---|---|---|
| `{hack_type}` | `target.hackType` | `FIRMWARE` |
| `{signal}` | `target.rssiDbm` | `-62 dBm` |
| `{video_type}` | `target.video` | `ANALOG` |
| `{operator_name}` | `operator.name` | `RAVEN` |

## What it must never say

- Never a duration, percentage, or step count of the bypass — no "half
  done", no "on step three", no ETA.
- Never state or imply the outcome — not success, not failure, not "this
  one's going to need a person." That's what MANUAL_OVERRIDE exists to
  cover on its own, silently, when it happens; this shard doesn't get to
  foreshadow it.
- Never explain how the bypass works technically beyond what `{hack_type}`
  already names — no invented mechanism, no jargon that reads as a real
  diagnostic.
- Never forward-reference the jack-in or flight that follows a successful
  hack.

## Voice notes for this event

mikhail is the natural voice for a dry, precise read of the method in use
("firmware path, again") with no verdict attached. root is the one likeliest
to be impatient about automation without being able to do anything about it
yet. cron can post the mechanical fact that a sequence is running
("bypass sequence: active") with nothing else — no status, no ETA, just
that it started. jensen, rare, is the character most tempting to write as
"knowing" whether it'll work — resist that; a jensen line here should be as
evasive and empty of information as everywhere else.
