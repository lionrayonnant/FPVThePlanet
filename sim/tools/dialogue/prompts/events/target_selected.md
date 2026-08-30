# Event: TARGET_SELECTED

## What's happening on screen

One target's detail sheet is open: signal, a device class estimate, video
mode, and the current weather. The operator has committed to this target
but hasn't started the automated bypass yet.

## What the crew can plausibly know

- Everything the detail sheet itself shows: signal strength (`{signal}`),
  video mode (`{video_type}`), current weather (`{weather_summary}`,
  `{wind}`, `{rain}`, `{visibility}`). The crew can react to any of it, but
  never add a fact the sheet doesn't already contain.
- An opinion about the device class estimate as a category, not a number —
  there is no slot for device class, so if the crew comments on it, it's
  qualitative ("that's an old one", "cheap gear") and nothing more precise
  than what a reader would infer from tone.
- Whether this target looks like a good pick relative to nothing in
  particular — an opinion, not a comparison to other entries on the scan
  list, since this screen only shows the one.
- Mundane commentary about the weather as it happens to be, without
  treating it as a forecast or a warning system.

## Available slots

| slot | state path | renders as |
|---|---|---|
| `{signal}` | `target.rssiDbm` | `-62 dBm` |
| `{video_type}` | `target.video` | `ANALOG` |
| `{weather_summary}` | `weather.summary` | `overcast` |
| `{wind}` | `weather.windMs` | `9` |
| `{rain}` | `weather.rain` | `light` |
| `{visibility}` | `weather.visibility` | `poor` |
| `{operator_name}` | `operator.name` | `RAVEN` |

## What it must never say

- Never reveal anything the detail sheet does not already show — no hack
  difficulty, no success odds, no hint about what the bypass will find.
  That belongs to TARGET_ANALYSIS at the earliest, and even there stays
  off-limits as a real diagnostic.
- Never a duration, percentage, or progress figure of any kind.
- Never forward-reference the bypass, the hack, or flight as if narrating
  what happens next — this screen is a decision point, not a preview.
- Never invent a device-class fact more specific than tone allows — there
  is no slot backing it, so precision here is a tell that something was
  made up.

## Voice notes for this event

This shard shares its screen with WEATHER (see `weather.md`), and only one
of the two fires per beat — WEATHER covers conditions when the target line
stayed silent, so this shard doesn't need to carry every weather remark
itself; it's fine for most entries here to be about the target and leave
weather alone entirely. mikhail is the natural voice for a flat read of
signal or video mode. root might size up whether the pick is worth the
trouble. jensen, rare, might have a one-line reaction to the target that
gives away nothing about why he'd care.
