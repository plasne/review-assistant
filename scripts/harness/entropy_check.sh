#!/usr/bin/env sh
set -eu
test -f AGENTS.md
test -f docs/ARCHITECTURE.md
test -f docs/OBSERVABILITY.md
npm run lint
