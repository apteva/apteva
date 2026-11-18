#!/usr/bin/env bash
# Prepares a platform release commit: pins every component checked out by
# .github/workflows/release.yml to its current main, and sets the CLI version.
#
#   scripts/prepare-release.sh 0.100.16            # edit files, show the diff
#   scripts/prepare-release.sh 0.100.16 --tag      # also commit, push main, tag
#
# Components come from the workflow's `repository: apteva/<name>` lines, so a
# repo dropped from the workflow (like computer) is simply not pinned. The
# SHAs come from GitHub (git ls-remote), not from local checkouts, so stale
# local clones cannot leak into a release.
set -euo pipefail

VERSION="${1:?Usage: prepare-release.sh <version> [--tag]}"
TAG="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WF="$ROOT/.github/workflows/release.yml"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "version must look like 0.100.16, got: $VERSION" >&2
  exit 2
fi
if [ -n "$TAG" ] && [ "$TAG" != "--tag" ]; then
  echo "unknown option: $TAG" >&2
  exit 2
fi

cd "$ROOT"
git fetch -q origin
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "working tree is not clean; commit or set aside changes first" >&2
  exit 1
fi
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "HEAD is not origin/main; run: git checkout --detach origin/main" >&2
  exit 1
fi
if git ls-remote --exit-code --tags origin "refs/tags/v$VERSION" >/dev/null 2>&1; then
  echo "tag v$VERSION already exists on origin" >&2
  exit 1
fi

repos=$(grep -E '^\s+repository: apteva/' "$WF" | awk -F/ '{print $2}' | sort -u)
for r in $repos; do
  olds=$(grep -A1 -E "repository: apteva/$r\$" "$WF" | awk '/ref:/{print $2}' | sort -u)
  if [ "$(echo "$olds" | wc -l | tr -d ' ')" != 1 ]; then
    echo "$r is pinned to more than one ref in release.yml:" $olds >&2
    exit 1
  fi
  new=$(git ls-remote "https://github.com/apteva/$r.git" refs/heads/main | awk '{print $1}')
  if [ -z "$new" ]; then
    echo "could not resolve apteva/$r main" >&2
    exit 1
  fi
  if [ "$olds" != "$new" ]; then
    # Replaces the checkout refs and the raw.githubusercontent version URLs.
    sed -i.bak "s/$olds/$new/g" "$WF" && rm -f "$WF.bak"
    printf '%-13s %s -> %s\n' "$r" "${olds:0:9}" "${new:0:9}"
  else
    printf '%-13s %s (unchanged)\n' "$r" "${new:0:9}"
  fi
done

bun -e "const f='$ROOT/package.json';const p=await Bun.file(f).json();p.version='$VERSION';await Bun.write(f,JSON.stringify(p,null,2)+'\n')"
git --no-pager diff --stat

if [ "$TAG" = "--tag" ]; then
  git commit -qam "Release Apteva $VERSION"
  git push -q origin HEAD:main
  git tag "v$VERSION"
  git push -q origin "v$VERSION"
  echo "tagged v$VERSION; release run: gh run list --workflow release.yml --limit 1"
else
  echo "review, then: git commit -am 'Release Apteva $VERSION' && git push origin HEAD:main && git tag v$VERSION && git push origin v$VERSION"
fi
