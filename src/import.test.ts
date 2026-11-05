import { expect, test } from "bun:test";
import * as Import from "./import.ts";
import { Memory } from "./memory.ts";

// a log's odd lines (no object, a null block, a date past JS's) are no
// messages: the session keeps the rest, never fails the import
test("odd log lines are skipped, not fatal", async () => {
  const say = (text: string) => JSON.stringify({ type: "user", timestamp: "2026-10-01T00:00:00Z", message: { content: text } });
  const odd = ["null", JSON.stringify({ type: "user", message: { content: [null] } }), JSON.stringify({ type: "user", timestamp: 1e20, message: { content: "x" } })];
  const s = await Import.import_session(new Blob([[say("a"), ...odd, say("b")].join("\n") + "\n"]), "log");
  expect(s?.heads.map((h) => h.kind)).toEqual(["user", "user"]);
});

// a session imported in one time zone is the same one in another: its
// key holds no local time (a trip renamed them all, imported again)
test("a session's key is the same in any time zone", () => {
  const s: any = { app: "Claude", form: "log", where: 'chat "a, from b"', start: "2026-10-07T14:32:00.000Z", file: new Blob([]), heads: [] };
  const key = (tz: string) => ((process.env.TZ = tz), Import.import_id(s));
  expect(key("America/Sao_Paulo")).toBe(key("America/Los_Angeles"));
});

// a zip over 4 GB is a ZIP64: its sizes and places in 64-bit fields,
// the 32-bit ones 0xFFFFFFFF (made so here, small)
test("a ZIP64 export imports", async () => {
  const chats = [{ name: "t", chat_messages: [{ sender: "human", text: "hi", created_at: "2026-10-01T00:00:00Z" }] }];
  const zip = zip64("export/conversations.json", new TextEncoder().encode(JSON.stringify(chats)));
  const sessions = await Import.import_export(zip);
  expect(sessions.map((s) => [s.app, s.where, s.heads.length])).toEqual([["Claude", 'chat "t"', 1]]);
});

// little-endian fields, each its width in bytes and its value
function bytes(fields: Array<[number, number]>): Uint8Array {
  const out = new DataView(new ArrayBuffer(fields.reduce((n, [w]) => n + w, 0)));
  let at = 0;
  for (const [w, x] of fields) {
    if (w === 8) {
      out.setBigUint64(at, BigInt(x), true);
    } else if (w === 4) {
      out.setUint32(at, x, true);
    } else {
      out.setUint16(at, x, true);
    }
    at += w;
  }
  return new Uint8Array(out.buffer);
}

// a ZIP64 of one file, stored
function zip64(name: string, data: Uint8Array): Blob {
  const path = new TextEncoder().encode(name);
  const [crc, max] = [Bun.hash.crc32(data), 0xffffffff];
  const local = bytes([[4, 0x04034b50], [2, 45], [2, 0], [2, 0], [2, 0], [2, 0], [4, crc], [4, max], [4, max], [2, path.length], [2, 20]]);
  const head = [local, path, bytes([[2, 1], [2, 16], [8, data.length], [8, data.length]]), data];
  const at = head.reduce((n, b) => n + b.length, 0);
  const entry = bytes([[4, 0x02014b50], [2, 45], [2, 45], [2, 0], [2, 0], [2, 0], [2, 0], [4, crc], [4, max], [4, max], [2, path.length], [2, 28], [2, 0], [2, 0], [2, 0], [4, 0], [4, max]]);
  const dir = [entry, path, bytes([[2, 1], [2, 24], [8, data.length], [8, data.length], [8, 0]])];
  const size = dir.reduce((n, b) => n + b.length, 0);
  const end64 = bytes([[4, 0x06064b50], [8, 44], [2, 45], [2, 45], [4, 0], [4, 0], [8, 1], [8, 1], [8, size], [8, at]]);
  const locator = bytes([[4, 0x07064b50], [4, 0], [8, at + size], [4, 1]]);
  const end = bytes([[4, 0x06054b50], [2, 0xffff], [2, 0xffff], [2, 0xffff], [2, 0xffff], [4, max], [4, max], [2, 0]]);
  return new Blob([...head, ...dir, end64, locator, end]);
}

// an imported chat's AI, its say and calls, reads as "ai", never EverChat
test("an import's AI is not EverChat", () => {
  const show = (kind: any, imported?: boolean) => Memory.show(Memory.root(0, { kind, text: "", imported }));
  expect([show("everchat", true), show("tool", true), show("user", true), show("everchat")]).toEqual(["ai: ", "ai: ", "user: ", "everchat: "]);
});
