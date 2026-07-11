# Workflow scripts

Shell logic for the workflows in `.github/workflows/`, kept out of the
YAML so it can be read, reviewed and tested as plain POSIX sh.

Layout convention:

- Each subdirectory is named after the workflow file that runs its
  scripts (`auto-release/` belongs to `auto-release.yml`, and so on).
- Scripts used by more than one workflow live at the top level
  (currently none).

GitHub does not allow the same grouping for the workflow YAML files
themselves — they must sit directly in `.github/workflows/`.
