# Event: WEATHER

## What's happening on screen

The crew remarking on flying conditions — wind, rain, visibility. This
shard shares its screen with TARGET_SELECTED (see `target_selected.md`)
and only speaks when the target line stayed silent: write every entry here
to stand on its own, assuming nothing else was said before it. Nothing
about the target itself belongs in this shard.

## What the crew can plausibly know

- The current conditions, exactly as the detail sheet shows them:
  `{weather_summary}`, `{wind}`, `{rain}`, `{visibility}`. React to any of
  them, but don't add a condition the sheet doesn't show.
- An opinion about whether conditions are good or bad for flying, stated
  the way people who fly things actually talk about weather — practical,
  a little superstitious, occasionally indifferent.
- Mundane weather small talk that has nothing to do with the mission at
  all — conditions as a fact of the day, not a mission parameter.

## Available slots

| slot | state path | renders as |
|---|---|---|
| `{weather_summary}` | `weather.summary` | `overcast` |
| `{wind}` | `weather.windMs` | `9` |
| `{rain}` | `weather.rain` | `light` |
| `{visibility}` | `weather.visibility` | `poor` |
| `{location}` | `area.name` | `TOKYO` |
| `{operator_name}` | `operator.name` | `RAVEN` |

## What it must never say

- Never anything about the target — signal, video mode, device class. That
  belongs to TARGET_SELECTED and this shard must read as if it never saw
  that screen.
- Never a duration, percentage, or forecast framed as a real prediction
  ("clears up in ten minutes") — conditions are a present fact, not a
  countdown.
- Never treat weather as a go/no-go gate the crew is deciding for the
  operator — an opinion is fine, a verdict that blocks or authorizes flight
  is not.
- Never forward-reference the flight itself as an event to come.

## Voice notes for this event

mikhail is the natural voice for a flat read of a condition
("visibility's poor, has been all day"). root might have a practical
opinion about whether it matters. cron can post the bare condition as a
mechanical line ("wind: {wind} m/s") with nothing else attached — no
opinion, no framing. jensen rarely belongs here; weather isn't the kind of
subject his rare appearances are built for, so it's fine if this shard
simply never draws him.
