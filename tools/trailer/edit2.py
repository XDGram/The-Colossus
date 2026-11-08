#!/usr/bin/env python3
"""Narrated reveal trailer edit (dev tool): powers-only temple, the storm transition, the valley; narration over a
CC0 cinematic score (ducked under the voice).  usage: python3 tools/trailer/edit2.py <framesDir> <workDir> <out.mp4>"""
import os, subprocess, sys

FR, WK, OUT = sys.argv[1:4]
os.makedirs(WK, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
AUD = f'{ROOT}/public/assets/audio'
FONT = f'{WK}/../edit/fonts/CormorantGaramond.ttf'
FONTI = f'{WK}/../edit/fonts/CormorantGaramond-Italic.ttf'
W, H, BH = 1280, 720, 536

def run(args):
    r = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y'] + args)
    if r.returncode: raise SystemExit(f'ffmpeg failed: {args[-1]}')

GRADE = {
    # Present day: cooler shadows, warm highlights, a touch more contrast, softly vignetted.
    'main': 'eq=contrast=1.09:saturation=0.9:brightness=-0.015,colorbalance=rs=-0.04:bs=0.05:rh=0.05:bh=-0.04,vignette=PI/4.6',
    # Memory: warm, faded, soft — lifted blacks and a gentle bloom.
    'memory': 'eq=contrast=0.86:saturation=0.72:brightness=0.04:gamma=1.06,colorbalance=rs=0.08:gs=0.03:bs=-0.08:rm=0.07:bm=-0.06:rh=0.05:bh=-0.05,'
              'split[a][b];[b]gblur=sigma=6[bb];[a][bb]blend=all_mode=screen:all_opacity=0.35,vignette=PI/3.8',
    # The valley: a little more saturated, cooler air.
    'valley': 'eq=contrast=1.07:saturation=1.0:brightness=-0.01,colorbalance=bs=0.05:bm=0.03:rh=0.03,vignette=PI/4.6',
    # The storm: hot highlights, deep shadows.
    'storm': 'eq=contrast=1.14:saturation=0.98:brightness=-0.03,colorbalance=rs=-0.03:bs=0.04:rh=0.08:gh=0.02:bh=-0.07,vignette=PI/4.2',
}

def text(t, font, size, y, t0, t1, color='0xEDE5D2', fade=0.5):
    t = t.replace("'", "’").replace(':', '\\:')
    a = f"if(lt(t,{t0}),0,if(lt(t,{t0 + fade}),(t-{t0})/{fade},if(lt(t,{t1 - fade}),1,if(lt(t,{t1}),({t1}-t)/{fade},0))))"
    return (f"drawtext=fontfile='{font}':text='{t}':fontsize={size}:fontcolor={color}:x=(w-text_w)/2:y={y}:"
            f"alpha='{a}':shadowcolor=0x000000AA:shadowx=0:shadowy=2")

def clip(name, shot, start, count, grade='main', texts=(), fin=None, fout=None, white_in=0.0, white_out=0.0):
    """One shot: frames [start, start+count) at 30 fps, graded, grained, letterboxed into 1280x720."""
    d = count / 30
    vf = [f'scale={W}:{BH}:flags=lanczos', GRADE[grade], 'noise=alls=7:allf=t', 'format=yuv420p']
    # Fades happen inside the picture; the letterbox bars stay black.
    if fin: vf.append(f'fade=t=in:st=0:d={fin}')
    if fout: vf.append(f'fade=t=out:st={d - fout:.3f}:d={fout}')
    if white_in: vf.append(f'fade=t=in:st=0:d={white_in}:color=white')
    if white_out: vf.append(f'fade=t=out:st={d - white_out:.3f}:d={white_out}:color=white')
    vf.append(f'pad={W}:{H}:0:{(H - BH) // 2}:black')
    vf += [text(*t) for t in texts] + ['setsar=1', 'format=yuv420p']
    run(['-framerate', '30', '-start_number', str(start), '-i', f'{FR}/{shot}/%04d.jpg', '-frames:v', str(count),
         '-vf', ','.join(vf), '-r', '30', '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', f'{WK}/{name}.mp4'])
    return d

def card(name, dur, texts=()):
    vf = [text(*t) for t in texts] + ['setsar=1', 'format=yuv420p']
    run(['-f', 'lavfi', '-i', f'color=c=black:s={W}x{H}:r=30:d={dur}', '-vf', ','.join(vf), '-c:v', 'libx264', '-crf', '17', f'{WK}/{name}.mp4'])
    return dur


VO = f'{WK}/../edit/vo'
MUS = f'{WK}/../edit/music'
seq, t = [], 0.0
def add(name, d):
    global t
    seq.append(name); t0 = t; t += d; return t0

T = {}
T['black0'] = add('d00', card('d00', 1.0))
T['temple'] = add('d01', clip('d01', 'temple', 0, 120, fin=1.2))
T['gate'] = add('d02', clip('d02', 'gate', 0, 72))
T['student'] = add('d03', clip('d03', 'riftcu', 0, 56))
T['wface'] = add('d04', clip('d04', 'wface', 0, 75))
T['strike'] = add('d05', clip('d05', 'strike', 0, 50))
T['army'] = add('d06', clip('d06', 'army', 0, 90))
T['release'] = add('d07', clip('d07', 'riftcu', 56, 20))
T['phantom'] = add('d08', clip('d08', 'phantom', 0, 50))
T['rift'] = add('d09', clip('d09', 'rift', 30, 42))
T['rupture'] = add('d10', clip('d10', 'rupture', 0, 80))
T['turn'] = add('d11', clip('d11', 'turn2', 0, 100, white_out=0.3))
T['valley'] = add('d12', clip('d12', 'valley', 0, 78, 'valley', white_in=0.9))
T['vface'] = add('d13', clip('d13', 'vface', 0, 66, 'storm'))
T['inferno'] = add('d14', clip('d14', 'inferno', 0, 84, 'storm'))
T['wrath'] = add('d15', clip('d15', 'wrath', 0, 66, 'storm'))
T['meteor'] = add('d16', clip('d16', 'meteor', 0, 90, 'storm'))
T['thunder'] = add('d17', clip('d17', 'thunder', 0, 54, 'storm'))
T['tempest'] = add('d18', clip('d18', 'tempest', 0, 54, 'storm'))
T['black'] = add('d19', card('d19', 3.4))
T['title'] = add('d20', card('d20', 5.6, [
    ("THE LAST COLOSSUS", FONT, 66, '(h-text_h)/2-24', 0.3, 5.6, '0xEFE7D4', 1.0),
    ("The First Awakening", FONTI, 30, '(h)/2+34', 1.1, 5.6, '0xC9A35B', 0.9),
    ("Play now", FONT, 22, 'h-120', 2.4, 5.6, '0xBDB3A0', 0.7),
]))
TOTAL = t
with open(f'{WK}/list.txt', 'w') as f:
    for n in seq: f.write(f"file '{WK}/{n}.mp4'\n")
run(['-f', 'concat', '-safe', '0', '-i', f'{WK}/list.txt', '-vf', 'settb=1/30,setpts=N/30/TB,fps=30', '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p', f'{WK}/picture.mp4'])

# ---------------------------------------------------------------- sound
narr = [('n1', T['temple'] + 0.3), ('n2', T['wface'] + 0.3), ('n3', T['release'] + 0.2), ('n4', T['turn'] + 0.4),
        ('n5', T['vface'] + 0.5), ('n6', T['black'] + 0.5)]
flash = T['valley']
music = [  # (file, source start, length, place at, fade in, fade out, gain)
    (f'{MUS}/adventure.wav', 0.0, flash + 1.6 - 0.2, 0.2, 2.0, 1.6, 1.0),     # builds to its peak at the flash
    (f'{MUS}/legend.mp3', 38.0, T['black'] - flash + 0.5, flash - 0.5, 0.6, 0.06, 0.95),  # the valley; stops dead at the cut
    (f'{MUS}/legend.mp3', 62.5, TOTAL - T['black'] - 0.6, T['black'] + 0.6, 1.2, 1.5, 0.8),  # its closing chords under the title
]
sfx = [
    (f'{AUD}/wind.mp3', 0.0, 0.25), (f'{WK}/../edit/bell.wav', 1.4, 0.45), (f'{AUD}/debris.mp3', T['gate'] + 0.6, 0.5),
    (f'{AUD}/riftCharge.mp3', T['student'], 0.5), (f'{AUD}/thunder.mp3', T['strike'] + 0.25, 1.0), (f'{AUD}/appear.mp3', T['strike'] + 0.9, 0.6),
    (f'{AUD}/riftRelease.mp3', T['release'] + 0.1, 0.9), (f'{AUD}/spiritDash.mp3', T['phantom'] + 0.2, 0.9),
    (f'{AUD}/riftRelease.mp3', T['rift'] + 0.2, 1.0), (f'{AUD}/ruptureCharge.mp3', T['rupture'], 0.6), (f'{AUD}/ruptureBoom.mp3', T['rupture'] + 0.35, 1.0),
    (f'{AUD}/debris.mp3', T['rupture'] + 1.6, 0.6),
    (f'{AUD}/wind.mp3', T['turn'], 1.2), (f'{AUD}/riser.mp3', T['turn'] + 0.4, 0.9), (f'{AUD}/thunder.mp3', flash, 1.0), (f'{AUD}/whoosh.mp3', flash, 0.8),
    (f'{AUD}/stormCall.mp3', T['vface'] + 0.2, 0.7),
    (f'{AUD}/fireWave.mp3', T['inferno'] + 1.4, 1.0), (f'{AUD}/thunder.mp3', T['wrath'] + 0.5, 0.8), (f'{AUD}/thunder.mp3', T['wrath'] + 1.4, 0.8),
    (f'{AUD}/fireCharge.mp3', T['meteor'] + 0.1, 0.7), (f'{AUD}/ruptureBoom.mp3', T['meteor'] + 2.2, 1.0), (f'{AUD}/fireWave.mp3', T['meteor'] + 2.25, 0.8),
    (f'{AUD}/vanish.mp3', T['thunder'] + 0.1, 0.7), (f'{AUD}/thunder.mp3', T['thunder'] + 0.4, 0.9),
    (f'{AUD}/whoosh.mp3', T['tempest'] + 0.4, 0.9), (f'{AUD}/riftRelease.mp3', T['tempest'] + 1.3, 1.0),
    (f'{WK}/../edit/rumble.wav', T['black'] + 0.05, 1.0), (f'{WK}/../edit/bell.wav', T['title'] + 0.4, 0.3),
]
# Each line starts at its moment, or 0.4 s after the previous one ends (never overlapping).
dur = lambda f: float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], capture_output=True, text=True).stdout)
placed, end = [], 0.0
for fn, at in narr:
    at = max(at, end + 0.4); placed.append((fn, at)); end = at + dur(f'{VO}/{fn}.mp3')
    print(f'narration {fn} {at:6.2f} - {end:6.2f}')
