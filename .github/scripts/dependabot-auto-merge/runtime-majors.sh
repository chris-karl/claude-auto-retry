#!/usr/bin/env sh
# Emit runtime_majors: the shipped npm dependencies this PR bumps by a major
# version, comma-separated (empty = safe to merge). CI never loads node-pty,
# so a major of a production dependency is left to a human; dev dependencies,
# lockfile-only updates and action bumps merge on green.
set -eu

majors=$(printf '%s' "${UPDATED_DEPENDENCIES:-[]}" | jq -r '
  [ .[]
    | select(((.packageEcosystem // "") | test("npm"))
             and .dependencyType == "direct:production"
             and .updateType == "version-update:semver-major")
    | .dependencyName
  ] | join(", ")')
echo "runtime_majors=$majors" >> "$GITHUB_OUTPUT"
