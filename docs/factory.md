# How the factory uses EverChat

This file holds how the factory runs EverChat next to the other harnesses; the root `AGENTS.md` keeps the rule, under "How EverChat will be used".

In the local use, EverChat is a person's main assistant, a chief of staff.
There it has no other harness to hand work to, so it uses its own subagents a
lot.

In the factory, EverChat runs next to the `claude` (Claude Code) and `codex`
harnesses, as a drop-in for them [Q56]. There it is one agent with a long
memory that hands coding work to the mature harnesses, and does not do all of
that work itself. So do not build what those harnesses already do well before
the core is solid. Background shells and monitors come later, for the local
use only, after the wake-ups [Q54].

The factory uses all three in the same way:

- It runs each harness interactively, in a real PTY (pseudo-terminal: the
  operating system's stand-in for a terminal). A Ghostty terminal, compiled to
  WASM, shows the screen.
- It sends commands to the harness, as a person at the keyboard would.
- It listens to the harness's hooks. A hook is a command that the harness runs
  at a fixed point, for example when a turn starts, when a tool runs, or when a
  turn ends. Hooks tell the factory what the harness is doing.

The factory has written down what it needs from a harness: the launch, the
hooks, the shell and the transcript. Read that interface before you design a
part that the factory touches.

EverChat must be able to meet this interface. It must also stay a good program
when it runs alone, with no factory.
