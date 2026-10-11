#!/bin/sh
# OWNH installer: curl -fsSL https://ownh.org/install.sh | sh
#
# Clones OWNH into $OWNH_HOME (default ~/.ownh) and links the `ownh` command
# into $OWNH_BIN (default ~/.local/bin). Running it again, or `ownh update`,
# updates the clone.
# Needs git and Node.js 22.13 or newer; no npm packages, no root.
#
# Uninstall: rm -rf ~/.ownh ~/.local/bin/ownh
#
# Everything runs inside main(), called on the last line, so a download cut
# off part way runs nothing.

main() {
  set -eu
  repo="${OWNH_REPO:-https://github.com/wistrand/ownh.git}"
  home="${OWNH_HOME:-$HOME/.ownh}"
  bindir="${OWNH_BIN:-$HOME/.local/bin}"

  say() { printf '%s\n' "$*"; }
  fail() { printf 'ownh install: %s\n' "$*" >&2; exit 1; }

  command -v git >/dev/null 2>&1 || fail "git is required"
  command -v node >/dev/null 2>&1 || fail "Node.js 22.13 or newer is required (https://nodejs.org)"
  node -e '
    const [a, b] = process.versions.node.split(".").map(Number);
    process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1);
  ' || fail "Node.js 22.13 or newer is required (found $(node --version))"

  if [ -d "$home/.git" ]; then
    say "Updating OWNH in $home"
    git -C "$home" pull --ff-only --quiet ||
      fail "could not update $home (local changes, or history rewritten upstream); remove it and run this again: rm -rf $home"
  elif [ -e "$home" ]; then
    fail "$home exists and is not an OWNH clone; set OWNH_HOME to install elsewhere"
  else
    say "Installing OWNH into $home"
    git clone --quiet --depth 1 "$repo" "$home" || fail "could not clone $repo"
  fi

  mkdir -p "$bindir"
  target="$home/bin/ownh.js"
  link="$bindir/ownh"
  # Replace only our own link; never an unrelated program or a directory.
  if [ -L "$link" ]; then
    current=$(readlink "$link")
    [ "$current" = "$target" ] || fail "$link already points to $current; remove it or set OWNH_BIN"
  elif [ -e "$link" ]; then
    fail "$link already exists and is not an OWNH link; remove it or set OWNH_BIN"
  fi
  ln -sfn "$target" "$link"
  say "Linked $link"

  case ":$PATH:" in
    *":$bindir:"*) ;;
    *) say "Add $bindir to your PATH, for example:  export PATH=\"$bindir:\$PATH\"" ;;
  esac
  say "Done. Try: ownh index --db acme.db ~/src/your-repo"
}

main "$@"
