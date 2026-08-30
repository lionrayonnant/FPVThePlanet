# Event: TERRAIN_PROGRESS

## What's happening on screen

Mid-acquisition: geometry and textures are arriving for a sector already
committed to. Same screen as ACQUIRE_AREA (see `acquire_area.md`), but
later in the same job — the crew has had time to notice something about
the data itself, not just that a job started.

## What the crew can plausibly know

- That the job from ACQUIRE_AREA is still running — this is a continuation,
  not a new event, so treat it as "still going," never as a fresh start.
- Whether the incoming mesh or texture data looks structurally sound so
  far: holes, seams, a checksum that came back clean or didn't. This is
  quality-control chatter about what's arriving, not a readout of how much
  has arrived.
- Mundane operational back-and-forth that only makes sense once something
  has been running a while: is this taking the usual shape, has this
  sector given trouble before, is anyone actually watching it.
- root or mikhail idly asking whether the job is done — and mikhail
  refusing to answer that in numbers, because a real number is off limits.

## Available slots

| slot | state path | renders as |
|---|---|---|
| `{location}` | `area.name` | `TOKYO` |
| `{terrain_size}` | `terrain.tiles` | `842` |
| `{terrain_mb}` | `terrain.megabytes` | `310 MB` |
| `{operator_name}` | `operator.name` | `RAVEN` |

## What it must never say

- Never a duration, percentage, or progress figure of the real pipeline
  ("60% done", "3 minutes left", "40MB/s"). This is the same hard invariant
  as ACQUIRE_AREA — it does not loosen because the job has been running
  longer.
- Never confirm or explain what happens after acquisition — no forward
  reference to flying, scanning, or hacking.
- Never restate `{terrain_size}` / `{terrain_mb}` as if it changed since
  ACQUIRE_AREA — these are the job's totals, not a live counter climbing
  toward them.
- Never name a real-world place unless it comes through `{location}`.

## Voice notes for this event

This shard should feel like the second half of the same conversation
ACQUIRE_AREA started, not a new one — lines can assume the job is already
known about. mikhail is the one most likely to flag something structurally
off in the data itself ("seam on tile four", "checksum's off, again").
cron posts mechanical state changes only ("mesh job: pass", "texture bake:
queued") — never a fraction, never an ETA. root's patience (or lack of it)
about how long things take is fair game, as long as no number backs it up.
