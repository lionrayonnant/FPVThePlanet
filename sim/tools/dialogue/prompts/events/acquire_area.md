# Event: ACQUIRE_AREA

## What's happening on screen

The operator has just picked a sector to fly and the system has started
pulling terrain for it: a new area is queued, tiles and textures start
coming in. This event also covers TERRAIN_PROGRESS moments loosely — the
crew reacting to a mesh or texture job that's underway, not finished. There
is no drone in the air yet. Nothing has been flown, scanned, or hacked.

## What the crew can plausibly know

- That a new sector/area was just picked, and roughly where (a location
  name may be available).
- That terrain data is being pulled in: tile counts, download size — these
  are things mikhail or cron could plausibly have a number for, but see the
  rule below about not narrating real numbers as status.
- Whether the incoming mesh or texture data looks structurally sound
  ("no holes so far", "checksum queued") — quality-control chatter, not a
  progress bar.
- Mundane operational back-and-forth: whether to ship something early,
  whether "fine" means anything precise, whether the job is actually done.

## Available slots

Use a slot only if the entry's `requires` lists its state path (see
`prompts/style.md` and the validator — an unlisted path makes the entry
dead on arrival). Most good entries in this shard use none at all; a slot
is a garnish, not a requirement.

| slot | state path | renders as |
|---|---|---|
| `{location}` | `area.name` | `TOKYO` |
| `{terrain_size}` | `terrain.tiles` | `842` |
| `{terrain_mb}` | `terrain.megabytes` | `310 MB` |
| `{operator_name}` | `operator.name` | `RAVEN` |

## What it must never say

- Never a duration, a percentage, or a progress figure of the real pipeline
  ("60% done", "3 minutes left", "download at 40MB/s"). That is decoration,
  not a diagnostic — this is a hard invariant from an earlier phase, not a
  style preference.
- Never confirm or explain what happens after acquisition — no forward
  reference to flying, scanning, or hacking as if narrating a tutorial.
- Never name a specific real-world place unless it comes through the
  `{location}` slot — the crew doesn't know more about the sector than the
  operator does.

## Existing tone (for calibration, not for copying)

"new sector queued" / "on it". "how many tiles" / "{terrain_size}" / "that
is a lot" / "depends what you count". "ship it when it lands" / "no" /
"why" / "because it is not landed yet" / "fair". "textures baking" /
"checksum queued" (cron). Terse, procedural, occasionally a small
disagreement about whether "fine" or "done" actually means anything.
