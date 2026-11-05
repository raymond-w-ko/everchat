// Computer
// ========
// The actions of the computer tool (machine.ts), Anthropic's computer use
// tool in shape, run as jobs on a device. computer.swift, carried by the
// executable and compiled into ~/.everchat (swiftc) when missing or changed,
// does the mouse and keyboard and tells the screenshot's size;
// screencapture and sips take it as a JPEG. Every action answers with a
// screenshot taken after it; zoom with its region. wait and hold_key wait
// here, so a stop ends them. macOS needs the Screen Recording and
// Accessibility permissions of what started the terminal (over ssh: sshd).

import * as fs from "node:fs";
import * as os from "node:os";
import type { Out } from "./agent.ts";
import SOURCE from "./computer.swift" with { type: "text" };
import { Machine, WAIT } from "./machine.ts";

// Types
// =====

// what computer.swift prints: the screenshot's size, its scale (screen
// points per pixel), the action's answer
type Done = { w: number; h: number; scale: number; text: string };

// Constants
// =========

const HOME  = os.homedir() + "/.everchat";

// how long the screen gets to show the last action before a screenshot,
// in ms (Anthropic's reference computer use tool waits too)
const SETTLE = 500;

// Computer
// ========

export namespace Computer {

  export async function act(input: any, signal: AbortSignal): Promise<Out> {
    const name = String(input.action);
    if (name === "zoom") {
      return Computer.zoom(input);
    }
    const done = await Computer.step(name, input, signal);
    await Bun.sleep(SETTLE);
    const shot = await Computer.shot([], done.w, done.h);
    return { ...shot, text: done.text + "\n" + shot.text };
  }

  // an action, done
  export async function step(name: string, input: any, signal: AbortSignal): Promise<Done> {
    const ms = Math.max(0, Math.min(WAIT, Number(input.duration) || 0)) * 1000;
    switch (name) {
      case "wait": {
        await Machine.nap(ms, signal);
        return Computer.hands(name, input);
      }
      case "hold_key": {
        const done = await Computer.hands("press", input);
        try {
          await Machine.nap(ms, signal);
        } finally {
          await Computer.hands("release", input);
        }
        return done;
      }
      default: {
        return Computer.hands(name, input);
      }
    }
  }

  // the region [x0, y0, x1, y1] of the screenshot, at the screen's own
  // resolution, as large as the screenshot
  export async function zoom(input: any): Promise<Out> {
    const done = await Computer.hands("zoom", input);
    const [x0, y0, x1, y1] = (input.region ?? []).map((n: number) => n * done.scale);
    if (!(x1 > x0 && y1 > y0)) {
      return { text: "region must be [x0, y0, x1, y1], with x1 > x0 and y1 > y0", fail: true };
    }
    const fit = Math.min(done.w / (x1 - x0), done.h / (y1 - y0));
    const area = [x0, y0, x1 - x0, y1 - y0].map(Math.round).join(",");
    return Computer.shot(["-R", area], Math.round((x1 - x0) * fit), Math.round((y1 - y0) * fit));
  }

  export async function hands(name: string, input: unknown): Promise<Done> {
    const bin = HOME + "/computer";
    const src = bin + ".swift";
    if (!fs.existsSync(bin) || !fs.existsSync(src) || fs.readFileSync(src, "utf8") !== SOURCE) {
      fs.mkdirSync(HOME, { recursive: true });
      fs.writeFileSync(src, SOURCE);
      await Computer.exec(["swiftc", "-O", src, "-o", bin]);
    }
    return JSON.parse(await Computer.exec([bin, JSON.stringify({ name, input })]));
  }

  // the screen (or the region `opts` gives), scaled to w by h, as a JPEG
  export async function shot(opts: string[], w: number, h: number): Promise<Out> {
    const file = os.tmpdir() + "/everchat-" + crypto.randomUUID() + ".jpg";
    try {
      await Computer.exec(["screencapture", "-x", "-t", "jpg", ...opts, file]);
      await Computer.exec(["sips", "-z", String(h), String(w), file]);
      const data = fs.readFileSync(file).toString("base64");
      return { text: "[image " + w + "x" + h + "]", fail: false, imgs: [{ type: "image/jpeg", data }] };
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  export async function exec(argv: string[]): Promise<string> {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const outs = [new Response(proc.stdout).text(), new Response(proc.stderr).text()];
    const [out, err] = await Promise.all(outs);
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error((err || out).trim() || argv[0] + ": exit " + code);
    }
    return out.trim();
  }

}
