#!/usr/bin/env bash
# Run git as Claude with the Spiro-12 GitHub token, without changing any global config.
# Commits are authored "Claude <noreply@anthropic.com>" (GitHub blocks pushes that expose Spiro's private email),
# and pushes use the Spiro-12 account (the Mac's active gh account is read-only on this repo).
# Usage: scripts/git-as-claude.sh commit -m "..."   |   scripts/git-as-claude.sh push -u origin <branch>
set -euo pipefail
export GIT_AUTHOR_NAME=Claude GIT_AUTHOR_EMAIL=noreply@anthropic.com
export GIT_COMMITTER_NAME=Claude GIT_COMMITTER_EMAIL=noreply@anthropic.com
exec git -c credential.helper= \
  -c "credential.helper=!f() { echo username=Spiro-12; echo password=\$(gh auth token -u Spiro-12); }; f" "$@"
