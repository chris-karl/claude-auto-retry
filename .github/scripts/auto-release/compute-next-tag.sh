#!/usr/bin/env sh
# Print the next release tag: vYYYY.M.N, with N counting this month's
# releases from 0. No zero padding, so the version stays valid semver.
set -eu

month=$(TZ=Europe/Berlin date +%Y.%m | sed 's/\.0\([0-9]\)$/.\1/')
last=$(git tag -l "v$month.*" | sort -V | tail -n 1)
if [ -n "$last" ]; then
  n=$(( ${last##*.} + 1 ))
else
  n=0
fi
echo "v$month.$n"
