import { execFile, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { type CodemodeResult, CodemodeSandbox } from "../../src/pi/index.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("worker lifetime", () => {
	// #10748: reject admission before creating a worker, not by terminating an excess worker.
	it("does not start a worker when admission is denied", async () => {
		const onWorkerStarted = vi.fn();
		const acquireWorker = vi.fn(() => {
			throw new Error("worker capacity exhausted");
		});
		const sandbox = new CodemodeSandbox({ acquireWorker, onWorkerStarted });
		try {
			expect(await sandbox.execute("while (true) {}")).toMatchObject({
				ok: false,
				error: { kind: "sandbox", message: "worker capacity exhausted" },
			});
			expect(acquireWorker).toHaveBeenCalledTimes(1);
			expect(onWorkerStarted).not.toHaveBeenCalled();
		} finally {
			await sandbox.close();
		}
	});

	// #10748: a failed Worker constructor must return its reserved capacity.
	it("releases admission when worker construction fails", async () => {
		const releaseWorker = vi.fn();
		const acquireWorker = vi.fn(() => releaseWorker);
		const sandbox = new CodemodeSandbox({
			acquireWorker,
			workerUrl: new URL("https://invalid.example/worker.js"),
		});
		try {
			expect(await sandbox.execute("return 1")).toMatchObject({
				ok: false,
				error: { kind: "sandbox", message: expect.stringContaining("Failed to start worker:") },
			});
			expect(acquireWorker).toHaveBeenCalledTimes(1);
			expect(releaseWorker).toHaveBeenCalledTimes(1);
		} finally {
			await sandbox.close();
		}
	});

	// #10748: loading failures must not reserve worker capacity.
	it("does not acquire admission when wasm loading fails", async () => {
		const acquireWorker = vi.fn(() => vi.fn());
		const sandbox = new CodemodeSandbox({
			acquireWorker,
			wasm: Promise.reject(new Error("wasm unavailable")),
		});
		try {
			expect(await sandbox.execute("return 1")).toMatchObject({
				ok: false,
				error: { kind: "sandbox", message: "Failed to load QuickJS: wasm unavailable" },
			});
			expect(acquireWorker).not.toHaveBeenCalled();
		} finally {
			await sandbox.close();
		}
	});

	// #10748: Bun can leave terminate() pending while a non-interruptible built-in runs.
	it.each(["abort", "timeout", "close"] as const)("settles %s without waiting for worker exit", async (how) => {
		vi.useFakeTimers();
		const terminate = Worker.prototype.terminate;
		let worker: Worker | undefined;
		let releaseTermination: (code: number) => void = () => {};
		const termination = new Promise<number>((resolve) => {
			releaseTermination = resolve;
		});
		const terminateSpy = vi.spyOn(Worker.prototype, "terminate").mockImplementation(function (this: Worker) {
			worker = this;
			// Like the real Node/Bun implementation, termination refs the worker while waiting for exit.
			this.ref();
			return termination;
		});
		const refSpy = vi.spyOn(Worker.prototype, "ref");
		const unrefSpy = vi.spyOn(Worker.prototype, "unref");
		let ready: () => void = () => {};
		const called = new Promise<void>((resolve) => {
			ready = resolve;
		});
		let toolSignal: AbortSignal | undefined;
		let exited: Promise<void> | undefined;
		let didExit = false;
		const sandbox = new CodemodeSandbox({
			timeoutMs: 100,
			onWorkerStarted: (promise) => {
				exited = promise;
				void promise.then(() => {
					didExit = true;
				});
			},
			tools: [
				{
					name: "hang",
					execute: (_args, { signal }) => {
						toolSignal = signal;
						ready();
						return new Promise(() => {});
					},
				},
			],
		});
		const controller = new AbortController();
		let result: CodemodeResult | undefined;
		let didClose = false;
		const pending = sandbox.execute('text("partial"); await tools.hang()', { signal: controller.signal });
		void pending.then((value) => {
			result = value;
		});
		try {
			await called;
			if (how === "abort") controller.abort(new Error("cancelled"));
			if (how === "timeout") {
				vi.advanceTimersByTime(100);
				for (let i = 0; i < 20; i++) await Promise.resolve();
			}
			if (how === "close") {
				void sandbox.close().then(() => {
					didClose = true;
				});
			}
			vi.advanceTimersByTime(0);
			for (let i = 0; i < 20; i++) await Promise.resolve();
			expect(result).toMatchObject({
				ok: false,
				error: { kind: how === "timeout" ? "timeout" : "aborted" },
				output: [{ type: "text", text: "partial" }],
				calls: [{ name: "hang", status: "cancelled" }],
			});
			expect(toolSignal?.aborted).toBe(true);
			expect(terminateSpy).toHaveBeenCalledTimes(1);
			expect(unrefSpy).toHaveBeenCalledTimes(1);
			expect(refSpy).toHaveBeenCalledTimes(1);
			expect(unrefSpy.mock.invocationCallOrder[0]).toBeGreaterThan(refSpy.mock.invocationCallOrder[0]!);
			expect(exited).toBeDefined();
			expect(didExit).toBe(false);
			if (how === "close") expect(didClose).toBe(true);
			// Neither close() nor late worker messages may replace the decided outcome or wait for exit.
			await sandbox.close();
			worker?.emit("message", { type: "done", ok: true, value: "42", writes: "[]" });
			expect(await pending).toBe(result!);
			expect(terminateSpy).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
			terminateSpy.mockRestore();
			if (worker) releaseTermination(await terminate.call(worker));
			await sandbox.close();
		}
		await exited;
		expect(didExit).toBe(true);
	});

	// #10748: exit accounting applies to successful executions and host-controlled runs too.
	it("reports the actual exit of execute() and start() workers", async () => {
		const exits: Promise<void>[] = [];
		const releaseWorker = vi.fn();
		const acquireWorker = vi.fn(() => releaseWorker);
		const sandbox = new CodemodeSandbox({ acquireWorker, onWorkerStarted: (exited) => void exits.push(exited) });
		try {
			expect(await sandbox.execute("return 1")).toMatchObject({ ok: true, value: 1 });
			const run = sandbox.start("return 2", { startedAt: 0, seed: 0, onCall: () => {} });
			expect(await run.result).toMatchObject({ ok: true, value: 2 });
			expect(run.finished).toBe(true);
			expect(exits).toHaveLength(2);
			await Promise.all(exits);
			expect(acquireWorker).toHaveBeenCalledTimes(2);
			expect(releaseWorker).toHaveBeenCalledTimes(2);
		} finally {
			await sandbox.close();
		}
	});

	// #10748: a failing lifetime hook must not leak the worker it was handed.
	it("requests termination when onWorkerStarted throws", async () => {
		let exited: Promise<void> | undefined;
		const releaseWorker = vi.fn();
		const sandbox = new CodemodeSandbox({
			acquireWorker: () => releaseWorker,
			onWorkerStarted: (promise) => {
				exited = promise;
				throw new Error("lifetime hook failed");
			},
		});
		try {
			expect(await sandbox.execute("while (true) {}")).toMatchObject({
				ok: false,
				error: { kind: "sandbox", message: "lifetime hook failed" },
			});
			expect(exited).toBeDefined();
			await exited;
			expect(releaseWorker).toHaveBeenCalledTimes(1);
		} finally {
			await sandbox.close();
		}
	});
});

