# List the recipes.
default:
    @just --list

# Run the tests of the new code, each file in its own process. The tests of
# the old code are not part of this run (bunfig.toml): `cd ref && just test`.
test *args:
    bun test --isolate {{args}}

# Check the types, one program for each package: the core alone, with no Bun
# and no Node types (its guard); the core's tests, with the Bun types; the
# packages openai, sqlite, codemode and local, their tests too, with the Bun
# types; the tools, but tools/golden.ts, with the Bun types
# (tools/tsconfig.json). Then the boundaries of the packages, which the types
# do not see: their imports and their manifests (tools/graph.ts). Last, that
# no file of the tree holds a word of the owner's list, which lives outside
# the repository; with no list on this machine it checks nothing
# (tools/words.ts).
check:
    bunx tsc --noEmit -p packages/core
    bunx tsc --noEmit -p packages/core/tsconfig.test.json
    bunx tsc --noEmit -p packages/openai
    bunx tsc --noEmit -p packages/sqlite
    bunx tsc --noEmit -p packages/codemode
    bunx tsc --noEmit -p packages/local
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

# Build EverChat as one executable, `everchat`. The sandbox's worker thread
# is the second entrypoint (packages/local/src/worker.ts says why).
build:
    bun build --compile packages/local/src/main.ts packages/local/src/worker.ts --outfile everchat

# Build the executable, and run the tests of the whole program on it.
test-build: build
    EVERCHAT_BIN=./everchat bun test --isolate packages/local/tests/main.test.ts packages/local/tests/pipe.test.ts packages/local/tests/inspect.test.ts

# The full check: the types, the tests from source, and the tests of the
# whole program on the executable.
full: check test test-build

# The scoped check, for the files of one change: the types, and the test
# files given.
scoped +tests: check
    bun test --isolate {{tests}}
