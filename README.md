EverChat
========

EverChat is a hard fork of [UniiChat](https://github.com/VictorTaelin/uniichat)
([▶ upstream's announcement video](https://x.com/VictorTaelin/status/2108200878553588091)).

**This repo is vibe-coded.** AI agents wrote nearly all of it, and AI
agents reviewed it. Read it, run it and fork it as such: expect bugs.

EverChat is an AI agent with one chat that never ends. There is no "new
chat" button: you talk to the same agent for days, weeks, years, and it
remembers. A cheaper model writes a summary of each message, and merges
the summaries in pairs into a tree. Each request shows the model the whole
chat: recent messages in detail, older ones as fewer, broader lines. The
agent can open any line into the two that it was made from, down to the
original message.

Where the project is
--------------------

We are writing EverChat again, in this repository. The new program is not
here yet, so there is nothing to run at the top level.

- [AGENTS.md](AGENTS.md) says where the rewrite goes, and why.
- [GLOSSARY.md](GLOSSARY.md) is the dictionary of the project's names.
- [docs/schema.html](docs/schema.html) is the design of the database.
- [docs/memory.html](docs/memory.html) explains the memory.
- `ref/` holds the old code. It works, and it is for reading only.
  [ref/README.md](ref/README.md) says how to run it: give its commands from
  inside `ref/`. The git tag `before-rewrite` marks the last commit before
  the old code moved there.

Commands
--------

You need [Bun](https://bun.sh) and [just](https://github.com/casey/just).

    just test                        # the tests of the new code
    cd ref && just test              # the tests of the old code

License
-------

Apache-2.0 (LICENSE). Copyright 2026 Higher Order Company.
