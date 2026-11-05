# AGENTS.md

## What this project is

EverChat is a hard fork of UniiChat.

- Upstream: https://github.com/VictorTaelin/uniichat
- Our fork: https://github.com/raymond-w-ko/everchat

A hard fork means we do not plan to merge back into upstream. We also do not
plan to track upstream closely. We can pull an upstream change when it is
useful. We do not have to.

EverChat is an LLM agent harness. Its core idea: the chat itself is the memory.
There is one chat that never ends. A cheap model compresses the log into a tree
of summaries, and the agent zooms into that tree when it needs detail.

## Tools

- [Bun](https://bun.sh) is the runtime, package manager, test runner, and
  bundler. Do not use Node, npm, yarn, or pnpm.
- [just](https://github.com/casey/just) is the command runner. Put common
  tasks in the `justfile` as recipes.

## The original concept

The original design document is
[docs/references/optchat.md](docs/references/optchat.md). It was downloaded from
upstream. Read it before you make design changes.

Treat it as the starting point, not as a spec we must follow. When our design
differs from it, write down the difference and the reason.

## Why we forked

We hard fork because upstream is unlikely to change. The upstream author is
hard at work on [Bend2](https://github.com/bendlang/bend) and Bend3 (still in
incubation), not on UniiChat.

The upstream author also often releases good ideas but does not take outside
feedback or improvements. So we polish the idea ourselves.

Our goal is to make EverChat "battle hardened" and fit our own needs:

- Correct under failure: crashes, partial writes, network errors, bad model
  output.
- Tested: each fix comes with a test that fails without the fix.
- Clear: code and docs that a new reader can follow.
- Shaped to our use, even when that means we diverge from upstream.
