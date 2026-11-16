export interface CodemodeToolContext {
	/**
	 * Aborted when the script finishes (including unawaited calls), the
	 * execution times out, the caller aborts, or the sandbox is closed.
	 */
	signal: AbortSignal;
}

/** A JSON Schema document. Only used to render declarations; values are not validated against it. */
export type CodemodeJsonSchema = { [key: string]: unknown } | boolean;

export interface CodemodeTool {
	/**
	 * The script calls tools as `tools.<id>(args)`, where `<id>` is the name with characters that
	 * are not valid in identifiers replaced by `_` (see `toCodemodeIdentifier`), and also as
	 * `tools["<name>"](args)`. Globals are called as `<name>(args)` and must be identifiers, or
	 * `<namespace>.<member>`, which groups them into a frozen namespace object.
	 */
	name: string;
	/** Shown as a doc comment in {@link renderDeclarations}, and listed in `ALL_TOOLS` for tools. */
	description?: string;
	/** Schema of the single argument. Rendered as the parameter type; `unknown` when omitted. */
	inputSchema?: CodemodeJsonSchema;
	/** Schema of the resolved value. Rendered as the promise type; `unknown` when omitted. */
	outputSchema?: CodemodeJsonSchema;
	/** Globals only: `execute` receives all call arguments as an array instead of the first one. */
	spread?: boolean;
	/**
	 * Globals only: TypeScript parameter list and return type for {@link renderDeclarations}, for
	 * example `(type: string, id?: string): Promise<Model[]>`. Replaces the rendering from the schemas.
	 */
	signature?: string;
	/**
	 * `args` is whatever the script passed, after a JSON round trip. The return
	 * value must be JSON-serializable; a thrown error surfaces in the script as
	 * an `Error` with the same message.
	 */
	execute(args: unknown, context: CodemodeToolContext): Promise<unknown> | unknown;
}

/**
 * One item of the script's output, in the order the script produced it: `text()` and `console.*`
 * produce text items, with `console: true` for `console.*`, and `image()` image items. `data` is base64.
 */
export type CodemodeOutputItem =
	| { type: "text"; text: string; console?: true }
	| { type: "image"; data: string; mimeType: string };

export type CodemodeCallStatus = "ok" | "error" | "cancelled";

export interface CodemodeCall {
	name: string;
	status: CodemodeCallStatus;
	durationMs: number;
}

export type CodemodeErrorKind =
	/** The script threw or failed to parse. `name` and `stack` come from the script's error. */
	| "script"
	/**
	 * The overall deadline expired, or a VM on the calling thread used up its interrupt budget.
	 * The execution ended and the VM was asked to stop; a worker or remote VM may still be computing.
	 */
	| "timeout"
	/** The caller's signal fired or the sandbox was closed. The execution ended and the VM was asked to stop. */
	| "aborted"
	/**
	 * The VM or its transport failed outside the script's control (for example a wasm trap, a missing
	 * worker file, or a remote sandbox that failed).
	 */
	| "sandbox";

export interface CodemodeError {
	kind: CodemodeErrorKind;
	name?: string | undefined;
	message: string;
	stack?: string | undefined;
}

/** Keys the script changed with `store()`. Only successful executions report writes. */
export interface CodemodeStoreWrites {
	set: Record<string, unknown>;
	/** Keys stored as `undefined`. */
	delete: string[];
}

/**
 * `output` is kept for failed executions too, up to the failure. `exit()` completes with `value: undefined`.
 * `during`: in a {@link CodemodeSandboxBase.start} run that the script itself ended (it returned, threw, or exited),
 * the result being processed when it did.
 */
export type CodemodeResult =
	| {
			ok: true;
			value: unknown;
			output: CodemodeOutputItem[];
			calls: CodemodeCall[];
			storeWrites: CodemodeStoreWrites;
			during?: CodemodeDuring;
	  }
	| {
			ok: false;
			error: CodemodeError;
			output: CodemodeOutputItem[];
			calls: CodemodeCall[];
			during?: CodemodeDuring;
	  };

/** In a {@link CodemodeSandboxBase.start} run: the result the VM was processing when the script finished, 0 for its first run, and the calls issued by then. */
export interface CodemodeDuring {
	seq: number;
	issued: number;
}
