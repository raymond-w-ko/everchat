// Makes tests/golden.json from the OLD code (ref/). Run: bun tools/golden.ts
//
// tests/golden.test.ts runs the new memory on the same chat and compares.
// This is the one file outside ref/ that imports from ref/. It is not part
// of the program, of the type check, or of the tests, and it goes away when
// ref/ does. Run it again only to change the chat that both sides get.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";

const DIR = fs.mkdtempSync(os.tmpdir() + "/everchat-gengold-");
process.env.EVERCHAT_DIR = DIR;
const config = await import("../ref/src/config.ts");
config.KEYS.anthropic = "test";
const { Memory } = await import("../ref/src/memory.ts");
const { MASTER } = await import("../ref/src/tools.ts");
const SHARE = { vendor: "claude-api" as const, model: "claude-opus-5-5", effort: "medium", speed: "slow", system: MASTER, searches: 0, server: "" };

let seed = 11;
const rand = () => ((seed = (seed * 48271) % 2147483647), seed / 2147483647);
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

// One answer at a time, in the order asked; the next only when the memory
// has handled the last (some turns of the event loop later). Without this,
// answers that come together are stored together before the views are fit,
// and the compactions' view depends on that timing.
let chain: Promise<void> = Promise.resolve();
const turns = async (n: number) => { for (let k = 0; k < n; k++) await new Promise((ok) => setImmediate(ok)); };
async function compactor(_url: unknown, init: any): Promise<Response> {
  const mine = chain;
  let release!: () => void;
  chain = new Promise((ok) => (release = ok));
  await mine;
  turns(20).then(release);
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
async function idle(mem: any): Promise<void> {
  for (let k = 0; k < 10; k++) {
    while (mem.busy.size > 0) await new Promise((ok) => setTimeout(ok, 1));
    await new Promise((ok) => setImmediate(ok));
  }
}
globalThis.fetch = compactor as any;
const KINDS = ["user", "tool", "echo", "note"] as const;   // no kind whose name differs between the old and the new code
const N = 1200;
const chat = DIR + "/chat";
let mem = Memory.load(chat, () => SHARE);
const marks: any[] = [];
for (let n = 0; n < N; n++) {
  const r = rand();
  const size = r < 0.6 ? 20 + Math.floor(rand() * 200) : r < 0.97 ? 400 + Math.floor(rand() * 4000) : 31000 + Math.floor(rand() * 40000);
  const kind = KINDS[Math.floor(rand() * 4)];
  const text = kind + " " + hash(String(n)).repeat(Math.ceil(size / 64)).slice(0, size) + (rand() < 0.1 ? " ünï😀 " : "");
  Memory.push(mem, [{ kind, text }]);
  await idle(mem);
  if (n % 400 === 399) {
    Memory.stop(mem);
    mem = Memory.load(chat, () => SHARE);
    await idle(mem);
  }
  if (n % 100 === 99) marks.push({ n, count: mem.count, view: mem.view.parts.length, seen: mem.seen.parts.length, size: [mem.view.size, mem.seen.size] });
}
const tree: string[] = [];
for (const l of Memory.levels(mem)) for (const [part, text] of Memory.level(mem, l)) tree.push(part.l + "/" + part.i + ":" + text);
const blocks = Memory.view(mem);
const gold = {
  about: "Made by the old code (ref/, tag before-rewrite) with tools/golden.ts: a fixed chat of 1200 messages, reloaded every 400. The compactor answers one request at a time, in the order asked.",
  count: mem.count,
  size: [mem.view.size, mem.seen.size],
  batch: [mem.view.batch, mem.seen.batch],
  view: mem.view.parts.map((p: any) => [p.l, p.i]),
  seen: mem.seen.parts.map((p: any) => [p.l, p.i]),
  nodes: tree.length,
  tree: hash(tree.join("\n")),
  blocks: hash(JSON.stringify(blocks)),
  zoom: hash([Memory.zoom(mem, 0, 1, 0), Memory.zoom(mem, 0, 1024, 0), Memory.zoom(mem, 1024, 128, 0), Memory.zoom(mem, 7, 2, 0), Memory.zoom(mem, 3, 1, 0)].join("\n---\n")),
  marks,
};
Memory.stop(mem);
fs.writeFileSync(new URL("../tests/golden.json", import.meta.url), JSON.stringify(gold) + "\n");
console.log(JSON.stringify({ ...gold, view: gold.view.length, seen: gold.seen.length, marks: gold.marks.length }));
process.exit(0);
