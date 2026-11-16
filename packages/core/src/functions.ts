// Functions
// =========
// What a program can call. In code mode the model has one tool, and what
// the old code gave it as separate tools (shell, read, write, edit, zoom)
// are functions (packages/core/AGENTS.md, "Code mode is the only primary
// tool").
//
// Each function has two parts:
//
// - Its declaration: its name, its signature in TypeScript, and what it
//   does. It is text that the program owns. The head shows the
//   declarations to the model (head.ts), so they must not change from one
//   request to the next.
// - Its work: it runs with the arguments that a program gave.
//
// The service `Functions` holds a list of them: it gives their
// declarations, and it runs a function by its name. The sandbox calls it,
// and a test can give other functions.
//
// This file is the core's part: the service, and the functions that need
// only the memory and the store (`zoom`, `date`, `result`). They are the
// whole list of a chat that has no machine, a host's chat (`HOSTED`,
// `hostedLayer`; docs/host.md, "The functions of a host's chat: the hosted
// set"). The functions that need the shell, the files or the work
// directory, and the layer of a local chat's list, are in
// `packages/local/src/localfunctions.ts`.
//
// A program's arguments cross a boundary (they come out of the sandbox as
// JSON), so each function decodes them with a schema. An argument that the
// program left out, or gave as `undefined`, arrives as nothing or as null.
//
// A function gives its whole result to the program. The output limit
// applies to the program's own result (limit.ts).
//
// Not here yet: the functions for agents (to start one, to tell one
// something), and `zoom` of an agent's chat.

import { Context, DateTime, Effect, Layer, Schema } from "effect"
import type { Declaration } from "./head.ts"
import { Memory } from "./memory.ts"
import { Store, type StoreError } from "./store.ts"

// Declarations
// ------------

// The type is the head's, which shows them.
export type { Declaration }

export const ZOOM = {
  name: "zoom",
  signature: "(id: number, n?: number, at?: number): Promise<string>",
  description: "Opens the line id+n of the view into the two lines of n/2 messages below it. With n = 1 (or not given), it gives message id whole. A long message comes in pages from character `at`, and says where to go on."
} as const satisfies Declaration

export const DATE = {
  name: "date",
  signature: "(id: number): Promise<string>",
  description: "The date and time of message id."
} as const satisfies Declaration

export const RESULT = {
  name: "result",
  signature: "(id: number): Promise<string>",
  description: "The whole result of an earlier program or function, by the number that a shortened result names."
} as const satisfies Declaration

// The declarations of a host's chat, in the head's order.
export const HOSTED = [ZOOM, DATE, RESULT] as const satisfies ReadonlyArray<Declaration>

// Errors and types
// ----------------

// Why a function did not do its work. The program that called it gets the
// message as an error that it can catch.
export class FunctionError extends Schema.TaggedError<FunctionError>()("FunctionError", {
  message: Schema.String
}) {}

// Who calls: the turn, the program (its call), and this function's own call.
export interface Caller {
  readonly turn: number
  readonly program: number
  readonly call: number
}

// One function: its declaration, and its work. A result must be a JSON
// value.
export interface Entry {
  readonly declaration: Declaration
  readonly run: (args: ReadonlyArray<unknown>, caller: Caller) => Effect.Effect<unknown, FunctionError>
}

// Arguments
// ---------

// A parameter that the program may leave out.
export const maybe = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema))

// The arguments of a function, decoded with `schema`. A wrong argument says
// which one, and shows the signature.
export const decoder = <S extends Schema.Top>(declaration: Declaration, schema: S) =>
(args: ReadonlyArray<unknown>): Effect.Effect<S["Type"], FunctionError> =>
  Effect.mapError(
    Schema.decodeUnknownEffect(schema as unknown as Schema.Codec<S["Type"]>)(args),
    (cause) =>
      new FunctionError({
        message: "Wrong arguments: " + cause.message.replace(/\s*\n\s*/g, " ") + ". Use " + declaration.name + declaration.signature + "."
      })
  )

// A database failure, as a function's error.
export const stored = <A>(effect: Effect.Effect<A, StoreError>) =>
  Effect.mapError(effect, (cause) => new FunctionError({ message: "EverChat's database failed (" + cause.op + ")." }))

// Service
// -------

export class Functions extends Context.Service<Functions, {
  // The declarations of the functions, in the order that the head shows
  // them.
  readonly declarations: ReadonlyArray<Declaration>
  // The functions that a program can call.
  readonly names: ReadonlyArray<string>
  // Runs one function. A result must be a JSON value.
  call(name: string, args: ReadonlyArray<unknown>, caller: Caller): Effect.Effect<unknown, FunctionError>
}>()("everchat/functions/Functions") {}

// The service over a list of functions, in the order of the list.
export const make = (entries: ReadonlyArray<Entry>) => {
  const declarations = entries.map((one) => one.declaration)
  const names: ReadonlyArray<string> = declarations.map((one) => one.name)
  const byName = new Map(entries.map((one) => [one.declaration.name, one.run]))
  return Functions.of({
    declarations,
    names,
    call: (name, args, caller) => {
      const found = byName.get(name)
      return found === undefined ? Effect.fail(new FunctionError({ message: "No function " + name + "." })) : found(args, caller)
    }
  })
}

// The core's functions
// --------------------

const zoomArgs = decoder(ZOOM, Schema.Tuple([Schema.Union([Schema.Int, Schema.String]), maybe(Schema.Int), maybe(Schema.Int)]))
const dateArgs = decoder(DATE, Schema.Tuple([Schema.Int]))
const resultArgs = decoder(RESULT, Schema.Tuple([Schema.Int]))

// The functions that need only the memory and the store.
export const core = Effect.gen(function*() {
  const store = yield* Store
  const memory = yield* Memory

  const zoom: Entry = {
    declaration: ZOOM,
    run: Effect.fnUntraced(function*(args) {
      const [id, n, at] = yield* zoomArgs(args)
      const message = typeof id === "number" ? id : /^\d+$/.test(id) ? Number(id) : null
      if (message === null) {
        return yield* new FunctionError({ message: "No agent " + id + "." })
      }
      return yield* stored(memory.zoom(message, n ?? 1, at ?? 0))
    })
  }

  const date: Entry = {
    declaration: DATE,
    run: Effect.fnUntraced(function*(args) {
      const [id] = yield* dateArgs(args)
      const [message] = id < 0 ? [] : yield* stored(store.messages(id, id + 1))
      if (message === undefined) {
        return yield* new FunctionError({ message: "No message " + id + "." })
      }
      return DateTime.formatLocal(DateTime.makeUnsafe(message.created), { locale: "sv-SE", dateStyle: "short", timeStyle: "medium" })
    })
  }

  // A call's whole output, from the store. It reads and writes no file.
  const result = {
    declaration: RESULT,
    run: Effect.fnUntraced(function*(args) {
      const [id] = yield* resultArgs(args)
      const call = yield* stored(store.call(id))
      if (call._tag === "None") {
        return yield* new FunctionError({ message: "No call " + id + "." })
      }
      const output = call.value.output
      if (output === null) {
        return yield* new FunctionError({ message: "Call " + id + " still runs: it has no result yet." })
      }
      return output
    })
  } satisfies Entry

  return { zoom, date, result }
})

// The functions of a host's chat: `HOSTED`, in its order.
export const hostedLayer: Layer.Layer<Functions, never, Store | Memory> = Layer.effect(
  Functions,
  Effect.gen(function*() {
    const entries = yield* core
    return make(HOSTED.map((one) => entries[one.name]))
  })
)
