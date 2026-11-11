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

# Build EverChat as one executable, `everchat`.
build:
    bun build --compile src/main.ts --outfile everchat
