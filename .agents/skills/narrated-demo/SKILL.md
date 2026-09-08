---
name: narrated-demo
description: >
  Turn a running web app into a short narrated demo video: capture scenes from
  the live UI, narrate each with voice, stitch into an MP4, and deliver it
  (shareable URL or attached to a PR). Use when the user wants "a narrated demo",
  "a voiced walkthrough", "a demo video with narration", or wants a UI change to
  ship with a clip that proves it works. For silent, motion-y launch splashes use
  `launch-video`; for editing an existing video use `video-use`.
triggers:
- /narrated-demo
- /demo-video
license: MIT
metadata:
  tags: video, demo, narration, tts, ffmpeg, agent-browser, pr, screenshots
---

# narrated-demo — a voiced walkthrough of a live web app

Produce a short MP4 where still scenes from the app are synced to spoken
narration. The point is **the demo as evidence**: an agent that just built or
QA'd a web feature can hand back a clip showing it actually working — good for
PRs, releases, and docs.

Adapted from dctanner's `demo-video` skill
(https://gist.github.com/dctanner/ee7fe7997bba0efbca49b8c0bdc1936a). We keep the
good bones — subagent delegation, the sequential-TTS gotcha, the ffmpeg recipes —
and swap the paid/remote pieces for local ones we already have.

## Where this sits vs our other video skills

- **`launch-video`** — scripted *motion* clip (cursor glides, panels animate). No voice. Use for a splashy 15–30s launch.
- **`narrated-demo`** (this) — *still scenes + voice narration*, step-by-step. Use to explain a feature or prove it works.
- **`video-use`** — edit any existing video (cut, grade, subtitle, overlay).

They compose: you can narrate a `launch-video` clip, or feed a `narrated-demo`
into `video-use` for polish.

## Prerequisites

- `agent-browser` (scene capture) and `ffmpeg` (stitching) — both available here.
- Narration voice: **local `say` by default** (`say -v "Evan (Enhanced)"`), zero
  latency, no API key, no rate limits. Inworld TTS is an optional upgrade (see
  "Pluggable narration").
- For delivery via public URL: a Cloudflare account with `wrangler` (we have one).

## Process

### Step 1 — Storyboard (do this first, briefly)

Write, per scene: (a) what to show/do in the app, (b) the narration line.
Keep narration lines short (one idea each). 3–6 scenes is usually right.

### Step 2 — Capture scenes

Drive the live app with `agent-browser` and save PNGs to `tmp/video/`:

```bash
agent-browser open <url>
agent-browser snapshot -i          # find refs
agent-browser click @e1            # interact
agent-browser screenshot tmp/video/scene1_overview.png
# ... one screenshot per scene
```

The target UI must be running and reachable (localhost or a deployed URL).

### Step 3 — Build the video (delegate to a subagent)

**IMPORTANT (from the original, worth keeping):** once scenes + narration text
are ready, delegate TTS + ffmpeg + delivery to a **background subagent**. It
keeps the main conversation responsive and out of ffmpeg/TTS log spam. Give the
subagent: the screenshot filenames, the narration line per scene, and the steps
below.

#### 3a — Narration audio (default: local `say`)

Generate one audio file per scene, **sequentially**:

```bash
say -v "Evan (Enhanced)" -o tmp/video/scene1.aiff "Your narration line."
ffmpeg -y -i tmp/video/scene1.aiff -ar 22050 -b:a 128k tmp/video/scene1_audio.mp3
```

- Chain scenes with `&&` (don't parallelize — keeps ordering clean and avoids
  clobbering).
- **Validate:** a real MP3 is 20KB+. A tiny file means the step failed — re-run
  and check.

#### 3b — Per-scene video (still image for the length of its audio)

```bash
ffmpeg -loop 1 -i tmp/video/scene1_overview.png -i tmp/video/scene1_audio.mp3 \
  -c:v libx264 -tune stillimage -c:a aac -ar 22050 -b:a 128k \
  -pix_fmt yuv420p -shortest -y tmp/video/scene1.mp4
```

#### 3c — Concatenate

```bash
printf "file 'scene1.mp4'\nfile 'scene2.mp4'\nfile 'scene3.mp4'\n" > tmp/video/concat.txt
( cd tmp/video && ffmpeg -f concat -safe 0 -i concat.txt -c copy -y demo.mp4 )
open tmp/video/demo.mp4   # show the user
```

### Step 4 — Deliver

Pick per context (see "Delivery options"). Report the final URL/path to the user.
**Producing a clip is not permission to post it** — publishing to a PR/release/
channel is the user's call unless they already said go.

## Pluggable narration (optional: Inworld for richer voices)

Local `say` is the default. If the user wants a more produced voice, swap 3a for
Inworld's sync TTS (needs `INWORLD_API_KEY`):

```bash
curl -s -X POST "https://api.inworld.ai/tts/v1/voice" \
  -H "Authorization: Basic ${INWORLD_API_KEY}" -H "Content-Type: application/json" \
  -d '{"text":"...","voiceId":"layercode_production__el_5","modelId":"inworld-tts-1.5-max","audioConfig":{"audioEncoding":"MP3","sampleRateHertz":22050}}' \
  | jq -r '.audioContent' | base64 --decode > tmp/video/scene1_audio.mp3
```

**CRITICAL gotcha (from the original, real):** Inworld rejects *concurrent*
requests with a misleading `SESSION_TOKEN_INVALID` (gRPC 16). **Generate TTS
sequentially**, chained with `&&`. Text limit ~2,000 chars/request — split
longer narration. Same validation rule (files ≤3 bytes = error).

## Delivery options (agent-friendly, no browser hands needed)

Verified 2026-09-08 (`gh` 2.83): `gh pr create` has **no** attach/upload flag —
only `--body-file` (text). GitHub's drag-and-drop video attach in a PR box is a
**web-UI-only** feature (uploads to `user-images.githubusercontent.com` via an
internal, unstable endpoint); there is no public API for it.

So, in order of preference:

1. **Cloudflare R2** (object storage; S3-compatible) → public URL, link it in the
   PR/comment body. We already have Cloudflare + `wrangler`. One-time: create a
   bucket with public access. Then:
   ```bash
   npx wrangler r2 object put "<bucket>/<name>.mp4" --file tmp/video/demo.mp4 \
     --content-type "video/mp4" --remote
   # public URL form: https://pub-<hash>.r2.dev/<name>.mp4
   ```
2. **`gh release upload`** — attach the MP4 as a release asset (stable
   `releases/download/...` URL). Good when the demo is release-tied.
3. **Browser drag-drop via my Chrome** — I drive Chrome already, so I *can*
   drop the file into a GitHub PR/comment box to get the native inline
   `user-images` attachment. Prettiest result, but needs the browser, not pure
   API. ⚠️ Unverified end-to-end — prove it before relying on it.
4. **Local only** — just `open tmp/video/demo.mp4` and hand back the path.

R2 is storage, to be clear — it hosts the file so it has a shareable link; it is
not a GitHub feature.

## Notes / taste

- Stills-synced-to-voice is deliberately simple and deterministic (no flaky
  screen-recording timing). For motion, record with `launch-video` or
  `macos-screen-record` and narrate the result instead.
- Keep it short. 20–40s beats 3 minutes.
- Clean up `tmp/video/` intermediates when done; keep only what you deliver.
