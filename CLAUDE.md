# CLAUDE.md

Project conventions for Claude Code. These instructions are mandatory and override
default behavior — including the default of adding a Claude co-author trailer to commits.

## Branching

- **Every** change — new feature, bug fix, cleanup, refactor, anything — starts on its
  own branch. Never commit such work directly to `main`.
- Branch off **`main`** (always branch from an up-to-date `main`).
- The branch name is prefixed with **`feature/`**.
- After the prefix, the name is exactly **three words separated by `-`**, chosen to
  describe the goal of the branch as precisely as possible.
- When possible, reuse the wording from the planned commit message.

Examples: `feature/fix-button-spacing`, `feature/add-retry-backoff`.

## Commits & pushing (on the feature branch)

- Commit freely — every meaningful change can be its own commit.
- **Push after every commit.** (No extra consent is needed for these feature-branch
  pushes; the consent rule below applies only to the squash commit.)

### Commit message style

- Headline in the **imperative mood**, starting with a **capital letter**, short but
  clear and easy to understand (the git/GitHub recommended style).
- **Do NOT add any indication that the commit was co-authored by Claude.** No
  `Co-Authored-By: Claude ...` trailer, no "Generated with Claude" line, nothing.
- Keep the body (when used) focused on what and why; wrap reasonably.

## Merging back to `main`

1. **Rebase** the feature branch on the latest `main`.
2. **Squash merge** the feature branch into `main`.
3. The squash commit message follows the same style rules above (imperative, capital
   first letter, no Claude attribution).
4. The squash message **summarizes all the commits** from the merged branch into one
   coherent message that captures everything relevant — not just the last commit.
5. **After creating the squash commit, get explicit user consent before pushing it.**
   Do not push the squashed `main` automatically.

## Keeping this file accurate

- If the user clearly wants something different from what is written here, **offer** to
  update this CLAUDE.md.
- Only make the change after the user **explicitly agrees** to it.

## Repository context

- Working remote is **`custom-origin`** (`git@github.com:joldjunge/claude-auto-retry.git`);
  `origin` is the upstream `cheapestinference/claude-auto-retry`. `main` tracks
  `custom-origin/main`.
