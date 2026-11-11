#!/usr/bin/env bash
# Generic video -> Gaussian Splat pipeline, parameterized.
# Usage: generic_pipeline.sh VIDEO PROJECT_DIR SPLAT_ID "SPLAT_LABEL" FPS
set -euo pipefail

export MAMBA_ROOT_PREFIX="$HOME/.local/micromamba/root"
export PATH="/usr/local/cuda/bin:$PATH"
export CUDA_HOME=/usr/local/cuda
export TORCH_CUDA_ARCH_LIST=8.6
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
MM="$HOME/.local/micromamba/bin/micromamba"

GS_REPO="${GS_REPO:-$HOME/projects/gaussian-splatting}"  # path to your graphdeco-inria/gaussian-splatting checkout
VIDEO="$1"
PROJECT="$2"
SPLAT_ID="$3"
SPLAT_LABEL="$4"
FPS="$5"

mkdir -p "$PROJECT/input"

echo "== [1/6] Extracting frames from $VIDEO (fps=$FPS) =="
ffmpeg -y -i "$VIDEO" -qscale:v 1 -qmin 1 -vf fps="$FPS" "$PROJECT/input/%04d.jpg"
N=$(find "$PROJECT/input" -type f | wc -l)
echo "== $N frames staged =="

cd "$PROJECT"

echo "== [2/6] COLMAP feature extraction (max image size 1280 -- avoids GPU OOM) =="
"$MM" run -n gs colmap feature_extractor \
  --image_path input --database_path database.db \
  --ImageReader.camera_model PINHOLE --ImageReader.single_camera 1 \
  --FeatureExtraction.use_gpu 1 --FeatureExtraction.max_image_size 1280

echo "== [3/6] COLMAP sequential matching =="
"$MM" run -n gs colmap sequential_matcher \
  --database_path database.db --FeatureMatching.use_gpu 1 \
  --SequentialMatching.overlap 15

echo "== [4/6] COLMAP mapper =="
mkdir -p sparse
"$MM" run -n gs colmap mapper \
  --database_path database.db --image_path input --output_path sparse

echo "== Picking largest submodel by registered-image count =="
WINNER=""
WINNER_COUNT=0
for d in sparse/*/; do
  n=$(basename "$d")
  count=$("$MM" run -n gs colmap model_analyzer --path "sparse/$n" 2>&1 \
          | grep -oP 'Registered images\s*:\s*\K[0-9]+' || echo 0)
  echo "submodel $n: $count registered images"
  if [ "$count" -gt "$WINNER_COUNT" ]; then
    WINNER="$n"
    WINNER_COUNT="$count"
  fi
done
if [ -z "$WINNER" ]; then
  echo "ERROR: no valid COLMAP submodel produced (reconstruction likely failed)" >&2
  exit 1
fi
echo "== Winning submodel: sparse/$WINNER ($WINNER_COUNT images) =="

echo "== [5/6] Undistort (winning submodel: sparse/$WINNER) =="
"$MM" run -n gs colmap image_undistorter \
  --image_path input --input_path "sparse/$WINNER" \
  --output_path undistorted --output_type COLMAP

if [ ! -d undistorted/sparse/0 ] && [ -f undistorted/sparse/cameras.bin ]; then
  mkdir -p undistorted/sparse/0
  mv undistorted/sparse/*.bin undistorted/sparse/0/
  mv undistorted/sparse/project.ini undistorted/sparse/0/ 2>/dev/null || true
  echo "Fixed: moved .bin files into undistorted/sparse/0/"
fi

echo "== [6/6] Training (7000 iters, --resolution 4, gentle densification for 6GB VRAM) =="
cd "$GS_REPO"
"$MM" run -n gs python train.py \
  -s "$PROJECT/undistorted" -m "$PROJECT/output" \
  --iterations 7000 --test_iterations -1 --save_iterations 7000 \
  --resolution 4 \
  --densify_grad_threshold 0.0004 --densification_interval 200 --densify_until_iter 5000 \
  --disable_viewer

echo "TRAINING_DONE"

PLY="$PROJECT/output/point_cloud/iteration_7000/point_cloud.ply"
if [ ! -f "$PLY" ]; then
  echo "ERROR: expected output PLY not found at $PLY" >&2
  exit 1
fi
echo "== Output PLY: $PLY =="

echo "== Registering in gallery viewer ==" 
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
"$REPO_DIR/scripts/add_splat.sh" "$PLY" "$SPLAT_ID" "$SPLAT_LABEL"

echo "ALL_DONE for $SPLAT_ID"
