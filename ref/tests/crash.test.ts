// Crash and billing test
// ======================
// `bun test crash.test.ts`. A worker outlives a failure no one owned
// (Main.unowned logs it); an agent whose run throws still reports, as a
// failed reply; a request cut short is billed the output it streamed,
// each byte a token, and its text as input when the API told none.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

process.env.EVERCHAT_DIR = fs.mkdtempSync(os.tmpdir() + "/everchat-crash-");

const { Agent } = await import("../src/agent.ts");
const { Tools } = await import("../src/tools.ts");
const { Price } = await import("../src/price.ts");

test("a worker outlives a failure no one owned", async () => {
  const code = `
    const { Main } = await import(${JSON.stringify(import.meta.dir + "/../src/server.ts")});
    process.on("unhandledRejection", Main.unowned);
    Promise.reject(new Error("nobody's"));
    setTimeout(() => { console.log("alive"); process.exit(0); }, 100);
  `;
  const proc = Bun.spawn([process.execPath, "-e", code], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(exit).toBe(0);
  expect(out).toContain("alive");
  expect(err).toContain("a failure no one owned");
  expect(err).toContain("nobody's");
});

test("an agent whose run throws still reports", async () => {
  let told = "";
  const tools: any = {
    hooks: {
      change: () => {
        throw new Error("boom");
      },
      on: () => {},
      report: (_agent: unknown, text: string) => (told = text),
    },
  };
  const agent: any = { name: "Probe", call: null, replies: [], stop: false };
  const call: any = { done: Promise.resolve({ ok: true, text: "never", left: [] }) };
  await Tools.run(tools, agent, call);
  expect(agent.call).toBeNull();
  expect(told).toContain("failed: boom");
});

test("a request cut short is billed what it streamed", () => {
  const api = { ...Price.usage("slow"), input: 10, write: 20, read: 30, output: 1 };
  expect(Agent.used(api, { bytes: 500, done: true }, "{}")).toEqual(api);
  expect(Agent.used(api, { bytes: 500, done: false }, "{}")).toEqual({ ...api, output: 500 });
  expect(Agent.used({ ...api, output: 900 }, { bytes: 500, done: false }, "{}").output).toBe(900);
  const none = Price.usage("slow");
  const json = JSON.stringify({ input: "héllo" });
  expect(Agent.used(none, { bytes: 7, done: false }, json)).toEqual({ ...none, write: Buffer.byteLength(json), output: 7 });
});
