#!/usr/bin/env bash
set -euo pipefail

# Sets the version across all package files.
# Usage: ./scripts/set-version.sh 0.8.0

VERSION="${1:?Usage: set-version.sh <version>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Setting version to ${VERSION}..."

# Root package.json
node -e "
  const pkg = require('${ROOT}/package.json');
  pkg.version = '${VERSION}';
  require('fs').writeFileSync('${ROOT}/package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "  package.json"

# apteva/package.json (npm package)
node -e "
  const pkg = require('${ROOT}/apteva/package.json');
  pkg.version = '${VERSION}';
  require('fs').writeFileSync('${ROOT}/apteva/package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "  apteva/package.json"

echo "Done. Tag with: git tag v${VERSION} && git push origin v${VERSION}"
