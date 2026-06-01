#!/usr/bin/env sh
set -eu
npm run test:unit
npm run test:integration
npm run test:ui
npm run test:e2e
