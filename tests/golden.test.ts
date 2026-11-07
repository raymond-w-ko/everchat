// Golden test
// ===========
// `bun test golden.test.ts`. A fixed chat of 1200 messages (short, long,
// pasted over pages; some recording acts) through the real Memory, AskAI
// and Agent loop against a fake compactor, reloaded every 400. Its whole
// state must be what it was when this test was written (the JSON-lines
// store, at fe1742d): the messages and summaries (its /export), every node
// held, both views. So a change of how the chat is stored, or of how a
// model is called, can't change what the algorithm does unseen. Change
// the algorithm on purpose, and these values change with it: say why in
// the commit.

import { expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";

const DIR = fs.mkdtempSync(os.tmpdir() + "/everchat-golden-");
process.env.EVERCHAT_DIR = DIR;

const config = await import("../src/config.ts");
config.KEYS.anthropic = "test";
const { Memory } = await import("../src/memory.ts");
const { MASTER } = await import("../src/tools.ts");

const SHARE = { vendor: "claude-api" as const, model: "claude-opus-5-5", effort: "medium", speed: "slow", system: MASTER, searches: 0, server: "" };

// what the JSON-lines store at fe1742d made of the chat
const GOLD = {
  count : 1269,
  view  : 386,
  seen  : 67,
  size  : [107530, 20949],
  dump  : "d87f91fcd7be832f9f74ee8839f65f2a0689aed586c85d7a86315101e21fb4b7",
  held  : "797750ee12d9d849cd3d3f00835860d1413c8514ec31dd1bbffbfdc0241ad4f2",
};

let seed = 11;
const rand = () => ((seed = (seed * 48271) % 2147483647), seed / 2147483647);
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

// a compactor: a line made from its task, too long at the first try of
// about one in five
async function compactor(_url: unknown, init: any): Promise<Response> {
  const body = JSON.parse(init.body);
  const first = body.messages[0].content;
  const task: string = first.findLast((c: any) => c.text?.startsWith("Compaction:"))?.text ?? "";
  const again = first[first.length - 1].text.startsWith("Too long:");
  const id = hash(task).slice(0, 12);
  const long = !again && parseInt(id, 16) % 5 === 0;
  const line = "sum " + id + " " + "é".repeat(30) + "x".repeat(long ? 700 : 200 + (parseInt(id.slice(0, 4), 16) % 200));
  const evs = [
    { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: line } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } },
    { type: "message_stop" },
  ];
  return new Response(evs.map((ev) => "event: " + ev.type + "\ndata: " + JSON.stringify(ev) + "\n\n").join(""), { headers: { "content-type": "text/event-stream" } });
}

// till no summary builds, and none starts
async function idle(mem: any): Promise<void> {
  for (let k = 0; k < 10; k++) {
    while (mem.busy.size > 0) {
      await new Promise((ok) => setTimeout(ok, 1));
    }
    await new Promise((ok) => setImmediate(ok));
  }
}

test("a fixed chat ends in the state it always has", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = compactor as any;
  try {
    const chat = DIR + "/chat";
    let mem = Memory.load(chat, () => SHARE);
    const t0 = Date.UTC(2026, 9, 1);
    for (let n = 0; n < 1200; n++) {
      const r = rand();
      const size = r < 0.6 ? 20 + Math.floor(rand() * 200) : r < 0.97 ? 400 + Math.floor(rand() * 4000) : 31000 + Math.floor(rand() * 40000);
      const kind = (["user", "ever", "tool", "echo"] as const)[Math.floor(rand() * 4)];
      const text = kind + " " + hash(String(n)).repeat(Math.ceil(size / 64)).slice(0, size) + (rand() < 0.1 ? " ünï😀 " : "");
      Memory.push(mem, [{ kind, text, date: new Date(t0 + n * 60e3).toISOString(), act: rand() < 0.2 ? "act" + n : undefined }]);
      await idle(mem);
      if (n % 400 === 399) {
        Memory.stop(mem);
        mem = Memory.load(chat, () => SHARE);
        await idle(mem);
      }
    }
    const dump = [...Memory.dump(mem, { user: "u" })].join("");
    const nodes = [...mem.nodes.entries()].sort((a: any, b: any) => a[0] - b[0]).map(([k, v]: any) => k + ":" + hash(v));
    expect({
      count : mem.count,
      view  : mem.view.parts.length,
      seen  : mem.seen.parts.length,
      size  : [mem.view.size, mem.seen.size],
      dump  : hash(dump),
      held  : hash(JSON.stringify([mem.view.parts, mem.seen.parts, nodes])),
    }).toEqual(GOLD);
    Memory.stop(mem);
  } finally {
    globalThis.fetch = real;
  }
}, 60e3);
