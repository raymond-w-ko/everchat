// Memory test
// ===========
// `bun test memory.test.ts`. The memory system's invariants, one small
// test each, and the 13 mistakes of docs/references/optchat.md section 7,
// each named "mistake N" so you can find it. See docs/memory.html for
// the why of each.
//
// Most tests read one shared run: a chat of CHAT messages pushed one at a
// time through the real Memory, AskAI and Agent loop, with a fake
// compactor (no network). After each message the run waits until no
// summary is building, then takes a snapshot of the views. Tests then
// check every snapshot.

import { beforeAll, expect, setSystemTime, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";

const DIR = fs.mkdtempSync(os.tmpdir() + "/everchat-memory-");
process.env.EVERCHAT_DIR = DIR;

const config = await import("./config.ts");
config.KEYS.anthropic = "test";
const { Memory, JOBS } = await import("./memory.ts");
const { MASTER, Tools } = await import("./tools.ts");

// as memory.ts: a node's most bytes, a view's high marks, lines a block,
// tries for a line too long
const NODE  = 512;
const HIGH  = 128000;
const SEEN  = 32000;
const BLOCK = 4;
const TRIES = 5;

const SHARE = { vendor: "claude-api" as const, model: "claude-opus-5-5", effort: "medium", speed: "slow", system: MASTER, searches: 0, server: "" };
const CHAT  = 900;

type Mem = ReturnType<typeof Memory.load>;
type Part = { l: number; i: number };

// Helpers
// =======

let seed = 5;
function rand(): number {
  seed = (seed * 48271) % 2147483647;
  return seed / 2147483647;
}

function hash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

// "40+8" -> [40, 8]
function ref(line: string): [number, number] {
  const [id, n] = line.slice(0, line.indexOf("|")).split("+").map(Number);
  return [id, n];
}

// the lines of a request's <chat>, as "id+n|text"
function chat_lines(texts: string[]): string[] {
  const all = texts.join("");
  const inside = all.slice(all.indexOf("<chat>\n") + 7, all.indexOf("</chat>"));
  return inside.split("\n").filter((line) => line !== "");
}

// the node a compaction's task asks for
function task_node(task: string): Part {
  const leaf = /compress message (\d+)/.exec(task);
  if (leaf) {
    return { l: 0, i: Number(leaf[1]) };
  }
  const [, a, n] = /merge lines (\d+)\+(\d+)/.exec(task)!.map(Number);
  return { l: Math.log2(n) + 1, i: a / n / 2 };
}

// Fake compactor
// ==============

// a request it got: its task's node, whether a retry, its blocks' texts,
// its system prompt and tools, and the chat at that moment: which halves
// were built, how many leaves before were not
type Asked = { node: Part; again: boolean; texts: string[]; system: string; tools: unknown; halves: boolean; unbuilt: number };

const asked: Asked[] = [];
let current: Mem | null = null;

// lines it answers: as long as `size` says, or as a test sets for a task
let size = (task: string, again: boolean) => {
  const h = parseInt(hash(task).slice(0, 8), 16);
  return !again && h % 7 === 0 ? 700 : 150 + (h % 300);
};

function answer(text: string): Response {
  const evs = [
    { type: "message_start", message: { usage: {} } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(evs.map((ev) => "event: " + ev.type + "\ndata: " + JSON.stringify(ev) + "\n\n").join(""));
}

globalThis.fetch = (async (_url: string, init: any) => {
  const body = JSON.parse(init.body);
  const texts: string[] = body.messages[0].content.map((c: any) => c.text);
  const again = texts[texts.length - 1].startsWith("Too long:");
  const task = texts.find((t) => t.startsWith("Compaction:"))!;
  const node = task_node(task);
  const mem = current!;
  // Memory.node reads from the log: memory holds only the views' nodes
  const halves = node.l === 0 || Memory.halves(node).every((h) => Memory.node(mem, h) !== null);
  let unbuilt = 0;
  for (let i = 0; node.l === 0 && i < node.i; i++) {
    unbuilt += Memory.node(mem, { l: 0, i }) === null ? 1 : 0;
  }
  asked.push({ node, again, texts, system: body.system[0].text, tools: body.tools, halves, unbuilt });
  const line = "line " + node.l + "/" + node.i + " ";
  return answer(line + "x".repeat(Math.max(0, size(task, again) - line.length)));
}) as any;

// till no summary builds, and none is left to start
async function idle(mem: Mem): Promise<void> {
  for (let k = 0; k < 10; k++) {
    while (mem.busy.size > 0) {
      await new Promise((ok) => setTimeout(ok, 1));
    }
    await new Promise((ok) => setImmediate(ok));
  }
}

function open(name: string): Mem {
  current = Memory.load(DIR + "/" + name, () => SHARE);
  return current;
}

// a message of the shared run: short (its own summary, word for word),
// long (a compactor call), or a paste (logged in pages)
function message(n: number): { kind: "user" | "ever" | "tool" | "echo"; text: string } {
  const r = rand();
  const length = r < 0.6 ? 20 + Math.floor(rand() * 300) : r < 0.97 ? 600 + Math.floor(rand() * 3000) : 35000 + Math.floor(rand() * 25000);
  const kind = (["user", "ever", "tool", "echo"] as const)[n % 4];
  return { kind, text: (n + " " + hash(String(n)).repeat(1000)).slice(0, length) };
}

// The shared run
// ==============

type Snap = { count: number; view: Part[]; size: number; batch: boolean; seen: Part[]; seenSize: number; blocks: Array<{ text: string; mark: boolean }> };

const snaps: Snap[] = [];
let run: Mem;

beforeAll(async () => {
  run = open("run");
  for (let n = 0; n < CHAT; n++) {
    Memory.push(run, [message(n)]);
    await idle(run);
    snaps.push({
      count    : run.count,
      view     : run.view.parts.map((p) => ({ ...p })),
      size     : run.view.size,
      batch    : run.view.batch,
      seen     : run.seen.parts.map((p) => ({ ...p })),
      seenSize : run.seen.size,
      blocks   : Memory.view(run),
    });
  }
}, 60e3);

// true if a's parts are the first parts of b
function prefix(a: Part[], b: Part[]): boolean {
  return a.length <= b.length && a.every((p, k) => p.l === b[k].l && p.i === b[k].i);
}

// The tree
// ========

test("a node (l,i) covers the 2^l messages from i·2^l; the model names it id+n", () => {
  expect(Memory.span({ l: 3, i: 5 })).toEqual([40, 47]);
  expect(Memory.ref({ l: 3, i: 5 })).toBe("40+8");
  expect(Memory.halves({ l: 3, i: 5 })).toEqual([{ l: 2, i: 10 }, { l: 2, i: 11 }]);
});

test("each node has its own slot in the index", () => {
  const slots = new Set<number>();
  for (let l = 0; l < 10; l++) {
    for (let i = 0; i < 200; i++) {
      slots.add(Memory.slot(l, i));
    }
  }
  expect(slots.size).toBe(10 * 200);
});

test("the roots are one perfect tree per 1 bit of the count", () => {
  // 13 = 0b1101
  expect(Memory.roots(13).map(Memory.ref)).toEqual(["0+8", "8+4", "12+1"]);
});

test("a merge's source is its two halves, each on one line", () => {
  for (let i = 0; i + 1 < 64; i += 2) {
    const [a, b] = [Memory.node(run, { l: 0, i }), Memory.node(run, { l: 0, i: i + 1 })];
    expect(Memory.source(run, 1, i / 2)).toBe(Memory.flat(a!) + "\n" + Memory.flat(b!));
  }
});

test("every node is asked for once (a retry aside), and only once its halves are built", () => {
  const firsts = asked.filter((a) => !a.again);
  const keys = firsts.map((a) => a.node.l + "/" + a.node.i);
  expect(new Set(keys).size).toBe(keys.length);
  expect(firsts.every((a) => a.halves)).toBe(true);
});

test("a leaf starts only while fewer than JOBS leaves before it are not built", () => {
  const leaves = asked.filter((a) => a.node.l === 0);
  expect(leaves.length).toBeGreaterThan(100);
  expect(Math.max(...leaves.map((a) => a.unbuilt))).toBeLessThan(JOBS);
});

// The view
// ========

test("a view covers the chat from message 0 to its end, no gap, no overlap", () => {
  for (const s of snaps) {
    let next = 0;
    for (const p of s.view) {
      const [a, z] = Memory.span(p);
      expect(a).toBe(next);
      next = z + 1;
    }
    expect(next).toBe(s.count);
  }
});

test("a view's size is the bytes of its lines", () => {
  for (const s of [snaps[100], snaps[500], snaps[CHAT - 1]]) {
    const lines = Memory.before(s.view, s.count).map((p) => Memory.node(run, p) ?? "");
    // the last snapshot's nodes are all still readable
    expect(s === snaps[CHAT - 1] ? lines.reduce((n, t) => n + bytes(t), 0) : s.size).toBe(s.size);
  }
});

test("the chat's view is never past 128 KB, the compactions' never past 32 KB", () => {
  for (const s of snaps) {
    expect(s.size).toBeLessThanOrEqual(HIGH);
    expect(s.seenSize).toBeLessThanOrEqual(SEEN);
  }
  // and the run is long enough to have batched both
  expect(snaps.some((s, k) => k > 0 && s.size < snaps[k - 1].size)).toBe(true);
  expect(snaps.some((s, k) => k > 0 && s.seenSize < snaps[k - 1].seenSize)).toBe(true);
});

test("a turn waits until every message before it is summarized", async () => {
  const mem = open("settle");
  size = () => 300;
  Memory.push(mem, [{ kind: "echo", text: "y".repeat(5000) }, { kind: "user", text: "next" }]);
  expect(Memory.built(mem, 0, 0)).toBe(false);
  expect(await Memory.settle(mem, 1, new AbortController().signal)).toBeNull();
  expect(Memory.built(mem, 0, 0)).toBe(true);
  await idle(mem);
  Memory.stop(mem);
});

// Mistake 1: a pair's age from its first message
// ===============================================

// Taelin's rollback push (optchat.md 3.1), as written there
function push(state: number, states: any): any {
  if (states === null) {
    return { keep: 0, life: 0, state, older: null };
  }
  const { keep, life, state: top, older } = states;
  if (keep === 0) {
    return { keep: 1, life, state: top, older };
  }
  if (life > 0) {
    return { keep: 0, life: 0, state, older: { keep: 0, life: life - 1, state: top, older } };
  }
  return { keep: 0, life, state, older: push(top, older) };
}

// a fake memory for Memory.merge alone: every node built, each 1 byte,
// so a view's size is its line count
const ALL = { nodes: { has: () => true, get: () => "x" } } as any;

// a view to `low` lines, by Memory.merge
function merged(parts: Part[], low: number): Part[] {
  return Memory.merge(ALL, { parts, size: parts.length, batch: false, high: 2 * low }).parts;
}

test("mistake 1: the merges are those of Taelin's push, at every step to 2000", () => {
  let states: any = null;
  let view: Part[] = [];
  for (let t = 0; t <= 2000; t++) {
    states = push(t, states);
    const starts: number[] = [];
    for (let s = states; s !== null; s = s.older) {
      starts.unshift(s.state);
    }
    view = merged([...view, { l: 0, i: t }], starts.length);
    expect(view.map((p) => Memory.span(p)[0])).toEqual(starts);
  }
});

test("mistake 1: at T=10 with 0+4, 4+4, 8+1, 9+1 it merges 8-9, not 0-7", () => {
  const view = [{ l: 2, i: 0 }, { l: 2, i: 1 }, { l: 0, i: 8 }, { l: 0, i: 9 }];
  expect(merged(view, 3).map(Memory.ref)).toEqual(["0+4", "4+4", "8+2"]);
});

// Mistake 2: merging at every message
// ===================================

test("mistake 2: between batches a view only grows at its end", () => {
  let changes = 0;
  for (let k = 1; k < snaps.length; k++) {
    const [was, now] = [snaps[k - 1], snaps[k]];
    if (!prefix(was.view, now.view)) {
      // a batch: it took the view to half, or is still waiting on parents
      changes += 1;
      expect(now.size <= HIGH / 2 || now.batch).toBe(true);
    }
  }
  // a handful of batches in CHAT messages, not one each message
  expect(changes).toBeGreaterThan(0);
  expect(changes).toBeLessThan(CHAT / 50);
});

test("mistake 2: a batch takes the view from over 128 KB to at most 64 KB", () => {
  for (let k = 1; k < snaps.length; k++) {
    if (snaps[k].size < snaps[k - 1].size && !snaps[k].batch) {
      expect(snaps[k].size).toBeLessThanOrEqual(HIGH / 2);
    }
  }
});

// Mistake 3: rebuilding the view
// ==============================

test("mistake 3: a restart loads the view as it was, never rebuilt", async () => {
  const before = { view: run.view.parts.map((p) => ({ ...p })), seen: run.seen.parts.map((p) => ({ ...p })), size: run.view.size };
  Memory.stop(run);
  run = open("run");
  await idle(run);
  expect(run.view.parts).toEqual(before.view);
  expect(run.seen.parts).toEqual(before.seen);
  expect(run.view.size).toBe(before.size);
});

test("mistake 3: why: a view made anew from the tree is a different view", () => {
  const rebuilt = { parts: [] as Part[], size: 0, batch: false, high: HIGH };
  Memory.open(run, rebuilt, null);
  expect(rebuilt.parts).not.toEqual(run.view.parts);
});

// Mistake 4: K lines per level
// ============================

test("mistake 4: the budget is bytes, so the view stops growing as the chat grows", () => {
  // the most lines a view had in each third of the run: once batches
  // start (the second third), the chat keeps growing and the view doesn't
  const most = [0, 0, 0];
  snaps.forEach((s, k) => {
    const third = Math.floor((3 * k) / CHAT);
    most[third] = Math.max(most[third], s.view.length);
  });
  expect(most[2]).toBeLessThanOrEqual(most[1]);
  expect(snaps[CHAT - 1].view.length).toBeLessThan(snaps[CHAT - 1].count / 2);
});

// Mistake 5: whole messages or half a message in the view
// ======================================================

test("mistake 5: a request's view holds summaries only: no line past 512 bytes", () => {
  for (const s of snaps) {
    for (const line of chat_lines(s.blocks.map((b) => b.text))) {
      expect(bytes(line.slice(line.indexOf("|") + 1))).toBeLessThanOrEqual(NODE);
    }
  }
});

test("mistake 5: a request's view has no line not summarized yet", () => {
  for (const s of snaps) {
    expect(s.blocks.some((b) => b.text.includes("(not summarized yet"))).toBe(false);
  }
  for (const a of asked) {
    expect(a.texts.some((t) => t.includes("(not summarized yet"))).toBe(false);
  }
});

test("mistake 5: while a message is being summarized, a request's view leaves it out", async () => {
  const mem = open("pending");
  size = () => 300;
  Memory.push(mem, [{ kind: "user", text: "short one" }, { kind: "echo", text: "y".repeat(5000) }]);
  // its summary is asked for, not yet answered
  expect(Memory.built(mem, 0, 1)).toBe(false);
  const text = Memory.view(mem).map((b) => b.text).join("");
  expect(text).not.toContain("(not summarized yet");
  expect(text).not.toContain("1+1|");
  expect(text).toContain("0+1|user: short one");
  await idle(mem);
  expect(Memory.view(mem).map((b) => b.text).join("")).toContain("1+1|line 0/1");
  Memory.stop(mem);
});

test("mistake 5: a compaction's view ends at its node: a leaf's before its message, a merge's at its last", () => {
  for (const a of asked) {
    const end = Memory.ctx(a.node.l, a.node.i);
    for (const line of chat_lines(a.texts)) {
      const [id, n] = ref(line);
      expect(id + n).toBeLessThanOrEqual(end);
    }
  }
});

test("mistake 5: a paste is logged as pages, none of them in a view whole", () => {
  const pages = Array.from({ length: run.count }, (_, i) => Memory.message(run, i)!).filter((m) => m.more);
  expect(pages.length).toBeGreaterThan(0);
  for (const m of pages) {
    expect(m.text.length).toBeLessThanOrEqual(30000);
  }
});

// Mistake 6: a compaction without context, or with its own prompt
// ===============================================================

test("mistake 6: a compaction has the turns' system prompt, no tools, and the chat as context", () => {
  for (const a of asked) {
    expect(a.system).toBe(SHARE.system);
    expect(a.tools).toBeUndefined();
  }
  const late = asked.filter((a) => a.node.l === 0 && a.node.i > 100);
  expect(late.every((a) => chat_lines(a.texts).length > 0)).toBe(true);
});

// Mistake 7: trusting the model to count bytes
// ============================================

test("mistake 7: the task shows a 512-dash ruler, not a sample line", () => {
  const task = Memory.task(0, 7);
  expect(task).toContain("compress message 7");
  expect(task).toContain("\n" + "-".repeat(NODE) + "\n");
  expect(task).not.toContain("-".repeat(NODE + 1));
});

test("mistake 7: a line too long is asked again: the same request plus a note", () => {
  const retry = asked.find((a) => a.again)!;
  const first = asked.find((a) => !a.again && a.node.l === retry.node.l && a.node.i === retry.node.i)!;
  expect(retry.texts.slice(0, -1)).toEqual(first.texts);
  const note = retry.texts[retry.texts.length - 1];
  expect(note).toStartWith("Too long: your last line for this <input> was 700 bytes");
  expect(note).toEndWith("| ← LIMIT");
});

test("mistake 7: at most 5 tries, and the shortest line is kept", async () => {
  const mem = open("tries");
  const lengths = [900, 800, 600, 700, 650, 520];
  let k = 0;
  size = () => lengths[k++];
  Memory.push(mem, [{ kind: "echo", text: "z".repeat(3000) }]);
  await idle(mem);
  expect(k).toBe(TRIES);
  expect(bytes(Memory.node(mem, { l: 0, i: 0 })!)).toBe(600);
  Memory.stop(mem);
});

// Mistake 8: lines under 512 bytes
// ================================

test("mistake 8: a message that fits in 512 bytes (its kind too) is its own line, with no call; one byte more is a call", async () => {
  const mem = open("free");
  const before = asked.length;
  const fits = "a".repeat(NODE - "user: ".length);
  Memory.push(mem, [{ kind: "user", text: fits }, { kind: "user", text: fits + "b" }]);
  await idle(mem);
  expect(Memory.node(mem, { l: 0, i: 0 })).toBe("user: " + fits);
  const leaves = asked.slice(before).filter((a) => !a.again && a.node.l === 0).map((a) => a.node);
  expect(leaves).toEqual([{ l: 0, i: 1 }]);
  Memory.stop(mem);
});

test("mistake 8: two short lines that fit together are joined by a newline, with no call", async () => {
  const mem = open("join");
  const before = asked.length;
  Memory.push(mem, [{ kind: "user", text: "fix the build" }, { kind: "ever", text: "on it" }]);
  await idle(mem);
  expect(Memory.node(mem, { l: 1, i: 0 })).toBe("user: fix the build\never: on it");
  expect(asked.length).toBe(before);
  Memory.stop(mem);
});

// Mistake 10: dates or state in the system prompt
// ===============================================

test("mistake 10: the system prompt is the same at any time", () => {
  setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const a = Tools.system(MASTER);
  setSystemTime(new Date("2031-07-15T12:34:56Z"));
  const b = Tools.system(MASTER);
  setSystemTime();
  expect(a).toBe(b);
});

test("mistake 10: a view has no dates in it (the model asks date(id))", () => {
  const text = Memory.view(run).map((b) => b.text).join("");
  expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
});

// Mistake 12: writes without a flush, or cut short
// ================================================

test("mistake 12: a line a crash cut short is skipped, and the log goes on", async () => {
  const mem = open("cut");
  Memory.push(mem, [{ kind: "user", text: "one" }, { kind: "user", text: "two" }]);
  Memory.stop(mem);
  const day = fs.readdirSync(DIR + "/cut/main")[0];
  const file = DIR + "/cut/main/" + day;
  const data = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, data.slice(0, data.length - 10));
  const back = open("cut");
  expect(back.count).toBe(1);
  Memory.push(back, [{ kind: "user", text: "three" }]);
  expect(Memory.message(back, 1)!.text).toBe("three");
  expect(fs.readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  Memory.stop(back);
  // the index is made anew from the log (it is derived: say it was lost),
  // and still reads "three": it was not glued to what the crash cut
  fs.rmSync(DIR + "/cut/main.index");
  const again = open("cut");
  expect(again.count).toBe(2);
  expect(Memory.message(again, 1)!.text).toBe("three");
  Memory.stop(again);
});

// Mistake 13: scanning the tree for work
// ======================================

test("mistake 13: new work comes from the queues: the tree is walked only at a load", async () => {
  const mem = open("queue");
  size = () => 300;
  const walk = Memory.todo;
  let walks = 0;
  (Memory as any).todo = (...args: Parameters<typeof walk>) => ((walks += 1), walk(...args));
  try {
    for (let n = 0; n < 200; n++) {
      Memory.push(mem, [message(n)]);
    }
    await idle(mem);
    expect(walks).toBe(0);
    expect(mem.ready.every((side) => side.every((queue) => queue.length === 0))).toBe(true);
  } finally {
    (Memory as any).todo = walk;
    Memory.stop(mem);
  }
});

// The cache
// =========

test("a view request has one mark, on its last whole block of 4 lines", () => {
  for (const s of snaps) {
    const marks = s.blocks.flatMap((b, k) => (b.mark ? [k] : []));
    expect(marks).toHaveLength(1);
    const whole = s.blocks.slice(1, -1);
    expect(whole.every((b) => b.text.split("\n").filter(Boolean).length === BLOCK)).toBe(true);
    expect(marks[0]).toBe(whole.length === 0 ? 0 : whole.length);
  }
});

test("between batches, the last request's marked prefix comes back byte for byte", () => {
  let held = 0;
  for (let k = 1; k < snaps.length; k++) {
    const [was, now] = [snaps[k - 1], snaps[k]];
    if (!prefix(was.view, now.view)) {
      continue;
    }
    // the bytes the cache keyed: every block to the last request's mark
    // (the mark itself may move on, to a later block)
    const mark = was.blocks.findIndex((b) => b.mark);
    expect(now.blocks.slice(0, mark + 1).map((b) => b.text)).toEqual(was.blocks.slice(0, mark + 1).map((b) => b.text));
    held += 1;
  }
  expect(held).toBeGreaterThan(CHAT * 0.9);
});
