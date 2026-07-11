#!/usr/bin/env sh
# Print the next release tag; $BUMP picks the component (default patch).
# On failure a ::error:: line goes to stdout instead, with a nonzero exit.
set -eu

bump=${BUMP:-patch}
case $bump in
  patch|minor|major) ;;
  *)
    echo "::error::Unknown BUMP value \"$bump\", expected patch, minor or major"
    exit 1
    ;;
esac

bump_version() { # $1 = version, $2 = component to increment
  echo "$1" | awk -F. -v OFS=. -v part="$2" '{
    if (part == "major") { $1++; $2 = 0; $3 = 0 }
    else if (part == "minor") { $2++; $3 = 0 }
    else { $3++ }
    print
  }'
}

# Newest tag in version order — the nearest reachable tag could miss one.
newest_tag=$(git tag -l 'v*' | sort -V | tail -n 1)
current=$(jq -r .version package.json)
if git rev-parse -q --verify "refs/tags/v$current" > /dev/null; then
  if [ "v$current" != "$newest_tag" ]; then
    echo "::error::package.json version $current is behind the newest tag $newest_tag. Reconcile with npm version before releasing."
    exit 1
  fi
  next_tag="v$(bump_version "$current" "$bump")"
else
  # Ahead of the tags — but it must never be behind the newest one.
  ahead=$(printf '%s\nv%s\n' "$newest_tag" "$current" | sort -V | tail -n 1)
  if [ "$ahead" != "v$current" ]; then
    echo "::error::package.json version $current is behind the newest tag $newest_tag. Reconcile with npm version before releasing."
    exit 1
  fi
  if [ "$bump" = "patch" ]; then
    next_tag="v$current"
  else
    next_tag="v$(bump_version "$current" "$bump")"
  fi
fi
if git rev-parse -q --verify "refs/tags/$next_tag" > /dev/null; then
  echo "::error::Tag $next_tag already exists"
  exit 1
fi
echo "$next_tag"
