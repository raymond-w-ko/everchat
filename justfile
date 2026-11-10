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
