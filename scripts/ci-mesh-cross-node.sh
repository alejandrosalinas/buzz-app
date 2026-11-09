#!/usr/bin/env bash
# Linux CPU lane. No desktop, public mesh, credentials or GPU required.
set -euo pipefail
cd "$(dirname "$0")/.."
cache="${MESH_SMOKE_CACHE:-$PWD/.cache/mesh-cross-node}"
output="${MESH_SMOKE_OUTPUT:-$PWD/test-results/mesh-cross-node}"
mkdir -p "$cache" "$output"
archive="$cache/runtime-linux.tar.gz"
if [[ ! -f "$archive" ]]; then
  curl --fail --location --max-time 180 \
    https://github.com/Mesh-LLM/mesh-llm/releases/download/v0.78.1/meshllm-native-runtime-linux-x86_64-cpu.tar.gz \
    --output "$archive"
fi
echo "19fe012ae952e50a536f21c8c9f7864281656c8c20bc53902832850d6203106d  $archive" | sha256sum --check
tar -xzf "$archive" -C "$cache"
python3 src/bundled/mesh-compute/compute/tests/cross_node/run.py \
  --runtime-bundle "$cache/meshllm-native-runtime-linux-x86_64-cpu" \
  --cache "$cache" --output "$output"
