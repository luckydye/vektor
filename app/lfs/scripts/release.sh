#!/usr/bin/env bash
# Create and push a date-based release tag: vYYYY-MM-DD.N
#
# N starts at 1 for the first release of the day and increments for each
# subsequent one. Pushing the tag triggers .github/workflows/release.yml,
# which builds the binaries and attaches them to a GitHub release.
#
# Usage: scripts/release.sh [--dry-run]

set -euo pipefail

dry_run=false
case "${1:-}" in
    --dry-run) dry_run=true ;;
    "") ;;
    *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

cd "$(git rev-parse --show-toplevel)"

remote="$(git remote | grep -x origin || git remote | head -n1)"
if [[ -z "$remote" ]]; then
    echo "error: no git remote configured" >&2
    exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
    echo "error: working tree is dirty; commit or stash first" >&2
    git status --short >&2
    exit 1
fi

# Also pick up tags that exist only on the remote, so N is never reused.
git fetch --tags --quiet "$remote"

date="$(date +%Y-%m-%d)"
n=1
while git rev-parse -q --verify "refs/tags/v$date.$n" >/dev/null; do
    n=$((n + 1))
done
tag="v$date.$n"

branch="$(git rev-parse --abbrev-ref HEAD)"
echo "tag:    $tag"
echo "commit: $(git rev-parse --short HEAD) ($branch)"
echo "remote: $remote"

if $dry_run; then
    echo "(dry run; nothing tagged or pushed)"
    exit 0
fi

git tag -a "$tag" -m "Release $tag"
git push "$remote" "$tag"

echo "pushed $tag; the release workflow should start shortly"