narr = placed
ins, parts = [], []
for i, (fn, s, d, at, fi, fo, gn) in enumerate(music):
    ins += ['-ss', f'{s}', '-t', f'{d:.3f}', '-i', fn]
    parts.append(f"[{i}]aresample=48000,aformat=channel_layouts=stereo,afade=t=in:st=0:d={fi},afade=t=out:st={max(0, d - fo):.3f}:d={fo},volume={gn},adelay={int(at * 1000)}|{int(at * 1000)}[m{i}]")
k = len(music)
for j, (fn, at) in enumerate(narr):
    ins += ['-i', f'{VO}/{fn}.mp3']
    # A little warmth and space on the voice.
    parts.append(f"[{k + j}]aresample=48000,aformat=channel_layouts=stereo,highpass=f=70,aecho=0.8:0.5:60|110:0.12|0.07,volume=1.7,adelay={int(at * 1000)}|{int(at * 1000)}[v{j}]")
kv = k + len(narr)
for j, (fn, at, gn) in enumerate(sfx):
    ins += ['-i', fn]
    parts.append(f"[{kv + j}]aresample=48000,aformat=channel_layouts=stereo,volume={gn},adelay={int(at * 1000)}|{int(at * 1000)}[s{j}]")
nm, nv, ns = k, len(narr), len(sfx)
parts.append(''.join(f'[m{i}]' for i in range(nm)) + f'amix=inputs={nm}:normalize=0[mus]')
parts.append(''.join(f'[v{i}]' for i in range(nv)) + f'amix=inputs={nv}:normalize=0,asplit=2[vo][key]')
# The score ducks under the narration.
parts.append('[mus][key]sidechaincompress=threshold=0.012:ratio=9:attack=30:release=600:makeup=1[duck]')
parts.append(''.join(f'[s{i}]' for i in range(ns)) + f'amix=inputs={ns}:normalize=0,volume=0.8[fx]')
parts.append(f'[duck][vo][fx]amix=inputs=3:normalize=0,alimiter=limit=0.9,atrim=0:{TOTAL:.3f}[a]')
run(ins + ['-filter_complex', ';'.join(parts), '-map', '[a]', '-ac', '2', '-ar', '48000', f'{WK}/sound.wav'])
run(['-i', f'{WK}/picture.mp4', '-i', f'{WK}/sound.wav', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', OUT])
print(f'done {OUT} {TOTAL:.1f}s')
for k2, v in T.items(): print(f'{k2:>8} {v:6.2f}')
