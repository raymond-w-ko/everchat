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
done yet: `just run` starts it from its source.

- [docs/design.md](docs/design.md) says where the rewrite goes, and
  [docs/history.md](docs/history.md) says why.
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
    just run serve                   # the host and its page, on this machine

`everchat serve` (`just run serve`) is for development: it serves the
reference client's page and the chats of one local tenant, in `serve.db` in
the home, on 127.0.0.1 port 4681 (`--port <n>`). It prints the page's
address. Run one for a home. The page's list of chats is the browser's, for
the address's origin: a start on another port (`--port 0` too, which takes a
new one at each start) shows an empty list, and the chats stay in the home's
database.

License
-------

Apache-2.0 (LICENSE). Copyright 2026 Higher Order Company.

`packages/codemode/src/pi` and `packages/core/src/codemode` hold code of
`pi-codemode` (MIT; see the `LICENSE.md` there).
