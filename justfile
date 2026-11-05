# List the recipes.
default:
    @just --list

# Run the tests, each file in its own process.
test *args:
    bun test --isolate {{args}}

# Rebuild web/app.js from web/src.
web:
    bun build web/src/main.ts --outfile web/app.js --target browser
