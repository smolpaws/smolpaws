#!/bin/bash
# polish.sh — turn a raw capture (.webm) into a launch clip (.mp4 + .gif).
#
# Adds a short title card, a gentle fade in/out, optional music, and exports
# a web-friendly mp4 and a looping gif. ffmpeg only.
#
# Usage:
#   polish.sh <input.webm> <out-basename> "<Title>" "<subtitle>" [music.mp3]
#
# Example:
#   polish.sh /tmp/cap/xyz.webm /tmp/purr "Purr Projects" "smolpaws' agents, by project"

set -u
IN="$1"
OUT="$2"                      # basename, no extension
TITLE="${3:-}"
SUBTITLE="${4:-}"
MUSIC="${5:-}"

TITLE_SECS=1.8               # length of the title card
W=$(ffprobe -v error -select_streams v:0 -show_entries stream=width  -of csv=p=0 "$IN")
H=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$IN")
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$IN")

TMP="$(mktemp -d)"

# 1) Title card. Homebrew ffmpeg often lacks the drawtext (freetype) filter,
#    so render the card as HTML via headless Chrome → PNG, then make a short
#    clip from it. Nicer typography anyway, and matches the smolpaws palette.
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
cat > "$TMP/title.html" <<HTML
<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;width:${W}px;height:${H}px;background:
    radial-gradient(900px 420px at 78% -12%, rgba(78,161,255,.16), transparent 70%), #0e1116;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    font-family:-apple-system,system-ui,sans-serif;color:#e8ecf1}
  .paw{width:${H}px;height:auto;max-width:96px;filter:drop-shadow(0 0 16px rgba(78,161,255,.6));margin-bottom:22px}
  h1{font-size:${H}px;font-size:min(${H}px,64px);margin:0;font-weight:800;letter-spacing:-.02em}
  p{margin:14px 0 0;color:#8a95a3;font-size:24px}
</style>
<svg class="paw" viewBox="0 0 24 24" fill="#4ea1ff"><circle cx="6" cy="10" r="2"/><circle cx="10.5" cy="6.5" r="2"/><circle cx="15.5" cy="6.5" r="2"/><circle cx="18" cy="10" r="2"/><path d="M12 12c-3 0-5 2.2-5 4.6 0 1.7 1.3 2.9 3 2.9.9 0 1.4-.4 2-.4s1.1.4 2 .4c1.7 0 3-1.2 3-2.9C17 14.2 15 12 12 12z"/></svg>
<h1>${TITLE}</h1><p>${SUBTITLE}</p>
HTML
"$CHROME" --headless --disable-gpu --hide-scrollbars --window-size=${W},${H} \
  --screenshot="$TMP/title.png" "file://$TMP/title.html" 2>/dev/null
# Short clip from the still, with a gentle fade-in.
ffmpeg -y -loop 1 -t "$TITLE_SECS" -i "$TMP/title.png" \
  -vf "scale=${W}:${H},fade=t=in:st=0:d=0.5,fps=60,format=yuv420p" \
  "$TMP/title.mp4" 2>/dev/null

# 2) Main body: gentle slow zoom + fade in/out. A time-driven scale+crop keeps
#    every frame (unlike zoompan, which resamples to d frames and can collapse
#    the clip). Zoom eases from 1.00 to ~1.04 over the whole body.
FADE_OUT=$(awk "BEGIN{printf \"%.2f\", $DUR-0.6}")
ffmpeg -y -i "$IN" \
  -vf "fps=60,scale=w='iw*(1+0.04*t/${DUR})':h=-1:eval=frame,crop=${W}:${H},\
fade=t=in:st=0:d=0.4,fade=t=out:st=${FADE_OUT}:d=0.6,format=yuv420p" \
  "$TMP/body.mp4" 2>/dev/null

# 3) Concatenate title + body.
printf "file '%s'\nfile '%s'\n" "$TMP/title.mp4" "$TMP/body.mp4" > "$TMP/list.txt"
ffmpeg -y -f concat -safe 0 -i "$TMP/list.txt" -c:v libx264 -crf 20 -preset veryfast \
  -pix_fmt yuv420p -movflags +faststart "$TMP/silent.mp4" 2>/dev/null

# 4) Music (optional): loop/trim to length, fade out.
if [ -n "$MUSIC" ] && [ -f "$MUSIC" ]; then
  TOTAL=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$TMP/silent.mp4")
  AFO=$(awk "BEGIN{printf \"%.2f\", $TOTAL-1.0}")
  ffmpeg -y -stream_loop -1 -i "$MUSIC" -i "$TMP/silent.mp4" \
    -filter_complex "[0:a]atrim=0:${TOTAL},afade=t=out:st=${AFO}:d=1.0,volume=0.6[a]" \
    -map 1:v -map "[a]" -c:v copy -c:a aac -shortest -movflags +faststart "${OUT}.mp4" 2>/dev/null
else
  cp "$TMP/silent.mp4" "${OUT}.mp4"
fi

# 5) Looping gif (per-clip palette for quality), 600px wide / 12fps to keep
#    the file reasonable for embedding in a README.
ffmpeg -y -i "${OUT}.mp4" -vf "fps=12,scale=600:-1:flags=lanczos,palettegen=max_colors=128" "$TMP/pal.png" 2>/dev/null
ffmpeg -y -i "${OUT}.mp4" -i "$TMP/pal.png" -lavfi "fps=12,scale=600:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer" "${OUT}.gif" 2>/dev/null

rm -rf "$TMP"
echo "wrote ${OUT}.mp4 and ${OUT}.gif"
ls -la "${OUT}.mp4" "${OUT}.gif" 2>/dev/null
