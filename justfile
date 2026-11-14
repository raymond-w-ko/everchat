# List the recipes.
default:
    @just --list

# Run the tests of the new code, each file in its own process. The tests of
# the old code are not part of this run (bunfig.toml): `cd ref && just test`.
test *args:
    bun test --isolate {{args}}

# Check the types of the new code.
check:
    bunx tsc --noEmit -p .

# Run EverChat from its source, in this terminal.
run *args:
    bun src/main.ts {{args}}

# Build EverChat as one executable, `everchat`. The sandbox's worker thread
# is the second entrypoint (src/worker.ts says why).
build:
    bun build --compile src/main.ts src/worker.ts --outfile everchat

# Build the executable, and run the tests of the whole program on it.
test-build: build
    EVERCHAT_BIN=./everchat bun test --isolate tests/main.test.ts tests/pipe.test.ts tests/inspect.test.ts
