#!/usr/bin/env sh
# What a pull request touches, as outputs for the CI workflow (#474): each job runs only when
# files it covers changed. Without a base (a push to master, the nightly run, a run by hand)
# everything runs. Usage: scripts/ci-changes.sh [base-sha] >> "$GITHUB_OUTPUT"
set -eu

groups="check server web visual image kubernetes docs deps"
all() { for g in $groups; do echo "$g=true"; done; }

if [ $# -eq 0 ]; then all; exit 0; fi
files=$(git diff --name-only "$1" HEAD) || { all; exit 0; }
has() { printf '%s\n' "$files" | grep -Eq "$1" && echo true || echo false; }

# A change to how CI runs, or to the dependency set every package shares, runs everything.
if [ "$(has '^(\.github/workflows/ci\.yml|scripts/ci-changes\.sh|pnpm-lock\.yaml|pnpm-workspace\.yaml|package\.json|\.nvmrc|\.npmrc|biome\.json|tsconfig\.base\.json|vitest\.config\.ts)$')" = true ]; then
  all
  exit 0
fi

# Files no check reads: prose, the brand, the load test, the other workflows.
quiet='^(docs/|brand/|load/|LICENSE$|\.github/|.*\.md$)'
if printf '%s\n' "$files" | grep -Ev "$quiet" | grep -q . || [ "$(has '^docs/site/')" = true ]; then
  echo "check=true"
else
  echo "check=false"
fi
echo "server=$(has '^(apps/server/|packages/|tools/ear/|docs/site/scripts/|docs/openapi\.json)')"
echo "web=$(has '^(apps/web/|apps/prototype/|packages/shared/)')"
echo "visual=$(has '^(apps/web/|apps/e2e/|apps/server/|packages/|scripts/backup-drill\.sh)')"
echo "image=$(has '^(Dockerfile|\.dockerignore|deploy/|scripts/image-smoke\.mjs|tools/ear/|\.trivyignore|apps/server/package\.json|apps/web/package\.json|packages/[^/]+/package\.json)')"
echo "kubernetes=$(has '^deploy/helm/')"
echo "docs=$(has '^(docs/|README\.md)')"
echo "deps=$(has '(^|/)package\.json$|^pnpm-lock\.yaml$|^pnpm-workspace\.yaml$|^\.github/renovate\.json5$')"
