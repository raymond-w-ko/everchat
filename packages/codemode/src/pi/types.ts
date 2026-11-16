import type { CodemodeResult, CodemodeTool } from "@everchat/core/codemode";
import type { CodemodeWasmModule } from "./wasm.ts";

export type {
	CodemodeCall,
	CodemodeCallStatus,
	CodemodeDuring,
	CodemodeError,
	CodemodeErrorKind,
	CodemodeJsonSchema,
	CodemodeOutputItem,
	CodemodeResult,
	CodemodeStoreWrites,
	CodemodeTool,
	CodemodeToolContext,
} from "@everchat/core/codemode";

/** Options every sandbox accepts, wherever its VM runs. */
export interface CodemodeSandboxBaseOptions {
	tools?: CodemodeTool[];
	/**
	 * Functions exposed as top-level identifiers instead of on `tools`, for host helpers such as
	 * attaching an image to the result. They behave like tools (JSON round trip, promise result)
	 * but are not recorded in `result.calls`. Names must be identifiers and may not shadow the
	 * built-in globals (`tools`, `ALL_TOOLS`, `console`, `text`, `image`, `exit`, `store`, `load`).
	 */
	globals?: CodemodeTool[];
	/**
	 * Overall deadline per execution, including time spent in tools. `Infinity` disables the
	 * deadline; the execution then only ends when the script settles or is aborted.
	 * Default: 300000.
	 */
	timeoutMs?: number;
	/**
	 * Maximum memory the QuickJS VM may allocate. Allocations beyond it fail inside the script as
	 * `InternalError: out of memory`. Default: no limit beyond wasm32's 4 GiB address space.
	 */
	memoryLimitBytes?: number;
}

/** Options of `CodemodeSandbox`, which runs each VM in a Node or Bun worker thread. */
export interface CodemodeSandboxOptions extends CodemodeSandboxBaseOptions {
	/**
	 * Compiled `quickjs-wasi/quickjs.wasm`, usually from {@link loadQuickJSWasm}. Default:
	 * `loadQuickJSWasm()`, the file in the installed `quickjs-wasi` package. Pass it when that file
	 * is not on disk, for example in a Bun compiled executable.
	 */
	wasm?: CodemodeWasmModule | Promise<CodemodeWasmModule>;
	/**
	 * Worker entry that imports `@earendil-works/pi-codemode/worker`. Default: this package's own
	 * worker file. Pass it when this package is bundled, since the default is resolved relative to
	 * the module that creates the sandbox. Bun compiled executables require the relative string
	 * specifier of an embedded build entrypoint; other hosts usually use a URL.
	 */
	workerUrl?: string | URL;
	/**
	 * Synchronously reserves capacity immediately before creating each worker, after loading wasm.
	 * Throw to deny admission without starting a worker. Return a release callback, called once if
	 * worker construction fails or when the worker actually exits, not when the result settles.
	 * The release callback must not throw. Reservations can be shared across sandbox instances.
	 */
	acquireWorker?(): () => void;
	/**
	 * Called once for each worker started by execute() or start(). `exited` resolves when that worker
	 * actually exits, which may be after the result and close() settle: on Bun a non-interruptible
	 * built-in can delay termination. Use it to keep the worker counted against host concurrency
	 * limits until it exits. A thrown callback error fails the execution and requests worker termination.
	 */
	onWorkerStarted?(exited: Promise<void>): void;
}

/** A call the script made in a {@link CodemodeSandboxBase.start} run, answered with `CodemodeRun.deliver()`. */
export interface CodemodeHostCall {
	/** The VM's own number for the call, `1`, `2`, ... in the order the script made its calls (tools and globals). */
	id: number;
	target: "tool" | "global";
	name: string;
	/** What the script passed, after a JSON round trip; for spread globals the argument list. */
	args: unknown;
}

/** A tool as a {@link CodemodeSandboxBase.start} run's script sees it: `tools.<name>` and its `ALL_TOOLS` entry. */
export interface CodemodeDeclaredTool {
	name: string;
	/**
	 * The identifier the script uses, `tools.<jsName>`. Default: `toCodemodeIdentifier(name)`. A host that replays a run
	 * passes the one the run started with, so a changed mapping cannot rename a tool under a resumed script.
	 */
	jsName?: string;
	description?: string;
}

/** A global as a {@link CodemodeSandboxBase.start} run's script sees it; the same names as `globals` allow. */
export interface CodemodeDeclaredGlobal {
	name: string;
	spread?: boolean;
}

/**
 * A call's answer. A rejection becomes an `Error` with `message` in the script, carrying the own properties of
 * `properties` (JSON values; `name`, `message`, and `stack` are ignored), for example `{ structuredOutput }`.
 */
export type CodemodeOutcome =
	| { ok: true; value: unknown }
	| { ok: false; message: string; properties?: Record<string, unknown> };

export interface CodemodeRunOptions {
	/** The VM clock's start, in ms since the epoch: `Date.now()` until the first result arrives. */
	startedAt: number;
	/** Seeds `Math.random()` and the VM's other randomness. A 32-bit unsigned integer. */
	seed: number;
	tools?: CodemodeDeclaredTool[];
	globals?: CodemodeDeclaredGlobal[];
	store?: Readonly<Record<string, unknown>>;
	signal?: AbortSignal;
	/** Deadline of this run in ms. Default: none (not the sandbox's default). */
	timeoutMs?: number;
	/** The VM's fingerprint, before the script runs and before any of its calls. */
	onStarted?(fingerprint: string): void;
	/** The script made a call. Answer it with `CodemodeRun.deliver()`, now or later. */
	onCall(call: CodemodeHostCall): void;
	/**
	 * The VM processed result `seq` (`0`: the script's first run, before any result) and waits again, having issued
	 * `issued` calls in total.
	 */
	onIdle?(seq: number, issued: number): void;
}

/** A running {@link CodemodeSandboxBase.start} execution. */
export interface CodemodeRun {
	readonly result: Promise<CodemodeResult>;
	/**
	 * Whether the run has its outcome: the script ended, timed out, or failed, or the run was aborted. Set when that is
	 * decided, before `result` settles; calls can no longer be answered. It does not mean the VM has exited.
	 */
	readonly finished: boolean;
	/**
	 * Answer call `id` as result number `seq`. Results are numbered 1, 2, ... without gaps, and the VM applies them
	 * strictly in that order, whatever order they arrive in: after a gap it waits for the missing number. While it
	 * processes this one, its clock reads `now` (ms since the epoch), or the previous value if `now` is earlier.
	 * Throws for a call that is not waiting for an answer, a `seq` used before, or a `now` that is not finite.
	 */
	deliver(seq: number, now: number, id: number, outcome: CodemodeOutcome): void;
}

export interface CodemodeExecuteOptions {
	signal?: AbortSignal;
	/** Overrides the sandbox default for this execution. */
	timeoutMs?: number;
	/**
	 * Values the script reads with `load(key)`. Must be JSON-serializable. The script's own
	 * `store()` calls come back as `result.storeWrites`; persisting them is up to the caller.
	 */
	store?: Readonly<Record<string, unknown>>;
}
