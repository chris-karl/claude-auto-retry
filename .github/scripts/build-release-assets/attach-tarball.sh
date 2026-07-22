#!/usr/bin/env sh
# Build the npm tarball for the checked-out tree and attach it to release
# $TAG under the stable asset name in $TARBALL — the one name that both
# the releases/latest/download URL and the per-tag download URL serve.
# Guards against a checkout that cannot produce the release's tarball
# (version mismatch, or a tag from before the packaging build existed).
# Shaping the release notes is a separate step (finalize-release-notes.sh).
set -eu

version=$(jq -r .version package.json)
if [ "v$version" != "$TAG" ]; then
  echo "::error::package.json version $version does not match release tag $TAG — refusing to attach a mislabeled tarball"
  exit 1
fi

# The manifest carries no `prepare` script, so build explicitly before packing.
npm run build
npm pack
mv "claude-auto-retry-$version.tgz" "$TARBALL"

# Tags from before the packaging build pack raw TypeScript sources that
# cannot run from node_modules; refuse to ship an uninstallable tarball.
if ! tar -tzf "$TARBALL" | grep -qx 'package/dist/bin/cli.js'; then
  echo "::error::The packed tarball has no dist/bin/cli.js — this tag predates the packaging build, its tarball would not be installable"
  exit 1
fi

# --clobber replaces an identically named asset from an earlier run. The
# versioned asset older releases still carry has a different name and is
# deliberately left in place.
gh release upload "$TAG" "$TARBALL" --clobber
