#!/bin/sh
# Installs unii, the UniiChat terminal, as released: this runs the
# official installer (https://uniichat.com/install.sh), which says what it
# installs and where. To run unii from this source instead: bun src/term.ts.
# Once a day unii asks bend-lang.com for the latest version (its version,
# OS and CPU type, whether this computer ever self-hosted, nothing else);
# UNII_NO_TELEMETRY=1 turns that off.
set -eu
curl -fsSL https://uniichat.com/install.sh | sh
