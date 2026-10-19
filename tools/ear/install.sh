#!/bin/sh
# Installs the EBU ADM Renderer and its dependencies into one directory (#74, decision 140),
# for the media worker to run with ADM_RENDERER_PATH pointing at it. Every file is pinned by
# hash. The dependencies are wheels only; ear, published as source, is built against them
# without fetching anything else. Needs pip, so it runs in the image's build stage, never in
# the runtime.
set -eu
target="${1:?usage: install.sh <directory>}"
here="$(cd "$(dirname "$0")" && pwd)"
python3 -m pip install --no-cache-dir --disable-pip-version-check --no-deps --require-hashes \
  --only-binary=:all: --target "$target" -r "$here/requirements.txt"
PYTHONPATH="$target" python3 -m pip install --no-cache-dir --disable-pip-version-check \
  --no-deps --require-hashes --no-build-isolation --target "$target" -r "$here/renderer.txt"
# Only what runs (with its compiled modules, for a quick start): no test suites or scripts.
find "${target:?}" -depth -type d \( -path "${target:?}/bin" \
  -o -path "*/ear/test" -o \( -name tests \( -path "*/numpy/*" -o -path "*/scipy/*" \
  -o -path "*/setuptools/*" \) \) \) -exec rm -rf {} +
