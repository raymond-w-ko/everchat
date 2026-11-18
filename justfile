# The default time limit of each test case and hook, in milliseconds, for
# each recipe that runs `bun test`. It is there to end a case that hangs; it
# is no bound of speed. Bun's own default, 5 s, was too short on a loaded
# machine: cases that take 1 to 3 s on an idle one passed 5 s. A case that
# proves a time keeps its own `expect` or its own limit (the third argument
# of `test`), which wins over this one. A caller's own `--timeout`, given
# after the recipe's name, comes after this one and wins too.
test_timeout := "20000"

# List the recipes.
default:
    @just --list

# Run the tests of the new code, each file in its own process. The tests of
# the old code are not part of this run (bunfig.toml): `cd ref && just test`.
test *args:
    bun test --isolate --timeout {{test_timeout}} {{args}}

# Check the types, one program for each package: the core alone, with no Bun
# and no Node types (its guard); the core's tests, with the Bun types; the
# packages openai, sqlite, codemode and local, their tests too, with the Bun
# types; the server alone, with no Bun and no Node types (its guard), and the
# server's tests, with the Bun types; the same two for mcp, the client of
# functions from outside, and for wakeups, the wake-ups by time; the tools,
# but tools/golden.ts, with the Bun types (tools/tsconfig.json). Then the
# boundaries of the packages, which the types do not see: their imports and
# their manifests (tools/graph.ts).
# Last, that no file of the tree holds a word of the owner's list, which lives
# outside the repository; with no list on this machine it checks nothing
# (tools/words.ts).
check:
    bunx tsc --noEmit -p packages/core
    bunx tsc --noEmit -p packages/core/tsconfig.test.json
    bunx tsc --noEmit -p packages/openai
    bunx tsc --noEmit -p packages/sqlite
    bunx tsc --noEmit -p packages/codemode
    bunx tsc --noEmit -p packages/local
    bunx tsc --noEmit -p packages/server
    bunx tsc --noEmit -p packages/server/tsconfig.test.json
    bunx tsc --noEmit -p packages/mcp
    bunx tsc --noEmit -p packages/mcp/tsconfig.test.json
    bunx tsc --noEmit -p packages/wakeups
    bunx tsc --noEmit -p packages/wakeups/tsconfig.test.json
    bunx tsc --noEmit -p tools
    bun tools/graph.ts
    bun tools/words.ts

# Turn on the commit hook (tools/hooks/commit-msg) in this clone: no commit
# message holds a word of the owner's list. Git does not carry the setting to
# another clone, so each clone runs this once.
hooks:
    git config core.hooksPath tools/hooks

# Run EverChat from its source, in this terminal.
run *args:
    bun packages/local/src/main.ts {{args}}

# Make a sample chat in a new home, with no model, to look at in the
# inspector (tools/sample.ts): `just sample /tmp/sample`, and then
# `EVERCHAT_HOME=/tmp/sample just run inspect`.
sample home turns="200":
    bun tools/sample.ts {{home}} {{turns}}

# Run the example MCP server (tools/mcpexample.ts): on stdio, or over HTTP on
# 127.0.0.1 with `--port <n>`. Its head comment says how a chat names it.
mcp-example *args:
    bun tools/mcpexample.ts {{args}}

# Build EverChat as one executable, `everchat`. The sandbox's worker thread
# is the second entrypoint (packages/local/src/worker.ts says why).
build:
    bun build --compile packages/local/src/main.ts packages/local/src/worker.ts --outfile everchat

# Build the executable, and run the tests of the whole program on it.
test-build: build
    EVERCHAT_BIN=./everchat bun test --isolate --timeout {{test_timeout}} packages/local/tests/main.test.ts packages/local/tests/pipe.test.ts packages/local/tests/inspect.test.ts packages/local/tests/serve.test.ts

# The servers of the MariaDB checks: the output paths of `mariadb_1011.server`
# (10.11.18) and `mariadb_118.server` (11.8.9) at nixpkgs
# d5cc6833999746cffdfe0598f7bc801a57b887a9, for x86_64-linux. `test-mariadb`
# fetches them from the binary cache by these paths, with no evaluation of
# nixpkgs and no flake.
mariadb_1011 := "/nix/store/cz7csf2phhwnc2nwh9x54zkb3zncj6q0-mariadb-server-10.11.18"
mariadb_118 := "/nix/store/dzxs9nkr6zyqi580gbcivncpz2n7bixl-mariadb-server-11.8.9"

# With no `nix`, on another system than x86_64-linux, or when a path cannot
# be fetched, it fails with a line that says which: the full check never
# passes with the servers left out. tools/mariadb.ts starts each server on a
# socket in the test's temporary directory, and stops it.
# The tests on private MariaDB servers, of 10.11 and of 11.8.
test-mariadb:
    @command -v nix > /dev/null || { echo "test-mariadb: nix is not on the PATH: the MariaDB servers of the checks come from Nix." >&2; exit 1; }
    @[ "$(uname -m)-$(uname -s)" = "x86_64-Linux" ] || { echo "test-mariadb: the pinned MariaDB servers are for x86_64-linux, and this system is $(uname -m)-$(uname -s)." >&2; exit 1; }
    @nix --extra-experimental-features nix-command build --no-link {{mariadb_1011}} {{mariadb_118}} || { echo "test-mariadb: nix could not fetch the pinned MariaDB servers from the binary cache." >&2; exit 1; }
    EVERCHAT_MARIADB="{{mariadb_1011}} {{mariadb_118}}" bun test --isolate --timeout {{test_timeout}} tools/mariadb.test.ts

# The full check: the types, the tests from source, the tests of the whole
# program on the executable, and the tests on MariaDB.
full: check test test-build test-mariadb

# The scoped check, for the files of one change: the types, and the test
# files given.
scoped +tests: check
    bun test --isolate --timeout {{test_timeout}} {{tests}}
