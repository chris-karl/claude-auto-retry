#!/usr/bin/env sh
# Build the npm tarball for the checked-out tree and attach it to release
# $TAG twice: under its versioned name, and as the stable-named copy
# claude-auto-retry.tgz that the releases/latest/download URL serves.
# Afterwards, append the pinned install command to the release notes.
# Guards against a checkout that cannot produce the release's tarball
# (version mismatch, or a tag from before the packaging build existed).
set -eu

version=$(jq -r .version package.json)
if [ "v$version" != "$TAG" ]; then
  echo "::error::package.json version $version does not match release tag $TAG — refusing to attach a mislabeled tarball"
  exit 1
fi

# npm pack runs the `prepare` build, so the tarball ships compiled dist/.
npm pack
tarball="claude-auto-retry-$version.tgz"

# Tags from before the packaging build pack raw TypeScript sources that
# cannot run from node_modules; refuse to ship an uninstallable tarball.
if ! tar -tzf "$tarball" | grep -qx 'package/dist/bin/cli.js'; then
  echo "::error::The packed tarball has no dist/bin/cli.js — this tag predates the packaging build, its tarball would not be installable"
  exit 1
fi

cp "$tarball" claude-auto-retry.tgz
gh release upload "$TAG" "$tarball" claude-auto-retry.tgz --clobber

# Append the pinned install command to the release notes — only when the
# tarball URL is not in there yet, so a re-run (retried release, repeated
# backfill) does not stack duplicates and a hand-reworded lead-in
# survives.
url="https://github.com/$GITHUB_REPOSITORY/releases/download/$TAG/$tarball"
body=$(gh release view "$TAG" --json body --jq .body)
case $body in
  *"$url"*)
    echo "Release notes already carry the install command"
    ;;
  *)
    printf '%s\n\n**Install this release with:**\n\n```sh\nnpm i -g --allow-remote=root %s\n```\n' \
      "$body" "$url" |
      gh release edit "$TAG" --notes-file -
    ;;
esac
