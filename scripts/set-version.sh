#!/usr/bin/env bash
set -euo pipefail

# Sets the npm package version for this standalone CLI repo.
# Usage: ./scripts/set-version.sh 0.18.0

VERSION="${1:?Usage: set-version.sh <version>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Setting version to ${VERSION}..."

node -e "
  const pkg = require('${ROOT}/package.json');
  pkg.version = '${VERSION}';
  require('fs').writeFileSync('${ROOT}/package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "  package.json"

echo "Done. Tag with: git tag v${VERSION} && git push origin v${VERSION}"
