// Machine test
// ============
// `bun test machine.test.ts`. The device tools' answers at their edges.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { Machine } from "./machine.ts";

const DIR = fs.mkdtempSync(os.tmpdir() + "/everchat-machine-");

test("a read past a file's end says so, never an empty range", () => {
  const file = DIR + "/three";
  fs.writeFileSync(file, "a\nb\nc\n");
  expect(Machine.read(file, 3, Infinity, 0)).toEqual({ text: "c\n[lines 3-3 of 3]", fail: false });
  expect(Machine.read(file, 9, Infinity, 0)).toEqual({ text: "No lines from line 9: the file has 3.", fail: true });
  expect(Machine.read(file, 2, 0, 0)).toEqual({ text: "No lines from line 2: the file has 3.", fail: true });
});

test("a shell's output is decoded whole: a char split over writes, a broken one at its end", async () => {
  const live = new AbortController().signal;
  const split = await Machine.shell(DIR, "printf 'a\\303'; sleep 0.1; printf '\\251b'", live);
  expect(split.text).toStartWith("aéb\n(exit 0 in ");
  const broken = await Machine.shell(DIR, "printf 'ab\\303'", live);
  expect(broken.text).toStartWith("ab�\n(exit 0 in ");
});

// a $SHELL that isn't POSIX (fish: a bare `exec` prints its help) still
// runs the command alone, its stderr in its output. The shell is read as
// machine.ts loads, so this runs in a process of its own with a fake one:
// it refuses a command that starts with a bare exec, and runs any other
test("a shell's output is merged and clean when $SHELL isn't POSIX", async () => {
  const fake = DIR + "/fakeshell";
  fs.writeFileSync(fake, '#!/bin/sh\ncase "$2" in "exec 2>&1"*) echo "fake: exec needs a command"; exit 1;; esac\nexec /bin/sh -c "$2"\n', { mode: 0o755 });
  const run = DIR + "/run.ts";
  fs.writeFileSync(run, `const { Machine } = await import(${JSON.stringify(import.meta.dir + "/machine.ts")});
console.log(JSON.stringify(await Machine.shell(${JSON.stringify(DIR)}, "echo out; echo err >&2", new AbortController().signal)));`);
  const proc = Bun.spawn([process.execPath, run], { env: { ...process.env, SHELL: fake }, stdout: "pipe", stderr: "inherit" });
  const out  = JSON.parse(await new Response(proc.stdout).text());
  expect(out.text).toStartWith("out\nerr\n(exit 0 in ");
});
