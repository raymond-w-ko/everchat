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
# packages openai, sqlite, mariadb, codemode and local, their tests too, with
# the Bun types; the server alone, with no Bun and no Node types (its guard),
# and the server's tests, with the Bun types; the same two for mcp, the
# client of functions from outside, and for wakeups, the wake-ups by time;
# the tools, but tools/golden.ts, with the Bun types (tools/tsconfig.json).
# Then the boundaries of the packages, which the types do not see: their
# imports and their manifests (tools/graph.ts).
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
    bunx tsc --noEmit -p packages/mariadb
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

# The tests of the whole program: the files that `test-build` runs on the
# executable (and `alone` too, for one of them).
build_tests := "packages/local/tests/main.test.ts packages/local/tests/pipe.test.ts packages/local/tests/inspect.test.ts packages/local/tests/serve.test.ts"

# Build the executable, and run the tests of the whole program on it.
test-build: build
    EVERCHAT_BIN=./everchat bun test --isolate --timeout {{test_timeout}} {{build_tests}}

# The servers of the MariaDB checks: the output paths of `mariadb_1011.server`
# (10.11.18) and `mariadb_118.server` (11.8.9) at nixpkgs
# d5cc6833999746cffdfe0598f7bc801a57b887a9, for x86_64-linux. `test-mariadb`
# fetches them from the binary cache by these paths, with no evaluation of
# nixpkgs and no flake.
mariadb_1011 := "/nix/store/cz7csf2phhwnc2nwh9x54zkb3zncj6q0-mariadb-server-10.11.18"
mariadb_118 := "/nix/store/dzxs9nkr6zyqi580gbcivncpz2n7bixl-mariadb-server-11.8.9"

# With no `nix`, on another system than x86_64-linux, or when a path cannot
# be fetched, it fails with a line that says which: the full check never
# passes with the servers left out. packages/mariadb/tests/server.ts starts
# each server on a socket in the test's temporary directory, and stops it.
# The tests on private MariaDB servers, of 10.11 and of 11.8.
test-mariadb: mariadb-servers
    EVERCHAT_MARIADB="{{mariadb_1011}} {{mariadb_118}}" bun test --isolate --timeout {{test_timeout}} packages/mariadb

# The guards of the MariaDB servers, for `test-mariadb` and `alone`: `nix`
# is there, the system is x86_64-linux, and both pinned paths are fetched.
[private]
mariadb-servers:
    @command -v nix > /dev/null || { echo "test-mariadb: nix is not on the PATH: the MariaDB servers of the checks come from Nix." >&2; exit 1; }
    @[ "$(uname -m)-$(uname -s)" = "x86_64-Linux" ] || { echo "test-mariadb: the pinned MariaDB servers are for x86_64-linux, and this system is $(uname -m)-$(uname -s)." >&2; exit 1; }
    @nix --extra-experimental-features nix-command build --no-link {{mariadb_1011}} {{mariadb_118}} || { echo "test-mariadb: nix could not fetch the pinned MariaDB servers from the binary cache." >&2; exit 1; }

# The full check: the types, the tests from source, the tests of the whole
# program on the executable, and the tests on MariaDB.
full: check test test-build test-mariadb

# The scoped check, for the files of one change: the types, and the test
# files given.
scoped +tests: check
    bun test --isolate --timeout {{test_timeout}} {{tests}}

