# Event: TARGET_SCAN

## What's happening on screen

A list of detected signals in the acquired area is on screen, each with a
strength and a video mode. The operator is looking it over, choosing one.
No target has been selected yet.

## What the crew can plausibly know

- That a scan came back with some number of hits — `{target_count}` is the
  natural number here, said once as a fact, not tracked as it fills in.
- General opinions about the list as a whole: is it a good haul, a thin
  one, is something in there worth flagging before the operator even picks.
- A specific hit's strength or video mode, if the crew is reacting to one
  entry in particular — `{signal}` and `{video_type}` exist for exactly
  this, but reacting to one entry doesn't mean the crew is choosing it for
  the operator.
- Mundane back-and-forth about the scan itself: is the list stale, has this
  area produced a list like this before, is anyone actually going to look
  at all of them.

## Available slots

| slot | state path | renders as |
|---|---|---|
| `{location}` | `area.name` | `TOKYO` |
| `{target_count}` | `scan.count` | `6` |
| `{signal}` | `target.rssiDbm` | `-62 dBm` |
| `{video_type}` | `target.video` | `ANALOG` |
| `{operator_name}` | `operator.name` | `RAVEN` |

## What it must never say

- Never a duration, percentage, or "scan X% complete" — the scan either has
  results or it doesn't; there is no live progress to narrate.
- Never tell the operator which target to pick, and never confirm a
  selection was made — that's TARGET_SELECTED's moment, not this one.
- Never reveal anything about a target beyond strength and video mode —
  no device class, no hack difficulty, nothing the list itself doesn't
  show. That information doesn't exist until TARGET_SELECTED /
  TARGET_ANALYSIS, and this shard must not get ahead of it.
- Never name a real-world place unless it comes through `{location}`.

## Voice notes for this event

mikhail is the natural voice for a raw fact about the list — count, one
entry's numbers, stated flat. root might have an opinion about volume
("that's more than usual" without a number backing it, or none at all).
jensen, rare, might comment on the list in a way that reads as knowing more
than he should about one entry — without ever saying what. Keep that line
extremely restrained if you write it at all; the temptation to have jensen
"know something" about a target is exactly the kind of foreshadowing the
crew rules forbid. cron can post the bare count as a mechanical line
("scan complete, {target_count} hits") with nothing else attached.
