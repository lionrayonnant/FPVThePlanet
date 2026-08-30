# Event: PROBE_AREA

## What's happening on screen

A specific area has just been probed: an estimate of size, tile count, and
signal density comes back. Nothing has been committed to yet — this is a
look before a decision, not the decision itself. No download has started.

## What the crew can plausibly know

- That a probe just ran against a specific area and returned an estimate —
  mikhail or cron are the natural sources for a number like this, but see
  the rule below about not narrating it as a live readout.
- Whether the estimate looks big, small, dense, or sparse relative to
  ordinary jobs — a qualitative opinion, not a second number restating the
  first.
- Whether the estimate itself is trustworthy — probes can be wrong, and
  mikhail is exactly the voice who'd say so.
- Mundane back-and-forth about whether to commit: is this worth it, is
  there something better nearby, has this area come up before.

## Available slots

| slot | state path | renders as |
|---|---|---|
| `{location}` | `area.name` | `TOKYO` |
| `{terrain_size}` | `terrain.tiles` | `842` |
| `{terrain_mb}` | `terrain.megabytes` | `310 MB` |
| `{operator_name}` | `operator.name` | `RAVEN` |

## What it must never say

- Never a duration, percentage, or progress figure — a probe estimate
  (`{terrain_size}`, `{terrain_mb}`) is a one-time number reacted to, not a
  status ticking upward. Once it's said, it doesn't get restated as if
  tracking a download.
- Never confirm the area has been acquired — PROBE_AREA is strictly before
  commitment. No "downloading now", no "it's in".
- Never invent a "signal density" number — there is no slot for it. React
  to density as a qualitative impression ("a lot going on down there") if
  at all, never as a figure.
- Never name a real-world place unless it comes through `{location}`.

## Voice notes for this event

mikhail is the natural voice for the estimate itself, stated flatly.
root decides whether it's worth pursuing, often in one word. jensen, rare,
might undercut the whole exercise ("does it matter") without explaining
why. cron can post the bare estimate as a mechanical readout ("probe
complete, {terrain_size} tiles") with zero opinion attached — that's the
one place a number belongs, stated once, not tracked.