const runtimes = [
	{ name: "Node", command: "node", available: spawnSync("node", ["--version"], { timeout: 5000 }).status === 0 },
	{ name: "Bun", command: "bun", available: spawnSync("bun", ["--version"], { timeout: 5000 }).status === 0 },
];

describe.each(runtimes)("$name process lifetime", ({ name, command, available }) => {
	// #10748: verify both prompt cancellation and, on Node, prompt process exit with a real worker.
	// Bun 1.4.0's pending terminate() keeps the process alive even after unref(), independently of codemode.
	// EverChat's change (not upstream's): what each row proves, with bounds that hold on a loaded machine.
	// (a) A stop settles `execute` within 1 s, with no wait for the worker's exit. Abort and close count
	// from the script's first tool call (`readyMs`): the fixture starts their stop from `ready`, and the start
	// of the process and the worker before that call is the machine's speed, so it is not in the bound; if
	// `ready` is never called, `readyMs` is not a number, and the bound fails. The deadline counts from the
	// start of `execute`, as upstream's bound does: it is armed there, before the worker boots, so its result
	// comes about 300 ms after the start whatever the boot costs, and `ready` may come after it or never.
	// (b) On Node, the worker does not hold the process after the stop: it exits within 1 s of the result.
	// (c) On Bun, the process ends when the worker's built-in (`indexOf`, which no interrupt stops) returns,
	// and nothing else holds it: the child must end within its time limit. That built-in took 13 s on an
	// idle machine and up to 66 s at a load of 70, so the Bun rows have 120 s, not upstream's 20 s.
	it.skipIf(!available).each(["abort", "timeout", "close"] as const)(
		name === "Node" ? "exits promptly after %s with a real worker" : "settles %s promptly with a real worker",
		async (how) => {
			const fixture = fileURLToPath(new URL("./fixtures/worker-process-exit.ts", import.meta.url));
			// EverChat's change: Bun's child lives until the worker's non-interruptible indexOf returns: 13 s
			// idle, 66 s under load. Upstream gives each runtime 20 s.
			const { stdout } = await promisify(execFile)(command, [fixture, how], { timeout: name === "Bun" ? 120000 : 20000 });
			const lines = stdout.trim().split(/\r?\n/);
			expect(lines).toHaveLength(2);
			const result = JSON.parse(lines[0]!) as { type: string; kind: string; elapsedMs: number; readyMs: number };
			const exit = JSON.parse(lines[1]!) as { type: string; elapsedMs: number };
			expect(result).toMatchObject({ type: "result", kind: how === "timeout" ? "timeout" : "aborted" });
			expect(exit.type).toBe("exit");
			if (how === "timeout") {
				// Upstream's line again: the deadline is armed when `execute` starts, before the boot, so the bound
				// holds under load (302 to 324 ms in 20 runs at a load of 33 to 48, `ready` not called in 11).
				expect(result.elapsedMs).toBeLessThan(1000);
			} else {
				// EverChat's change: abort and close count from the script's first tool call (upstream: from the
				// process's start). Under load the start of the process and the worker alone passed 1 s (16 of 120
				// runs). JSON writes NaN as null, and `elapsedMs - null` is `elapsedMs`: so the case fails unless
				// `ready` gave a number.
				expect(typeof result.readyMs).toBe("number");
				expect(result.elapsedMs - result.readyMs).toBeLessThan(1000);
			}
			if (name === "Node") expect(exit.elapsedMs - result.elapsedMs).toBeLessThan(1000);
		},
		// EverChat's change: the Bun rows' child has 120 s (above); upstream gives each row 25 s.
		name === "Bun" ? 125000 : 25000,
	);
});
