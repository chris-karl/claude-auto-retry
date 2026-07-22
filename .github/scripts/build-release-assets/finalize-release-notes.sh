#!/usr/bin/env sh
# Shape the human-facing release notes for $TAG, run after the tarball
# has been attached: rebrand GitHub's generated heading and pin the
# install command that points at the attached tarball. Kept as its own
# step so a single body read/edit covers both rewrites. Idempotent and
# safe to re-run on a retried release or a backfill.
set -eu

# The install command and the run-marker that dedupes it both key off
# this download URL, built from the stable asset name in $TARBALL (shared
# with attach-tarball.sh via the workflow env).
url="https://github.com/$GITHUB_REPOSITORY/releases/download/$TAG/$TARBALL"
body=$(gh release view "$TAG" --json body --jq .body)

# Swap GitHub's "## What's Changed" heading for the fork note and our
# "What's New" heading, normalising however many blank lines follow the
# heading (GitHub currently emits none) to exactly one. Idempotent and
# self-healing: a re-run re-normalises the existing "### What's New" the
# same way, so the body converges instead of drifting.
notes=$(printf '%s\n' "$body" | awk \
  -v old="## What's Changed" \
  -v note="> **Note:** This repository is a fork of [cheapestinference/claude-auto-retry](https://github.com/cheapestinference/claude-auto-retry) with modifications." \
  -v new="### What's New" '
  $0 == old { print note; print ""; print new; squeeze = 1; next }
  $0 == new { print; squeeze = 1; next }
  squeeze && $0 == "" { next }
  squeeze { print ""; squeeze = 0 }
  { print }
')

# Refresh the pinned install command. A block left by an earlier run is
# recognised by this release's download URL — which also spots the ones
# naming the superseded versioned asset — and is cut rather than skipped,
# so a re-run replaces it instead of stacking a duplicate. It is always
# the last thing in the body, so the cut runs to the end.
case $notes in
  *"https://github.com/$GITHUB_REPOSITORY/releases/download/$TAG/"*)
    notes=$(printf '%s\n' "$notes" |
      awk '$0 == "**Install this release with:**" { exit } { print }')
    ;;
esac
notes=$(printf '%s\n\n\n**Install this release with:**\n\n```sh\nnpm i -g --allow-remote=root --allow-scripts=node-pty %s\n```\n' \
  "$notes" "$url")

if [ "$notes" = "$body" ]; then
  echo "Release notes already shaped for this release"
else
  printf '%s\n' "$notes" | gh release edit "$TAG" --notes-file -
fi
