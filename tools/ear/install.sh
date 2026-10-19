#!/bin/sh
# Installs the EBU ADM Renderer and its dependencies into one directory (#74, decision 140),
# for the media worker to run with ADM_RENDERER_PATH pointing at it. Every file is pinned by
# hash. The dependencies are wheels only; ear, published as source, is built with the
# setuptools of build-requirements.txt, kept in a directory of its own and left behind. Needs pip, so it
# runs in the image's build stage, never in the runtime.
set -eu
target="${1:?usage: install.sh <directory>}"
here="$(cd "$(dirname "$0")" && pwd)"
build="$(mktemp -d)"
trap 'rm -rf "${build:?}"' EXIT
pip() {
  python3 -m pip --no-cache-dir --disable-pip-version-check install --no-deps --require-hashes "$@"
}
pip --only-binary=:all: --target "$target" -r "$here/requirements.txt"
pip --only-binary=:all: --target "$build" -r "$here/build-requirements.txt"
PYTHONPATH="$build:$target" pip --no-build-isolation --target "$target" -r "$here/renderer-requirements.txt"
# pkg_resources, which ear reads its data files with, from the standard library instead.
cp -R "$here/pkg_resources" "$target/"
# Only what runs (with its compiled modules, for a quick start): no test suites or scripts.
find "${target:?}" -depth -type d \( -path "${target:?}/bin" \
  -o -path "*/ear/test" -o \( -name tests \( -path "*/numpy/*" -o -path "*/scipy/*" \) \) \) \
  -exec rm -rf {} +
