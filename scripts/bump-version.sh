#!/bin/sh
# Automatic BhashaCheck versioning. The deploy workflow runs this on every push
# to main (see .github/workflows/deploy-pages.yml); it can also be run by hand.
#
#   scripts/bump-version.sh [--no-push] [--report] [<sha the push started from>]
#
# What it does, in one of two ways:
#
#   - Normal push: raises the PATCH number of BHASHACHECK_VERSION in
#     web/js/version.js (1.0.1 -> 1.0.2), commits that as "chore(release): v1.0.2",
#     pushes it, and tags that commit v1.0.2.
#
#   - The push itself changed version.js by hand (say you set 1.1.0 for a new
#     feature, or 2.0.0 for a breaking change): that number is the release. It is
#     NOT bumped again - it is only tagged (v1.1.0), if it isn't already.
#
# That is how minor and major versions work: you edit version.js yourself; the
# patch number takes care of itself. A "chore(release):" commit never counts as a
# hand edit, so the bot's own bumps can't be mistaken for one.
#
# --no-push   do everything locally (commit, tag) but push nothing (for testing)
# --report    change nothing; just report the current version and commit (used for
#             manual deploys, which should ship what is there, not bump it)
#
# When run by GitHub Actions it also writes `version` and `sha` to $GITHUB_OUTPUT,
# so the deploy job can ship exactly the commit that carries the version.

set -eu

FILE="web/js/version.js"
BRANCH="${GITHUB_REF_NAME:-main}"
PUSH=1
REPORT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-push) PUSH=0; shift ;;
    --report) REPORT=1; shift ;;
    *) break ;;
  esac
done
BEFORE="${1:-}"

# MAJOR.MINOR.PATCH out of a copy of version.js on stdin ("" if there isn't one).
version_in() {
  sed -n 's/^export const BHASHACHECK_VERSION = "\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)";$/\1/p'
}

die() {
  echo "bump-version: $*" >&2
  exit 1
}

emit() { # emit <version> <sha>
  echo "BhashaCheck v$1 at $2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "version=$1" >> "$GITHUB_OUTPUT"
    echo "sha=$2" >> "$GITHUB_OUTPUT"
  fi
}

[ -f "$FILE" ] || die "$FILE not found - run this from the repository root"
current=$(version_in < "$FILE")
[ -n "$current" ] || die "no BHASHACHECK_VERSION = \"X.Y.Z\" found in $FILE"

if [ "$REPORT" = 1 ]; then
  emit "$current" "$(git rev-parse HEAD)"
  exit 0
fi

# Is the branch already released? A release commit is always made on top of
# everything before it, so if the tip IS one, there is nothing left to release.
# This is what makes a re-run of the workflow for the same push (GitHub's "Re-run
# jobs"), or a second run for a push that an earlier run already covered, a no-op
# instead of a second bump.
released=0
if git log -1 --format=%s | grep -q '^chore(release): '; then
  released=1
fi

# Did this push change version.js by hand? Look at the commits since the push
# began that touched it, ignoring release commits made by this very script.
manual=0
if [ "$released" = 0 ]; then
  case "$BEFORE" in
    "" | 0000000000000000000000000000000000000000) ;;
    *)
      if git cat-file -e "$BEFORE^{commit}" 2>/dev/null; then
        if git log "$BEFORE..HEAD" --format=%s -- "$FILE" | grep -qv '^chore(release): '; then
          manual=1
        fi
      fi
      ;;
  esac
fi

if [ "$released" = 1 ]; then
  next="$current"
  echo "the branch already ends in release commit v$next -> nothing to bump"
elif [ "$manual" = 1 ]; then
  next="$current"
  echo "version.js was set by hand in this push -> keeping v$next, not bumping"
else
  major=${current%%.*}
  rest=${current#*.}
  minor=${rest%%.*}
  patch=${rest#*.}
  patch=$((patch + 1))
  # Skip over any patch number that already has a tag (a stray manual tag, a re-run).
  while git rev-parse -q --verify "refs/tags/v$major.$minor.$patch" > /dev/null; do
    patch=$((patch + 1))
  done
  next="$major.$minor.$patch"

  tmp=$(mktemp)
  sed "s/^export const BHASHACHECK_VERSION = \".*\";\$/export const BHASHACHECK_VERSION = \"$next\";/" "$FILE" > "$tmp"
  cat "$tmp" > "$FILE" # not mv: keep the file's mode
  rm -f "$tmp"
  [ "$(version_in < "$FILE")" = "$next" ] || die "failed to write v$next into $FILE"

  git config user.name > /dev/null || git config user.name "github-actions[bot]"
  git config user.email > /dev/null || git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git add "$FILE"
  git commit -q -m "chore(release): v$next"

  if [ "$PUSH" = 1 ]; then
    # Someone may have pushed to the branch since this run checked it out; if so,
    # put the release commit on top of theirs and try once more.
    if ! git push -q origin "HEAD:refs/heads/$BRANCH"; then
      echo "push was rejected; rebasing the release commit and retrying"
      git pull -q --rebase origin "$BRANCH"
      git push -q origin "HEAD:refs/heads/$BRANCH"
    fi
  fi
fi

# Tag the commit that carries this version (the release commit just made, or the
# commit where it was set by hand) - unless it is tagged already.
git config user.name > /dev/null || git config user.name "github-actions[bot]"
git config user.email > /dev/null || git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
target=$(git log -1 --format=%H -- "$FILE")
if git rev-parse -q --verify "refs/tags/v$next" > /dev/null; then
  echo "tag v$next already exists - leaving it"
else
  git tag -a "v$next" -m "BhashaCheck v$next" "$target"
  if [ "$PUSH" = 1 ]; then
    git push -q origin "refs/tags/v$next"
  fi
fi

emit "$next" "$(git rev-parse HEAD)"
