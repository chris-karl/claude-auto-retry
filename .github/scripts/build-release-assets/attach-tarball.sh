#!/usr/bin/env sh
# Build the npm tarball for the checked-out tree and attach it to release
# $TAG as claude-auto-retry.tgz — the one stable name that both the
# releases/latest/download URL and the per-tag download URL serve.
# Afterwards, refresh the pinned install command in the release notes.
# Guards against a checkout that cannot produce the release's tarball
# (version mismatch, or a tag from before the packaging build existed).
set -eu

version=$(jq -r .version package.json)
if [ "v$version" != "$TAG" ]; then
  echo "::error::package.json version $version does not match release tag $TAG — refusing to attach a mislabeled tarball"
  exit 1
fi

# The manifest carries no `prepare` script, so build explicitly before packing.
npm run build
npm pack
tarball=claude-auto-retry.tgz
mv "claude-auto-retry-$version.tgz" "$tarball"

# Tags from before the packaging build pack raw TypeScript sources that
# cannot run from node_modules; refuse to ship an uninstallable tarball.
if ! tar -tzf "$tarball" | grep -qx 'package/dist/bin/cli.js'; then
  echo "::error::The packed tarball has no dist/bin/cli.js — this tag predates the packaging build, its tarball would not be installable"
  exit 1
fi

# --clobber replaces an identically named asset from an earlier run. The
# versioned asset older releases still carry has a different name and is
# deliberately left in place.
gh release upload "$TAG" "$tarball" --clobber

# Refresh the pinned install command in the release notes. A block left
# by an earlier run is recognised by this release's download URL — which
# also spots the ones naming the superseded versioned asset — and is cut
# rather than skipped, so a re-run (retried release, repeated backfill)
# replaces it instead of stacking a duplicate. It is always the last
# thing in the body, so the cut runs to the end.
url="https://github.com/$GITHUB_REPOSITORY/releases/download/$TAG/$tarball"
body=$(gh release view "$TAG" --json body --jq .body)

notes=$body
case $notes in
  *"https://github.com/$GITHUB_REPOSITORY/releases/download/$TAG/"*)
    notes=$(printf '%s\n' "$notes" |
      awk '$0 == "**Install this release with:**" { exit } { print }')
    ;;
esac
notes=$(printf '%s\n\n**Install this release with:**\n\n```sh\nnpm i -g --allow-remote=root --allow-scripts=node-pty %s\n```\n' \
  "$notes" "$url")

if [ "$notes" = "$body" ]; then
  echo "Release notes already carry the current install command"
else
  printf '%s\n' "$notes" | gh release edit "$TAG" --notes-file -
fi
