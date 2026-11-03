# Builds foliage card atlases from Poly Haven textures (CC0): grass clumps and flower heads.
import numpy as np
from PIL import Image
from scipy import ndimage
src = 'assets-src/polyhaven/cards/'
out = 'public/assets/textures/foliage/'

def rgba(name):
    im = Image.open(src + name + '_Diffuse.png').convert('RGB')
    a = Image.open(src + name + '_Alpha.png').convert('L').resize(im.size)
    im.putalpha(a)
    return im

def bleed(img):
    # Spread colour into transparent pixels so mipmaps don't produce dark fringes.
    arr = np.array(img).astype(np.float32)
    rgb, a = arr[..., :3], arr[..., 3] > 20
    if a.any():
        idx = ndimage.distance_transform_edt(~a, return_distances=False, return_indices=True)
        rgb = rgb[idx[0], idx[1]]
    arr[..., :3] = rgb
    return Image.fromarray(arr.astype(np.uint8))

g = rgba('grass_medium_01')
rects = [(195, 762, 512, 902), (25, 888, 205, 996), (255, 902, 512, 1000), (588, 878, 812, 1022)]
atlas = Image.new('RGBA', (2048, 256), (0, 0, 0, 0))
for i, (x0, y0, x1, y1) in enumerate(rects):
    c = g.crop((x0, y0, x1, y1))
    # Keep only the main clump: drop small disconnected fragments of other UV islands.
    arr = np.array(c); m = arr[..., 3] > 60
    lab, n = ndimage.label(ndimage.binary_dilation(m, iterations=3))
    if n > 1:
        sizes = ndimage.sum(m, lab, range(1, n + 1))
        keep = np.isin(lab, [i + 1 for i, v in enumerate(sizes) if v > sizes.max() * 0.06])
        arr[..., 3] = np.where(keep, arr[..., 3], 0)
        c = Image.fromarray(arr)
    c = c.crop(c.getbbox())
    # Fill a 512x256 cell (clumps are ~2:1), bottom-aligned so the card's base sits on the ground.
    c = c.resize((504, 252), Image.LANCZOS)
    atlas.paste(c, (i * 512 + 4, 256 - 252), c)
bleed(atlas).save(out + 'grass_atlas.webp', quality=90, lossless=False)

# Flower heads: yellow blobs from celandine + dandelion.
heads = []
for name in ['celandine_01', 'dandelion_01']:
    im = rgba(name)
    arr = np.array(im).astype(np.float32) / 255
    r, gg, b, a = arr[..., 0], arr[..., 1], arr[..., 2], arr[..., 3]
    yellow = (a > 0.5) & (r > 0.55) & (gg > 0.4) & (b < 0.35) & (r - b > 0.4)
    lab, n = ndimage.label(ndimage.binary_closing(yellow, iterations=2))
    sizes = ndimage.sum(yellow, lab, range(1, n + 1))
    for k in np.argsort(sizes)[::-1][:3]:
        sl = ndimage.find_objects((lab == k + 1).astype(np.int32))[0]
        h, w = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        fill = (lab[sl] == k + 1).mean()
        if min(h, w) < 25 or max(h, w) / min(h, w) > 1.6 or fill < 0.45: continue
        crop = im.crop((sl[1].start, sl[0].start, sl[1].stop, sl[0].stop))
        m = Image.fromarray(((lab[sl] == k + 1) * 255).astype(np.uint8)).filter(__import__('PIL.ImageFilter', fromlist=['x']).GaussianBlur(1))
        crop.putalpha(m)
        heads.append(crop)
heads = heads[:4]
fl = Image.new('RGBA', (1024, 256), (0, 0, 0, 0))
for i, c in enumerate(heads):
    c = c.resize((240, 240), Image.LANCZOS)
    fl.paste(c, (i * 256 + 8, 8), c)
# Slot 0: a pale white variant of the second head (white wildflowers for colour accents).
fl = fl.crop((0, 0, 1024, 256))
w = np.array(fl.crop((256, 0, 512, 256))).astype(np.float32)
lum = w[..., :3].mean(-1, keepdims=True)
w[..., :3] = np.clip(lum * 0.55 + 140, 0, 255) * np.array([1.0, 0.98, 0.93])
blank = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
fl.paste(blank, (0, 0)); fl.paste(Image.fromarray(w.astype(np.uint8)), (0, 0))
bleed(fl).save(out + 'flowers.webp', quality=90)
print('heads', len(heads))
