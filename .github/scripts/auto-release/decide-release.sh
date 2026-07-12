#!/usr/bin/env sh
# Emit release/tag outputs: auto mode releases only Dependabot-authored
# changes, manual mode ($BUMP = patch/minor/major) unconditionally.
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

if [ "${BUMP:-auto}" != "auto" ]; then
  # An accidental double dispatch must not cut a second release.
  released_as=$(git tag -l 'v*' --points-at HEAD)
  if [ -n "$released_as" ]; then
    echo "::error::Commit $(git rev-parse HEAD) is already released as $released_as"
    exit 1
  fi
  if ! next_tag=$("$(dirname "$0")/compute-next-tag.sh"); then
    # The captured output holds the ::error:: diagnostic.
    echo "$next_tag"
    exit 1
  fi
  echo "Releasing $next_tag (manually requested $BUMP bump)"
  {
    echo "release=true"
    echo "tag=$next_tag"
  } >> "$GITHUB_OUTPUT"
  exit 0
fi

# The tags inherited from upstream are not reachable from main; a first
# manual release has to establish the baseline tag.
if ! last_tag=$(git describe --tags --abbrev=0 2> /dev/null); then
  echo "No release tag reachable from HEAD, run a manual release to establish the baseline"
  echo "release=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

# Paths that never affect the released code; a list of only negative
# pathspecs matches everything else.
set -- \
  ':(exclude).github/' \
  ':(exclude)LICENSE' \
  ':(exclude)README.md' \
  ':(exclude)CLAUDE.md' \
  ':(exclude).gitignore'

if [ -z "$(git diff --name-only "$last_tag"..HEAD -- "$@")" ]; then
  echo "No release-relevant changes since $last_tag, nothing to release"
  echo "release=false" >> "$GITHUB_OUTPUT"
  exit 0
fi
# The bot email covers version bump commits from a failed earlier run.
# No pipe into sort: set -e cannot see a pipe's left side.
author_emails=$(git log "$last_tag"..HEAD --format='%ae' -- "$@")
unexpected=$(printf '%s\n' "$author_emails" | sort -u | grep -Fxv \
  -e '49699333+dependabot[bot]@users.noreply.github.com' \
  -e '41898282+github-actions[bot]@users.noreply.github.com' || true)
if [ -n "$unexpected" ]; then
  echo "Release-relevant commits since $last_tag are not exclusively authored by Dependabot, skipping auto-release. Unexpected authors:"
  echo "$unexpected"
  echo "release=false" >> "$GITHUB_OUTPUT"
  exit 0
fi
if ! next_tag=$(BUMP=patch "$(dirname "$0")/compute-next-tag.sh"); then
  # The captured output holds the ::error:: diagnostic.
  echo "$next_tag"
  exit 1
fi
echo "Releasing $next_tag"
{
  echo "release=true"
  echo "tag=$next_tag"
} >> "$GITHUB_OUTPUT"