# The full check of one test file, given by its path from the root: its
# tests as `just full` runs them, with no check of the types. The landing's
# sweep runs a file that failed in the full check by it, once, to tell a
# flake from a real red. A plain `bun test` of the file is not the same: a
# file of packages/mariadb runs here on the two MariaDB servers (after the
# guards of `test-mariadb`), where a plain run skips the cases on a server;
# and a file of `test-build` runs here from the source and then, when that
# passed, on the executable, built for it, where a plain run tries the
# source only. The full check gives a file its tier by the text of its path,
# so the recipe takes that text only: it refuses, before any test, a path
# that holds a control character (a byte below 0x20, or 0x7f: such a name
# would put lines of its own into Bun's output), and, after one leading
# `./` is taken off, a path that is empty, begins or ends with `/`, or has
# a part that is empty, `.` or `..`, and one that names no regular file (a
# directory runs several files); it makes no path normal. It takes exactly
# one argument (more are refused here, not read by `just` as recipes).
# Each line that the recipe writes is a fixed text with no byte of the
# argument (the count of the arguments is its one value): one line on the
# standard error that begins `alone:`, never of the form of Bun's results;
# a refusal says its rule. The code is 0 only when each run of Bun ended 0
# and passed one case or more: Bun's JUnit report, in a file under the
# temporary directory
# that the count removes, gives the count, and a report that cannot be read
# counts as no case passed. The path goes to `bun test` as one argument,
# behind `./`, so that it names that file and no other.
[no-exit-message]
[positional-arguments]
alone *args:
    #!/usr/bin/env sh
    refuse() { printf 'alone: %s\n' "$1" >&2; exit 2; }
    [ "$#" -eq 1 ] || refuse "it takes one argument, the path of a test file from the root, and got $#"
    given=$1
    # The control characters: each byte from 0x01 to 0x1f, and 0x7f.
    control=$(printf '\001\002\003\004\005\006\007\010\011\012\013\014\015\016\017\020\021\022\023\024\025\026\027\030\031\032\033\034\035\036\037\177')
    case $given in
      *["$control"]*) refuse "the path holds a control character (a byte below 0x20, or 0x7f)" ;;
    esac
    path=${given#./}
    case $path in
      "") refuse "the path is empty" ;;
      /*) refuse "the path begins with /: give it from the root" ;;
      */) refuse "the path ends with /" ;;
    esac
    case /$path/ in
      *//* | */./* | */../*) refuse "the path has a part that is empty, . or .." ;;
    esac
    [ -f "./$path" ] || refuse "the path names no regular file"
    report=${TMPDIR:-/tmp}/everchat-alone-$$.xml
    # One run of Bun on the file; `$1` names the run in the line of no case passed.
    run() {
      : > "$report" || refuse "cannot write the count's report in the temporary directory"
      bun test --isolate --timeout {{test_timeout}} --reporter=junit --reporter-outfile="$report" "./$path"
      code=$?
      passed=$(bun -e 'const fs = require("fs"); const f = process.argv[1]; let n = 0; try { const m = /<testsuites\b[^>]*>/.exec(fs.readFileSync(f, "utf8"))[0]; const num = (re) => Number(re.exec(m)[1]); n = num(/\stests="(\d+)"/) - num(/\sfailures="(\d+)"/) - num(/\sskipped="(\d+)"/) } catch { n = 0 } fs.rmSync(f, { force: true }); console.log(n > 0 ? n : 0)' "$report")
      [ "$code" -eq 0 ] || exit "$code"
      case $passed in "" | *[!0-9]*) passed=0 ;; esac
      [ "$passed" -gt 0 ] || { printf 'alone: no case passed%s\n' "$1" >&2; exit 1; }
    }
    case $path in
      packages/mariadb/*)
        {{quote(just_executable())}} --justfile {{quote(justfile())}} --working-directory {{quote(justfile_directory())}} mariadb-servers || exit 1
        EVERCHAT_MARIADB="{{mariadb_1011}} {{mariadb_118}}"
        export EVERCHAT_MARIADB
        run ""
        exit 0
        ;;
    esac
    run ""
    for built in {{build_tests}}; do
      if [ "$path" = "$built" ]; then
        {{quote(just_executable())}} --justfile {{quote(justfile())}} --working-directory {{quote(justfile_directory())}} build || exit 1
        EVERCHAT_BIN=./everchat
        export EVERCHAT_BIN
        run " on the executable"
      fi
    done
