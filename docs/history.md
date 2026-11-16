# History

This file holds the original concept, why we forked, the rewrite in place, and what is out of scope.

## A hard fork

A hard fork means we do not plan to merge back into upstream. We also do not
plan to track upstream closely. We can pull an upstream change when it is
useful. We do not have to.

## The original concept

The original design document is
[docs/references/optchat.md](references/optchat.md). It was downloaded from
upstream. Read it before you make design changes.

Treat it as the starting point, not as a spec we must follow. When our design
differs from it, write down the difference and the reason.

Where `docs/design.md` differs from the original concept or from the research
in `docs/research/`, it holds.

When the upstream code and this document disagree, the code is canonical. The
code came later, and the upstream author uses it every day. So treat the
document as a guide to the intent, and the code as the truth about the
behavior.

## Why we forked

We hard fork because upstream is unlikely to change. The upstream author is
hard at work on [Bend2](https://github.com/bendlang/bend) and Bend3 (still in
incubation), not on UniiChat.

The upstream author also often releases good ideas but does not take outside
feedback or improvements. So we polish the idea ourselves.

## A rewrite, in place

We write a new, clean, modular implementation in this repository. We do not
refactor the old code step by step.

- Importing the sessions of other harnesses (Claude Code, Codex) is out of
  scope. Do not port the old import code.
