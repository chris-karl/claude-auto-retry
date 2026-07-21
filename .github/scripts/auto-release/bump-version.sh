#!/usr/bin/env sh
# Bump the package files to $TAG's version, push that to main and emit
# the commit to tag as the sha output.
set -eu

version=${TAG#v}
npm version --no-git-tag-version --allow-same-version "$version" > /dev/null
if git diff --quiet; then
  # Already bumped (by a failed earlier run, or by hand); reuse it.
  echo "Version is already $version, nothing to commit"
else
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git add package.json package-lock.json
  git commit -m "Bump version to $version"
  # If main moved, this push fails the run; the newer commit's own
  # auto-release run redoes the bump and releases everything together.
  # Push with an explicit one-shot token (checkout persists no credentials),
  # so the writable token never lands in .git/config.
  git push "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" HEAD:main
fi
echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
