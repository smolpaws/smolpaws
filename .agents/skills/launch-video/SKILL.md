---
name: launch-video
description: >
  Make a short, snappy launch/demo video of a web UI — the kind of 15–30s
  product clip you post when shipping something (cursor glides across the app,
  panels animate, a title card, a gentle zoom, optional music). Use when the
  user says "make a launch video", "record a demo", "make a clip of this",
  "a short video like <X>", or wants a gif/mp4 to show off a UI.
triggers:
- /launch-video
- /demo-video
license: MIT
metadata:
  tags: video, demo, launch, screen-recording, ffmpeg, playwright, marketing
---

# launch-video — scripted launch clips for a web UI

A good launch clip is **scripted screen-recording**, not AI-generated footage:
a browser is driven through a storyboard with smooth, eased motion, captured to
video, then cut to a beat with a title card, a gentle zoom, and optional music.
This skill does exactly that, using only local tools.

Output: a web-friendly **`.mp4`** and a looping **`.gif`**, ~15–30s.

## The pipeline (three steps)

1. **Capture** — `scripts/capture.mjs` (Playwright) opens the URL, injects a
   visible cursor, and runs a **storyboard**: eased cursor moves, hovers,
   clicks (with a ripple), and scrolls. It records the page to a `.webm`.
2. **Polish** — `scripts/polish.sh` (ffmpeg + a Chrome-rendered title card)
   adds a title card, a slow zoom, fade in/out, optional music, and exports
   `mp4` + `gif`.
3. **Place & commit** — drop the clip where it belongs (usually the project's
   repo, referenced from its README) and commit.

## Prerequisites (all local)

- **Playwright** with the full chromium build (video recording needs the full
  browser, not the headless_shell): `npx playwright install chromium`.
  The scripts resolve the globally-installed playwright via `npm root -g`.
- **ffmpeg** + **ffprobe** (Homebrew is fine). Note: Homebrew ffmpeg usually
  has **no `drawtext`** filter, so the title card is rendered as HTML via
  headless Chrome — no font-filter dependency.
- The **target UI must be running and reachable** at a URL (localhost or a
  tailnet host). Bring it up first.

## How to make one

### 1. Write a storyboard

A storyboard is an ESM module exporting `default async (s) => { … }`. `s` is a
small helper API:

| Call | Does |
|---|---|
| `s.sleep(ms)` | pause (let things settle / breathe) |
| `s.moveTo(x, y, dur)` | eased cursor move to a point |
| `s.moveToSel(sel, dur)` | eased move to the center of a CSS selector |
| `s.hoverSel(sel, dur)` | same, for hovers |
| `s.click()` | ripple + click whatever is under the cursor |
| `s.scrollBy(dy, dur)` | eased scroll |
| `s.evaluate(fn, …args)` | run arbitrary JS in the page |

Keep beats **slow and deliberate** — ~600–900ms moves, ~700ms pauses. A viewer
needs a moment on each thing. Aim for a total of 15–25s. See
`scripts/storyboard.purr-projects.mjs` for a worked example.

**Storyboard craft:**
- Open on the hero view; let it settle (~1s) before moving.
- Move to *one* thing, pause, move to the next. Don't dart around.
- Hover the emotional beat (the logo, the headline feature) a little longer.
- End at rest, not mid-motion — the fade-out needs a calm frame.
- Selectors must exist in the live DOM; check them first (`document.querySelector`).

### 2. Capture

```bash
cd .agents/skills/launch-video/scripts
node capture.mjs \
  --url http://127.0.0.1:PORT/ \
  --out /tmp/lv-cap \
  --width 1280 --height 800 \
  --storyboard storyboard.YOURTHING.mjs
# prints the path to the recorded .webm
```

Tips:
- `--width/--height` set the frame (1280×800 is a good 16:10; 1280×720 for 16:9).
- If the page **polls/refreshes**, `networkidle` never fires — the script waits
  for a `.card`/`main` selector instead. If your UI has neither, tweak the
  `waitForSelector` in `capture.mjs`.

### 3. Polish

```bash
bash polish.sh <input.webm> <out-basename> "<Title>" "<Subtitle>" [music.mp3]
# e.g.
bash polish.sh /tmp/lv-cap/*.webm /tmp/myclip "My App" "ship it" 
# writes /tmp/myclip.mp4 and /tmp/myclip.gif
```

- **Title card**: rendered from HTML (dark slate + accent glow) → PNG → 1.8s
  intro with a fade-in. Edit the inline HTML in `polish.sh` to reskin it.
- **Music** is optional and the **last arg**. Only use a track the user is
  cleared to use (royalty-free or their own). Default is silent.

### 4. Verify before you ship

- Check duration is what you expect (`ffprobe -show_entries format=duration`).
- Pull a few frames to eyeball it:
  `ffmpeg -ss 4 -i out.mp4 -frames:v 1 /tmp/f.png` then view it.
- The `.gif` is 600px/12fps to stay README-friendly; the `.mp4` is full-res.

## Palette (smolpaws default)

The title card uses smolpaws colors — deep slate `#0e1116`, glowing blue accent
`#4ea1ff`, silver text. **No purple.** Change the hexes in `polish.sh`'s title
HTML for a different product.

## Gotchas learned

- **No `drawtext`** in Homebrew ffmpeg → title card is HTML/Chrome, not a font
  filter. (Don't reach for `drawtext`; it won't be there.)
- **`zoompan` collapses clips** — it resamples to `d` frames and can shrink a
  17s clip to ~9s. Use a **time-driven `scale`+`crop`** for the zoom instead
  (as `polish.sh` does), which preserves every frame.
- **Full chromium, not headless_shell** — Playwright video recording fails on
  the shell-only build. Install the full one.
- **Deterministic > live** — script the motion; never hand-wave a recording.
  A storyboard re-renders identically every time, so you can iterate.
