#!/usr/bin/env sh
# Squash-merge the checked Dependabot PR — unless main moved meanwhile,
# then re-run the checks instead.
set -eu

# The test merge's first parent is the main commit the checks ran against.
checked_base=$(gh api "repos/$GH_REPO/commits/$MERGE_SHA" --jq '.parents[0].sha')
main_now=$(gh api "repos/$GH_REPO/git/ref/heads/main" --jq '.object.sha')
if [ "$main_now" != "$checked_base" ]; then
  echo "::notice::main moved from $checked_base to $main_now while the checks were running, re-running them"
  gh workflow run dependabot-auto-merge.yml --ref main -f pr="$PR" -f head="$HEAD_SHA"
  exit 0
fi
gh pr merge --squash --match-head-commit "$HEAD_SHA" "$PR"
# Pin the release to the squash commit just merged; if main moves on
# before it runs, that newer commit's own run takes over.
released_sha=$(gh api "repos/$GH_REPO/pulls/$PR" --jq '.merge_commit_sha')
# GITHUB_TOKEN merges do not fire push triggers (recursion protection),
# so dispatch the release explicitly once the merge has landed.
sleep 10
gh workflow run auto-release.yml --ref main -f commit="$released_sha"
