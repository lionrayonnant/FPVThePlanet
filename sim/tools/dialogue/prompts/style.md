# Style

The era is a technical software product from roughly 1998-2003: terminal
channels, pagers, build logs, radio discipline. Nobody is chatty. Write in
English, and it must read as native technical-software English — not a
translation, not a script, not corporate copy.

Short. Dry. Technical when the moment is technical, mundane when the moment
is mundane, occasionally funny in the way tired competent people are funny,
occasionally just strange for no explained reason. Not every line needs a
point. **Silence is a valid outcome of the system that plays these lines —
you are not asked to fill every beat, only to write good ones.**

A line is a sentence or a fragment, not a paragraph. A whole exchange is a
handful of lines, not a scene. If a line needs a second sentence to land,
it's probably two lines, or it's trying too hard.

## Hard prohibitions

These are enforced mechanically by the validator that checks everything you
write. A line that trips one of these is discarded outright, no matter how
good the rest of it is. Do not write any of the following, in these terms or
close paraphrases of them:

- **Never address the player or the user.** No "the player", no "the user".
  Nobody in this world knows there is one.
- **Never break the fourth wall.** No "the game", no "this is a game", no
  acknowledgment that any of this is being played, watched, or simulated.
- **Never use modern AI vocabulary.** No "LLM", no "prompt" / "prompting" /
  "prompted", no "neural net", no "machine learning". This crew has never
  heard these words.
- **Never promise a sequel.** No "to be continued", "next time", "more on
  that later", "explain later", "you'll see", "you will find out", "you
  will know". Nothing may gesture at content that doesn't exist yet.
- **No video-game vocabulary.** No "gameplay", "respawn", "power-up" /
  "powerup", "high score" / "high scores", "NPC", "level up". This crew
  works on real systems, not games.

If a line only works because of one of these words or phrases, the line
doesn't work. Rewrite it without them rather than looking for a loophole in
the wording.

## One more rule, specific to per-event material

The crew must never state real pipeline state: no durations, no
percentages, no progress figures, no "X seconds left", no "80% done", no
counts-of-total ("12 of 12"), no stall or offset reports ("stalled at
offset 0x4000"). This applies to cron as much as to root, mikhail or
jensen — cron may say a thing happened, never how far along it is. Any
event brief that gives you specific technical facts (tile counts, signal
strength, weather) is giving you flavour to react to, not a status readout
to narrate. The dialogue is decoration on top of the pipeline, never a
diagnostic of it.

## Mechanical limits

- One line: at most 90 characters, plainly. Longer is not "more dialogue,"
  it's a paragraph pretending to be a line.
- One exchange: at most 6 lines. Most exchanges are 1-3.
- Lowercase, terminal-register punctuation is fine and often better than a
  full sentence with a capital and a period. Look at existing entries in
  the shard you're given — match that register, don't invent a new one.
