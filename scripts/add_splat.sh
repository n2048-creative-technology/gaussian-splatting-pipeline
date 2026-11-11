#!/bin/bash
# add_splat.sh — register a trained Gaussian Splat .ply into this repo's
# viewer gallery.
#
# Usage: add_splat.sh <path-to-point_cloud.ply> <id> <label> [created-date]
#
# Example:
#   scripts/add_splat.sh ~/projects/gaussian-splatting/my-scene/output/point_cloud/iteration_7000/point_cloud.ply \
#       my-scene "My scene" 2026-11-11
#
# Converts the PLY to the compressed .ksplat format (via the official
# GaussianSplats3D converter util), drops it into viewer/splats/, and
# appends/updates its entry in viewer/manifest.json. Run `docker compose
# up -d --build` afterwards (or just refresh if you're serving viewer/
# directly) to pick up the change.
#
# Requires: Node.js, and a checkout of
# https://github.com/mkkellogg/GaussianSplats3D (for util/create-ksplat.js)
# -- set GS3D_SRC below to point at it, or pass it as $5.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLY_PATH="$1"
SPLAT_ID="$2"
LABEL="$3"
CREATED="${4:-$(date +%Y-%m-%d)}"
GS3D_SRC="${5:-$HOME/GaussianSplats3D}"

WEB_DIR="$REPO_DIR/viewer"
KSPLAT_OUT_DIR="$WEB_DIR/splats"

if [ ! -f "$PLY_PATH" ]; then
  echo "ERROR: PLY not found: $PLY_PATH" >&2
  exit 1
fi

if [ ! -f "$GS3D_SRC/util/create-ksplat.js" ]; then
  echo "ERROR: ksplat converter not found at $GS3D_SRC/util/create-ksplat.js" >&2
  echo "       Clone https://github.com/mkkellogg/GaussianSplats3D and pass its path as \$5, or set GS3D_SRC." >&2
  exit 1
fi

mkdir -p "$KSPLAT_OUT_DIR"

OUT_KSPLAT="$KSPLAT_OUT_DIR/${SPLAT_ID}.ksplat"
echo "Converting $PLY_PATH -> $OUT_KSPLAT ..."
node "$GS3D_SRC/util/create-ksplat.js" "$PLY_PATH" "$OUT_KSPLAT" 1 5
echo "Written: $OUT_KSPLAT ($(stat -c%s "$OUT_KSPLAT") bytes)"

MANIFEST="$WEB_DIR/manifest.json"
if [ ! -f "$MANIFEST" ]; then
  cp "$WEB_DIR/manifest.example.json" "$MANIFEST"
fi

python3 - "$MANIFEST" "$SPLAT_ID" "$LABEL" "$CREATED" << 'PYEOF'
import json, sys
manifest_path, splat_id, label, created = sys.argv[1:5]
with open(manifest_path) as f:
    data = json.load(f)
data["splats"] = [s for s in data["splats"] if s["id"] != splat_id]  # replace if re-running
data["splats"].append({
    "id": splat_id,
    "label": label,
    "file": f"./splats/{splat_id}.ksplat",
    "created": created,
})
with open(manifest_path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print(f"manifest.json updated: {len(data['splats'])} splats total")
PYEOF

echo "Done. Splat '$SPLAT_ID' is in viewer/splats/ and registered in viewer/manifest.json."
echo "Run 'docker compose up -d --build' to serve it (or refresh if serving viewer/ directly)."
