#!/bin/sh
# Installs everchat, the EverChat terminal, as released: this runs the
# official installer (https://uniichat.com/install.sh), which says what it
# installs and where. To run everchat from this source instead: bun src/term.ts.
# Once a day everchat asks bend-lang.com for the latest version (its version,
# OS and CPU type, whether this computer ever self-hosted, nothing else);
# EVERCHAT_NO_TELEMETRY=1 turns that off.
set -eu
curl -fsSL https://uniichat.com/install.sh | sh
