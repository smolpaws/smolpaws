<!-- SOURCE: dctanner's demo-video skill
     URL: https://gist.github.com/dctanner/ee7fe7997bba0efbca49b8c0bdc1936a
     Saved: 2026-09-08 as reference for our narrated-demo skill.
     License unstated on the gist; treat as inspiration, our SKILL.md is MIT. -->

---
name: demo-video
description: Generate a narrated demo video from browser screenshots and TTS audio. Captures scenes via agent-browser, generates voice narration via Inworld TTS API, and stitches into an MP4 with ffmpeg.
---

# Demo Video Generation

Generate a narrated demo video from browser screenshots and TTS audio. The output is an MP4 with still-image scenes synced to voice narration.

## Prerequisites

- `agent-browser` installed
- `ffmpeg` installed
- Inworld API key in `api/.dev.vars` (`INWORLD_API_KEY`)

## Process

### Step 1: Take Screenshots

Use `agent-browser` to navigate the app and capture screenshots. Save all files to `tmp/video/` in the project root.

Example:
```
scene1_overview.png — Navigate to main page, full page screenshot
scene2_feature.png — Interact with a feature, capture result
scene3_detail.png — Click into detail view, capture
```

### Step 2: Build the Video (use a subagent)

**IMPORTANT:** Once all screenshots are captured and narration text is written, delegate the TTS generation, ffmpeg stitching, and R2 upload to a **background subagent** using the Task tool. This keeps the main conversation responsive and avoids filling the context window with ffmpeg output.

The subagent prompt should include:
- The list of screenshot filenames in `tmp/video/`
- The narration text for each scene
- Instructions to generate TTS audio, create video segments, concatenate, upload to R2, and `open` the final video

Below are the details the subagent needs:

#### TTS Audio Generation

Call the Inworld TTS sync API to generate MP3 audio files for each scene.

**API endpoint:** `POST https://api.inworld.ai/tts/v1/voice` (non-streaming, returns complete audio in one response)

**Request:**
```bash
INWORLD_API_KEY=$(grep '^INWORLD_API_KEY=' api/.dev.vars | cut -d'=' -f2-)
curl -s -X POST "https://api.inworld.ai/tts/v1/voice" \
  -H "Authorization: Basic ${INWORLD_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Your narration text here.",
    "voiceId": "layercode_production__el_5",
    "modelId": "inworld-tts-1.5-max",
    "audioConfig": {
      "audioEncoding": "MP3",
      "sampleRateHertz": 22050
    }
  }' | jq -r '.audioContent' | base64 --decode > tmp/video/scene1_audio.mp3
```

**CRITICAL — Inworld rate limit:** The Inworld API rejects concurrent requests with a misleading `SESSION_TOKEN_INVALID` error (gRPC code 16). **Generate TTS files sequentially, not in parallel.** Chain them with `&&` in a single bash command.

**Text limit:** 2,000 characters per request. Split longer narration across multiple calls.

**Validation:** Always check file sizes after generation. Valid MP3 files are 50KB+. Files of 3 bytes or less indicate the API returned an error — check the raw response with `curl ... | head -c 500`.

#### ffmpeg Video Segments

For each scene, create a video that displays the screenshot for the duration of its audio:

```bash
ffmpeg -loop 1 -i scene1_overview.png -i scene1_audio.mp3 \
  -c:v libx264 -tune stillimage -c:a aac -ar 22050 -b:a 128k \
  -pix_fmt yuv420p -shortest -y scene1.mp4
```

#### Concatenate into Final Video

```bash
printf "file 'scene1.mp4'\nfile 'scene2.mp4'\nfile 'scene3.mp4'\n" > concat.txt
ffmpeg -f concat -safe 0 -i concat.txt -c copy -y demo.mp4
```

Final output: `tmp/video/demo.mp4`

Run `open tmp/video/demo.mp4` to show the final video to the user.

#### Upload Video to R2

Upload the final video to the `toyo-dev-demo-videos` R2 bucket using wrangler. The bucket has public access enabled so videos can be shared via URL.

```bash
# Use the current git branch name as the filename
FILENAME="$(git branch --show-current).mp4"

# Upload to R2 (must run from api/ directory)
cd api && npx wrangler r2 object put "toyo-dev-demo-videos/${FILENAME}" \
  --file ../tmp/video/demo.mp4 \
  --content-type "video/mp4" \
  --remote
```

**Other R2 commands:**
```bash
cd api && npx wrangler r2 object list toyo-dev-demo-videos --remote    # List videos
cd api && npx wrangler r2 object delete "toyo-dev-demo-videos/${FILENAME}" --remote  # Delete
```

**Public URL format:** `https://pub-<hash>.r2.dev/<filename>` (if public access is configured on the bucket).
