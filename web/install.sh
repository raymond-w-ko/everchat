#!/bin/sh
# The installer for everchat, the EverChat terminal. There is no release
# yet, so it installs nothing: it says how to build from source and fails.
# (Upstream's version piped upstream's installer into sh; see ISSUES.md.)
set -eu
cat >&2 <<'EOF'
everchat: there is no released build to install yet.
Build it from source instead (needs bun, https://bun.sh):

  git clone https://github.com/raymond-w-ko/everchat
  cd everchat
  bun build --compile src/term.ts --outfile everchat
EOF
exit 1
