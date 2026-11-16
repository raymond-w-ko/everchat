import { CodemodeSandbox } from "../../../src/pi/runtime/host.ts";

const how = process.argv[2];
if (how !== "abort" && how !== "timeout" && how !== "close") throw new Error(`Unknown stop mode: ${how}`);
const started = performance.now();
process.on("exit", () => {
	console.log(JSON.stringify({ type: "exit", elapsedMs: performance.now() - started }));
});
const controller = new AbortController();
let timer: ReturnType<typeof setTimeout> | undefined;
let workerExited = false;
// EverChat's change (not upstream's): when the script made its first tool call, so that the test bounds
// the stop from there, not from the process's start (worker-lifetime.test.ts says why). Not a number
// until `ready` runs.
let readyMs = Number.NaN;
const sandbox = new CodemodeSandbox({
	memoryLimitBytes: 256 * 1024 * 1024,
	onWorkerStarted: (exited) => {
		void exited.then(() => {
			workerExited = true;
		});
	},
	tools: [
		{
			name: "ready",
			execute: () => {
				readyMs = performance.now() - started; // EverChat's change: see `readyMs` above.
				if (how !== "timeout") {
					timer = setTimeout(() => {
						if (how === "abort") controller.abort();
						else void sandbox.close();
					}, 100);
				}
			},
		},
	],
});
try {
	const result = await sandbox.execute(
		"await tools.ready(); return 'a'.repeat(300000).indexOf('a'.repeat(10000) + 'b')",
		{ signal: controller.signal, timeoutMs: how === "timeout" ? 300 : Number.POSITIVE_INFINITY },
	);
	if (result.ok) throw new Error("The script completed instead of being cancelled");
	await sandbox.close();
	console.log(
		JSON.stringify({
			type: "result",
			kind: result.error.kind,
			elapsedMs: performance.now() - started,
			workerExited,
			readyMs, // EverChat's change: see `readyMs` above.
		}),
	);
} finally {
	clearTimeout(timer);
	await sandbox.close();
}
