#!/usr/bin/env python3
"""Reveal trailer edit (dev tool): grades and cuts the captured shots, adds text cards, music and sound, and renders
a 1280x720 letterboxed (2.39:1) H.264 video.  usage: python3 tools/trailer/edit.py <framesDir> <workDir> <out.mp4>"""
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
    vf = [f'scale={W}:{BH}:flags=lanczos', GRADE[grade], 'noise=alls=7:allf=t', f'pad={W}:{H}:0:{(H - BH) // 2}:black', 'format=yuv420p']
    if fin: vf.append(f'fade=t=in:st=0:d={fin}')
    if fout: vf.append(f'fade=t=out:st={d - fout:.3f}:d={fout}')
    if white_in: vf.append(f'fade=t=in:st=0:d={white_in}:color=white')
    if white_out: vf.append(f'fade=t=out:st={d - white_out:.3f}:d={white_out}:color=white')
    vf += [text(*t) for t in texts] + ['setsar=1', 'format=yuv420p']
    run(['-framerate', '30', '-start_number', str(start), '-i', f'{FR}/{shot}/%04d.jpg', '-frames:v', str(count),
         '-vf', ','.join(vf), '-r', '30', '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', f'{WK}/{name}.mp4'])
    return d

def card(name, dur, texts=()):
    vf = [text(*t) for t in texts] + ['setsar=1', 'format=yuv420p']
    run(['-f', 'lavfi', '-i', f'color=c=black:s={W}x{H}:r=30:d={dur}', '-vf', ','.join(vf), '-c:v', 'libx264', '-crf', '17', f'{WK}/{name}.mp4'])
    return dur

SUB_Y = H - (H - BH) // 2 - 62      # subtitles sit inside the picture, near its bottom edge
seq, t = [], 0.0
def add(name, d):
    global t
    seq.append(name); t0 = t; t += d; return t0

# ---------------------------------------------------------------- picture
T = {}
T['open'] = add('c01', card('c01', 3.0, [("He raised me within these walls.", FONTI, 40, '(h-text_h)/2', 0.6, 2.9)]))
T['memory'] = add('c02', clip('c02', 'memory', 0, 96, 'memory', [("He taught me everything.", FONTI, 36, SUB_Y, 0.5, 2.7)], fin=0.6, white_out=0.7))
T['gate'] = add('c03', clip('c03', 'gate', 0, 72, white_in=0.5))
T['warden'] = add('c04', clip('c04', 'warden', 0, 54, texts=[("“You should not have returned.”", FONTI, 34, SUB_Y, 0.2, 1.8)]))
T['strike'] = add('c05', clip('c05', 'strike', 0, 50))
T['combo'] = add('c06', clip('c06', 'combo', 0, 96))
T['parry'] = add('c07', clip('c07', 'parry', 0, 70))
T['giant'] = add('c08', clip('c08', 'giant', 0, 76))
T['phantom'] = add('c09', clip('c09', 'phantom', 0, 50))
T['rift'] = add('c10', clip('c10', 'rift', 0, 72))
T['rupture'] = add('c11', clip('c11', 'rupture', 0, 80))
T['duel'] = add('c12', clip('c12', 'duel', 0, 90))
T['turn'] = add('c13', clip('c13', 'turn', 0, 66, texts=[("“Let me show you where this ends.”", FONTI, 34, SUB_Y, 0.2, 1.9)], white_out=0.25))
T['valley'] = add('c14', clip('c14', 'valley', 0, 78, 'valley', white_in=0.6))
T['inferno'] = add('c15', clip('c15', 'inferno', 0, 84, 'storm'))
T['meteor'] = add('c16', clip('c16', 'meteor', 0, 90, 'storm'))
T['wrath'] = add('c17', clip('c17', 'wrath', 0, 66, 'storm'))
T['thunder'] = add('c18', clip('c18', 'thunder', 0, 54, 'storm'))
T['tempest'] = add('c19', clip('c19', 'tempest', 0, 54, 'storm'))
T['black'] = add('c20', card('c20', 1.3))
T['title'] = add('c21', card('c21', 5.4, [
    ("THE LAST COLOSSUS", FONT, 66, '(h-text_h)/2-24', 0.3, 5.4, '0xEFE7D4', 1.0),
    ("The First Awakening", FONTI, 30, '(h)/2+34', 1.1, 5.4, '0xC9A35B', 0.9),
    ("Play now", FONT, 22, 'h-120', 2.4, 5.4, '0xBDB3A0', 0.7),
]))
TOTAL = t
with open(f'{WK}/list.txt', 'w') as f:
    for n in seq: f.write(f"file '{WK}/{n}.mp4'\n")
# Re-encoded (the cards and the shots have different timebases, so a stream copy would scramble the timing).
run(['-f', 'concat', '-safe', '0', '-i', f'{WK}/list.txt', '-vf', 'settb=1/30,setpts=N/30/TB,fps=30', '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p', f'{WK}/picture.mp4'])

