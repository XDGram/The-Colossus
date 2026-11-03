# Downloads Poly Haven texture sets (1k) and converts them to the runtime format used by Assets:
#   public/assets/textures/<id>/{color,normal,arh}.webp   (arh = AO, roughness, height)
# usage: python3 tools/fetch-phtex.py id [id...]
import json, os, subprocess, sys, io
from PIL import Image
for tid in sys.argv[1:]:
    f = json.loads(subprocess.run(['curl', '-sSfL', f'https://api.polyhaven.com/files/{tid}'], capture_output=True, check=True).stdout)
    src = os.path.join('assets-src', 'polyhaven', 'textures', tid); os.makedirs(src, exist_ok=True)
    def get(key):
        if key not in f: return None
        url = f[key]['1k']['jpg']['url']; path = os.path.join(src, f'{key}.jpg')
        if not os.path.exists(path): subprocess.run(['curl', '-sSfL', '-o', path, url], check=True)
        return Image.open(path)
    out = os.path.join('public', 'assets', 'textures', tid); os.makedirs(out, exist_ok=True)
    diff = get('Diffuse'); nor = get('nor_gl'); arm = get('arm'); disp = get('Displacement')
    diff.convert('RGB').save(os.path.join(out, 'color.webp'), quality=85)
    nor.convert('RGB').save(os.path.join(out, 'normal.webp'), quality=90)
    a = arm.convert('RGB').split()
    h = disp.convert('L').resize(diff.size) if disp else Image.new('L', diff.size, 128)
    Image.merge('RGB', (a[0], a[1], h)).save(os.path.join(out, 'arh.webp'), quality=90)
    print('ok', tid)
