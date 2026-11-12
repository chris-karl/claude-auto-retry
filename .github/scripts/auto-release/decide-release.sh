#!/usr/bin/env sh
# Emit release/tag outputs: auto mode releases only Dependabot-authored
# changes to shipped content, release mode ($MODE=release) releases the
# pinned commit unconditionally.
set -eu

# Refuse to run on anything but the pinned $EXPECTED_COMMIT (abbreviated
# SHAs are fine): commits landing after review must not slip in.
if [ -n "${EXPECTED_COMMIT:-}" ]; then
  expected=$(echo "$EXPECTED_COMMIT" | tr 'A-F' 'a-f')
  case $expected in
    *[!0-9a-f]*)
      echo "::error::Expected commit \"$EXPECTED_COMMIT\" is not a hexadecimal commit SHA"
      exit 1
      ;;
  esac
  if [ "${#expected}" -lt 7 ]; then
    echo "::error::Expected commit \"$EXPECTED_COMMIT\" is too short to identify a commit, use at least 7 characters"
    exit 1
  fi
  head=$(git rev-parse HEAD)
  case $head in
    "$expected"*) ;;
    *)
      echo "::error::This run is for commit $head, not for the expected $expected — main moved or points elsewhere. Nothing was released; re-run with the current commit to release it."
      exit 1
      ;;
  esac
fi

# Emit the release outputs for the next tag ($1 = optional log suffix).
emit_release() {
  next_tag=$("$(dirname "$0")/compute-next-tag.sh")
  echo "Releasing $next_tag${1:+ ($1)}"
  {
    echo "release=true"
    echo "tag=$next_tag"
  } >> "$GITHUB_OUTPUT"
}

if [ "${MODE:-auto}" = "release" ]; then
  # An accidental double dispatch must not cut a second release.
  released_as=$(git tag -l '[0-9]*.[0-9]*.[0-9]*' --points-at HEAD)
  if [ -n "$released_as" ]; then
    echo "::error::Commit $(git rev-parse HEAD) is already released as $released_as"
    exit 1
  fi
  emit_release "manually requested"
  exit 0
fi

# The tags inherited from upstream are not reachable from main; a first
# manual release has to establish the baseline tag.
if ! last_tag=$(git describe --tags --abbrev=0 2> /dev/null); then
  echo "No release tag reachable from HEAD, run a manual release to establish the baseline"
  echo "release=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

# Only what the tarball ships can warrant a release: the compiled sources,
# the build inputs and the runtime dependency ranges. Lockfile-only and
# dev-only bumps change nothing for an installer.
shipped="src bin scripts tsconfig.json tsconfig.build.json"
shipped_manifest() { git show "$1:package.json" | jq -cS "{dependencies, engines, bin, files}"; }
# shellcheck disable=SC2086 # $shipped is a word list
if [ -z "$(git diff --name-only "$last_tag"..HEAD -- $shipped)" ] \
   && [ "$(shipped_manifest "$last_tag")" = "$(shipped_manifest HEAD)" ]; then
  echo "No shipped-content changes since $last_tag, nothing to release"
  echo "release=false" >> "$GITHUB_OUTPUT"
  exit 0
fi
# The bot email covers version bump commits from a failed earlier run.
# No pipe into sort: set -e cannot see a pipe's left side.
# shellcheck disable=SC2086
author_emails=$(git log "$last_tag"..HEAD --format="%ae" -- $shipped package.json)
unexpected=$(printf "%s\n" "$author_emails" | sort -u | grep -Fxv \
  -e "49699333+dependabot[bot]@users.noreply.github.com" \
  -e "41898282+github-actions[bot]@users.noreply.github.com" || true)
if [ -n "$unexpected" ]; then
  echo "Shipped-content commits since $last_tag are not exclusively authored by Dependabot, skipping auto-release. Unexpected authors:"
  echo "$unexpected"
  echo "release=false" >> "$GITHUB_OUTPUT"
  exit 0
fi
emit_release