# ---------------------------------------------------------------- sound
fight0, storm0 = T['combo'], T['inferno']
music = [
    # (source start, length, place at, fade in, fade out)
    (0.0, T['combo'] + 0.6, 0.0, 1.5, 0.8),                        # the quiet opening of the temple theme
    (138.0, T['turn'] + 1.0 - fight0, fight0 - 0.3, 0.6, 1.2),      # the build under the fight, dying away at the turn
    (161.8, T['black'] - storm0, storm0, 0.02, 0.05),               # its strongest part for the storm; stops dead
]
sfx = [  # (file, at, gain)
    (f'{WK}/../edit/bell.wav', 0.4, 0.55), (f'{AUD}/wind.mp3', 0.0, 0.25),
    (f'{AUD}/debris.mp3', T['gate'] + 0.6, 0.6), (f'{AUD}/thunder.mp3', T['strike'] + 0.25, 1.0),
    (f'{AUD}/appear.mp3', T['strike'] + 0.9, 0.6),
    (f'{AUD}/whoosh.mp3', T['combo'] + 0.3, 0.7), (f'{AUD}/whoosh.mp3', T['combo'] + 1.2, 0.7), (f'{AUD}/riftHit.mp3', T['combo'] + 2.2, 0.7),
    (f'{AUD}/tell.mp3', T['parry'] + 0.9, 0.9), (f'{AUD}/riftHit.mp3', T['giant'] + 0.5, 0.8), (f'{AUD}/ruptureBoom.mp3', T['giant'] + 1.9, 0.8),
    (f'{AUD}/spiritDash.mp3', T['phantom'] + 0.2, 0.9), (f'{AUD}/riftCharge.mp3', T['rift'], 0.7), (f'{AUD}/riftRelease.mp3', T['rift'] + 1.3, 1.0),
    (f'{AUD}/ruptureCharge.mp3', T['rupture'], 0.6), (f'{AUD}/ruptureBoom.mp3', T['rupture'] + 0.35, 1.0), (f'{AUD}/debris.mp3', T['rupture'] + 1.6, 0.6),
    (f'{AUD}/whoosh.mp3', T['duel'] + 0.4, 0.7), (f'{AUD}/vanish.mp3', T['duel'] + 2.0, 0.8),
    (f'{AUD}/wind.mp3', T['turn'] - 0.6, 1.0), (f'{AUD}/riser.mp3', T['turn'], 0.8), (f'{AUD}/thunder.mp3', T['valley'], 1.0),
    (f'{AUD}/fireWave.mp3', T['inferno'] + 1.4, 1.0), (f'{AUD}/spiritDash.mp3', T['inferno'] + 1.95, 0.9),
    (f'{AUD}/fireCharge.mp3', T['meteor'] + 0.1, 0.7), (f'{AUD}/ruptureBoom.mp3', T['meteor'] + 2.2, 1.0), (f'{AUD}/fireWave.mp3', T['meteor'] + 2.25, 0.8),
    (f'{AUD}/thunder.mp3', T['wrath'] + 0.5, 0.8), (f'{AUD}/thunder.mp3', T['wrath'] + 1.3, 0.8), (f'{AUD}/riftRelease.mp3', T['wrath'] + 2.05, 0.9),
    (f'{AUD}/thunder.mp3', T['thunder'] + 0.4, 0.9), (f'{AUD}/vanish.mp3', T['thunder'] + 0.1, 0.7),
    (f'{AUD}/whoosh.mp3', T['tempest'] + 0.4, 0.9), (f'{AUD}/riftRelease.mp3', T['tempest'] + 1.3, 1.0),
    (f'{WK}/../edit/rumble.wav', T['black'] + 0.15, 1.0), (f'{WK}/../edit/bell.wav', T['title'] + 0.3, 0.35),
]
ins, parts = [], []
for i, (s, d, at, fi, fo) in enumerate(music):
    ins += ['-ss', f'{s}', '-t', f'{d:.3f}', '-i', f'{AUD}/music.m4a']
    parts.append(f"[{i}]afade=t=in:st=0:d={fi},afade=t=out:st={max(0, d - fo):.3f}:d={fo},volume=0.8,adelay={int(at * 1000)}|{int(at * 1000)}[m{i}]")
k = len(music)
for j, (fn, at, gn) in enumerate(sfx):
    ins += ['-i', fn]
    parts.append(f"[{k + j}]volume={gn},adelay={int(at * 1000)}|{int(at * 1000)}[s{j}]")
mix = ''.join(f'[m{i}]' for i in range(k)) + ''.join(f'[s{j}]' for j in range(len(sfx)))
parts.append(f"{mix}amix=inputs={k + len(sfx)}:normalize=0,alimiter=limit=0.9,atrim=0:{TOTAL:.3f}[a]")
run(ins + ['-filter_complex', ';'.join(parts), '-map', '[a]', '-ac', '2', '-ar', '48000', f'{WK}/sound.wav'])
run(['-i', f'{WK}/picture.mp4', '-i', f'{WK}/sound.wav', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', OUT])
print(f'done {OUT} {TOTAL:.1f}s')
for k2, v in T.items(): print(f'{k2:>8} {v:6.2f}')
