#!/usr/bin/env sh
# Resolve the test merge commit the checks run on. A dispatch retry
# re-validates the PR and exits without outputs when it has become moot.
set -eu

if [ "$GITHUB_EVENT_NAME" = "pull_request" ]; then
  pr=$PR_EVENT_NUMBER
  merge_sha=$RUN_MERGE_SHA
  head_sha=$PR_EVENT_HEAD
else
  # GitHub recomputes the test merge asynchronously, hence the polling.
  mergeable=null
  json=
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    json=$(gh api "repos/$GH_REPO/pulls/$PR_DISPATCH")
    mergeable=$(echo "$json" | jq -r '.mergeable')
    [ "$mergeable" != "null" ] && break
    sleep 5
  done
  if [ "$(echo "$json" | jq -r '.user.login')" != "dependabot[bot]" ]; then
    echo "::error::PR #$PR_DISPATCH was not created by Dependabot"
    exit 1
  fi
  if [ "$(echo "$json" | jq -r '.state')" != "open" ]; then
    echo "PR #$PR_DISPATCH is no longer open, nothing to do"
    exit 0
  fi
  if [ "$(echo "$json" | jq -r '.head.sha')" != "$EXPECTED_HEAD" ]; then
    echo "PR #$PR_DISPATCH got new commits, the pull_request run for them takes over"
    exit 0
  fi
  if [ "$mergeable" != "true" ]; then
    echo "PR #$PR_DISPATCH is not cleanly mergeable, leaving it to Dependabot to rebase"
    exit 0
  fi
  pr=$PR_DISPATCH
  merge_sha=$(echo "$json" | jq -r '.merge_commit_sha')
  head_sha=$EXPECTED_HEAD
fi

# A .github/-only PR cannot affect anything the checks read.
files=$(gh api "repos/$GH_REPO/pulls/$pr/files" --paginate --jq '.[].filename')
outside_ci=$(printf '%s\n' "$files" | grep -v '^\.github/' || true)
if [ -z "$outside_ci" ]; then
  echo "PR #$pr only touches .github/, skipping the checks"
  skip_check=true
else
  skip_check=false
fi

{
  echo "pr=$pr"
  echo "merge_sha=$merge_sha"
  echo "head_sha=$head_sha"
  echo "skip_check=$skip_check"
} >> "$GITHUB_OUTPUT"
