# Downloads Poly Haven glTF models (with textures) into assets-src/polyhaven/<id>/
import json, os, subprocess, sys
res = sys.argv[1]; ids = sys.argv[2:]
root = os.path.join(os.path.dirname(__file__), '..', 'assets-src', 'polyhaven')
def curl(url, dest=None):
    if dest:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if not os.path.exists(dest): subprocess.run(['curl', '-sSfL', '-o', dest, url], check=True)
    else: return subprocess.run(['curl', '-sSfL', url], check=True, capture_output=True).stdout
for i in ids:
    f = json.loads(curl(f'https://api.polyhaven.com/files/{i}'))
    g = f['gltf'][res]['gltf']; d = os.path.join(root, i)
    curl(g['url'], os.path.join(d, os.path.basename(g['url'])))
    for rel, inc in g.get('include', {}).items(): curl(inc['url'], os.path.join(d, rel))
    print('ok', i)
