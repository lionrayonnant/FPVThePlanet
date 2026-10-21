# The FPVTP! mark

The symbol is an **interrupted frame** and a **grid of 5 × 5 modules**. It
depicts nothing: it is a randomart, the session signature already described in
Bible §26, frozen into a single pattern. It has no other reading, and that is
intended — Bible §1, an artefact rather than an illustration.

## Geometry

Everything sits on a grid of 100 units, 16 modules of 6.25.

- frame: 6 units thick, on all four sides;
- interruption: 28 units wide, centred, on the top edge — that is where
  the title is set into a panel;
- pattern: 5 × 5 cells of 13, pitch 15.2, offset 12;
- filled cells, by row:

```text
. # . . #
# # . # #
. # # # .
# . # . .
# # . . #
```

19 filled rectangles in total, no strokes, no rounding, no overlaps.
The file is therefore directly extrudable for 3D printing
(`fpvtp-mark-extrude.svg`).

## Files

| file | use |
|---|---|
| `sim/public/brand/fpvtp-mark.svg` | `fill="currentColor"` — inherits the colour of its context, no literal |
| `sim/public/brand/fpvtp-icon.svg` | application icon, `--black` background included |
| `sim/public/brand/fpvtp-mark-extrude.svg` | 3D extrusion, black on transparent |

### Raster exports

`sim/public/brand/png/` carries 16, 32, 48, 128, 256, 512 and 1024 px of two
things: `fpvtp-mark-<size>-transparent.png`, the mark alone, and
`fpvtp-icon-<size>.png`, the mark on its `--black` background.

These exports are **hinted**: at 16 px, each module falls on a whole pixel,
where the SVG's grid (pitch 15.2 over 100 units) would give antialiasing.
That is why they exist rather than letting the browser resample
`fpvtp-icon.svg`. Copy from here, do not re-export.

### Banners

The composed images — the mark, the name and a tagline on the `--black`
background. They live in two places, and the boundary is the browser's:
`docs/brand/` for those nobody serves (repository, social networks, manual
uploads), `sim/public/brand/` for the only one a page has to deliver, the Open
Graph card.

| file | dimensions | destination |
|---|---|---|
| `docs/brand/fpvtp-readme-1280x320.png` | 1280 × 320 | header of `README.md` |
| `docs/brand/fpvtp-github-social-1280x640.png` | 1280 × 640 | repository *social preview* — GitHub → Settings → Social preview, by hand |
| `docs/brand/fpvtp-wide-1500x500.png` | 1500 × 500 | profile banner on a social network, by hand |
| `docs/brand/fpvtp-square-1080.png` | 1080 × 1080 | avatar, square thumbnail, by hand |
| `sim/public/brand/fpvtp-og-1200x630.png` | 1200 × 630 | Open Graph card of a deployed instance, served by the page |

The taglines (`POINT AT A CITY, FLY IT`, `IT'S NOT A LEVEL. IT'S TOKYO.`) are
composed into the image: nothing reads them back, changing them requires a
re-export. Like the rest of the mark, the files arrived with a C2PA manifest —
`caBX` and `deBG` chunks, 5.8 kB per image — removed without re-encoding, same
rule as below.

### Where the mark is used

| path | source |
|---|---|
| header of `README.md` | `docs/brand/fpvtp-readme-1280x320.png` — the banner already carries the mark AND the name, it replaced the bare icon that was there |
| stacked lockup, everywhere (`sim/src/brand-lockup.js`) | the composition — symbol, one module of gap, name in `--font-ui` 500 — is written once and once only. The cracktro and the loading screen both call it; no screen recomposes the mark by hand |
| launch cracktro (`sim/src/intro.js`) | the lockup above, whose symbol it empties in order to draw it module by module during the `reveal` phase. The geometry is copied into `sim/tools/brand-mark-model.mjs` — the game's first screen cannot depend on a fetch — and `sim/tools/brand-mark-selftest.mjs` reads the SVG and the pattern above to forbid that copy from drifting |
| favicon of `sim/index.html` (16, 32, 48) | references `sim/public/brand/png/` directly |
| `og:image` of `sim/index.html` | `sim/public/brand/fpvtp-og-1200x630.png` — path **relative to the root**, and no `og:url`: `deploy/` fixes no domain, and a wrong canonical URL is worth less than no URL at all. The day a domain is settled on, add `og:url` and make the image absolute |
| `sim/electron/build/icon.png` | a copy of `png/fpvtp-icon-1024.png` — electron-builder packages it into the NSIS installer and the AppImage |

### About the files themselves

They arrived with a C2PA provenance manifest of about 9 kB each, hence a
16×16 PNG that weighed 6 kB. It was removed without re-encoding the image: in
the PNGs, every chunk outside `IHDR`/`PLTE`/`IDAT`/`IEND`/`tRNS`; in the SVGs,
the `<metadata>` block and the `xmlns:c2pa` attribute. To be redone if a file is
ever re-exported.

The mark's SVG introduces **no colour**: it takes its parent's, hence
`var(--ink)` everywhere the interface uses it. The palette remains
that of `sim/src/tokens.css`, the sole source — `tools/palette-selftest.mjs`
continues to be the authority.

## Lockups

```text
HORIZONTAL SHORT   [symbol]  FPVTP!            default use
HORIZONTAL LONG    [symbol]  FPVThePlanet!     first mention, headers, repository
STACKED            [symbol]                    splash, boot, square formats
                   F P V T P !
```

Symbol / name gap: 1 module. The name never breaks across two lines.
The name is in `--font-ui` (IBM Plex Mono 500), letter-spaced `--track-ui` in
the stacked lockup, `--track-data` in both horizontal ones.

**Clear space:** 4 modules on all four sides. Nothing enters it, not even
the rule of a panel.

**Minimum sizes:** symbol alone 16 px, short lockup 96 px wide,
long lockup 200 px. Below 16 px the frame closes up visually: use
the reversed version (solid plate, pattern knocked out).

**Forbidden:** no state colour and no demo colour on the mark, including
during a culmination — cyan and magenta belong to the screen, not
to the logo (Bible §19). No rotation, no outline, no shadow, no substituted
pattern.

The cracktro is the first place this prohibition really bites: the mark holds
the screen there while the plasma phase blazes in cyan, magenta, violet and
blue. `.lockup` sets `color: var(--ink)` on the lockup's container,
precisely so that nothing from the demo can bleed down
onto it.

## What the grid produces elsewhere

The interrupted frame **is** the panel: title in the interruption of the top
edge, 1 px rules (`--rule-w`), right angles. The pattern tiled at 8%
ink gives the texture of the calm screens; its 25 bits read in a line give
a separator; the same modules, filled or empty, give the progress bars
of `ACQUIRE AREA` (Bible §8).
