#!/usr/bin/env python3
"""Render trusted local storyboard PNGs with macOS narration; no network calls."""
import argparse
import json
import math
from pathlib import Path
import shutil
import subprocess

FPS = 30


def run(*args):
    return subprocess.check_output([str(a) for a in args], text=True).strip()


def probe(path):
    return json.loads(run('ffprobe', '-v', 'error', '-show_format', '-show_streams',
                          '-of', 'json', path))


def timestamp(seconds):
    ms = round(seconds * 1000)
    hours, ms = divmod(ms, 3600000)
    minutes, ms = divmod(ms, 60000)
    seconds, ms = divmod(ms, 1000)
    return f'{hours:02}:{minutes:02}:{seconds:02},{ms:03}'


def load_story(path):
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise ValueError('story must be an object')
    scenes = data.get('scenes')
    if not isinstance(scenes, list) or not scenes:
        raise ValueError('scenes must be a nonempty list')
    for scene in scenes:
        if not isinstance(scene, dict):
            raise ValueError('each scene must be an object')
        for key in ('image', 'narration', 'source'):
            if not isinstance(scene.get(key), str) or not scene[key].strip():
                raise ValueError(f'each scene needs a nonempty {key}')
        if len(scene['narration']) > 240 or '\n' in scene['narration']:
            raise ValueError('split narration into short, single-line scenes (<=240 characters)')
        image = (path.parent / scene['image']).resolve()
        if image.suffix.lower() != '.png' or not image.is_file():
            raise ValueError(f'missing PNG: {image}')
        scene['image'] = image
    return scenes


def render(story, output, voice, rate):
    scenes = load_story(story)
    for tool in ('say', 'ffmpeg', 'ffprobe'):
        if not shutil.which(tool):
            raise ValueError(f'missing prerequisite: {tool}')
    # Fail rather than overwrite an earlier edit or delivery.
    output.mkdir(parents=True, exist_ok=False)
    offset = 0.0
    cues, transcript, timing = [], [], []
    for i, scene in enumerate(scenes, 1):
        stem = output / f'{i:03}'
        text, audio, clip = stem.with_suffix('.txt'), stem.with_suffix('.aiff'), stem.with_suffix('.mp4')
        text.write_text(scene['narration'])
        run('say', '-v', voice, '-r', rate, '-o', audio, '-f', text)
        info = probe(audio)
        duration = float(info['format']['duration'])
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError(f'invalid narration duration: {audio}')
        # Quantize the scene boundary to a frame; let the final words breathe.
        length = math.ceil((duration + 0.65) * FPS) / FPS
        run('ffmpeg', '-v', 'error', '-nostdin', '-loop', '1', '-framerate', FPS,
            '-i', scene['image'], '-i', audio, '-t', length,
            '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
            '-af', f'volume=-3dB,afade=t=in:d=0.015,afade=t=out:st={max(0, duration-0.03)}:d=0.03,apad',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '21', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-ar', '48000', '-b:a', '128k', '-movflags', '+faststart', clip)
        actual = float(probe(clip)['format']['duration'])
        cues.append(f'{i}\n{timestamp(offset)} --> {timestamp(offset + duration)}\n{scene["narration"]}\n')
        transcript.append(f'{i}. {scene["narration"]}\n   Source: {scene["source"]}\n')
        timing.append({'scene': i, 'start': offset, 'speech': duration, 'duration': actual})
        offset += actual
    (output / 'captions.srt').write_text('\n'.join(cues))
    (output / 'transcript.md').write_text('\n'.join(transcript))
    (output / 'timing.json').write_text(json.dumps(timing, indent=2) + '\n')
    (output / 'concat.txt').write_text(''.join(f"file '{i:03}.mp4'\n" for i in range(1, len(scenes)+1)))
    run('ffmpeg', '-v', 'error', '-nostdin', '-f', 'concat', '-safe', '1', '-i', output / 'concat.txt',
        '-i', output / 'captions.srt', '-map', '0:v:0', '-map', '0:a:0', '-map', '1:0',
        '-c:v', 'copy', '-c:a', 'copy', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng',
        '-movflags', '+faststart', output / 'video.mp4')
    final = probe(output / 'video.mp4')
    kinds = {s['codec_type'] for s in final['streams']}
    if not {'audio', 'video', 'subtitle'} <= kinds:
        raise ValueError('output missing required streams')
    if abs(float(final['format']['duration']) - offset) > 0.3:
        raise ValueError('output timeline differs from scene timeline')
    print(json.dumps({'video': str(output / 'video.mp4'), 'seconds': offset, 'scenes': len(scenes)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('story', type=Path)
    parser.add_argument('output', type=Path, help='new output directory (must not exist)')
    parser.add_argument('--voice', default='Evan (Enhanced)')
    parser.add_argument('--rate', type=int, default=165)
    args = parser.parse_args()
    if not 80 <= args.rate <= 260:
        parser.error('rate must be 80..260 words per minute')
    render(args.story.resolve(), args.output.resolve(), args.voice, args.rate)
