#!/bin/sh
# Downloads the LPS Head scan (CC BY 3.0, (c) I-R Entertainment Ltd.) used by the mentor preview.
set -e
D="$(dirname "$0")/../assets-src/heads/lee-perry-smith"; mkdir -p "$D"
B=https://raw.githubusercontent.com/mrdoob/three.js/r170/examples/models/gltf/LeePerrySmith
for f in LeePerrySmith.glb Map-COL.jpg Map-SPEC.jpg Infinite-Level_02_Tangent_SmoothUV.jpg; do curl -sSfL -o "$D/$f" "$B/$f"; done
echo "ok"
