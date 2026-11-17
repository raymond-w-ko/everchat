// Functions
// =========
// What a program can call. In code mode the model has one tool, and what
// the old code gave it as separate tools (shell, read, write, edit, zoom)
// are functions (packages/core/AGENTS.md, "Code mode is the only primary
// tool").
//
// Each function has two parts:
//
// - Its declaration: its name, its signature in TypeScript (or the JSON
//   schemas of its argument and its result, for a function from outside),
//   and what it does. The head shows the declarations to the model
//   (head.ts), so they must not change from one request to the next.
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
// A built-in function gives its whole result to the program. A function
// from outside does up to `MAX` characters (limit.ts); past it the program
// gets the shortened text (`Shortened`) and reads the rest with
// `result(id, from, to)`. The output limit applies to the program's own
// result (limit.ts).
//
// One list for each stack: the stack makes its list of declarations one
// time, and gives that value to the turn loop's layer and the compactor's
// (for the head) and to the layer of `Functions`, whose `make` dies when its
// entries' declarations are not that list (`mismatches`). So the head and
// the sandbox's functions cannot differ.
//
// The check of a list (`refusals`), where the list is built: `make` dies
// for a list with a fault, a defect of the code; the client of functions
// from outside runs it first, and leaves a refused function out. Its rules:
//
// - a declaration has a `signature` or an `inputSchema`: not both, not
//   neither, and no `outputSchema` beside a signature;
// - a name is an identifier, or `ns.member`: one dot, each part an
//   identifier; its first part is no reserved global of the sandbox
//   (`RESERVED`), no global of its engine (`ENGINE_GLOBALS`), no name that
//   its global object inherits (`INHERITED`) and no name that its engine
//   calls by itself (`CALLED`); a namespace is no other function's name; no
//   two names are equal after `toCodemodeIdentifier` (two entries of one
//   name too);
// - the rendered input type and the rendered output type of a declaration
//   with schemas are each at most `TYPE_MAX` characters.
//
// Not here yet: the functions for agents (to start one, to tell one
// something), and `zoom` of an agent's chat.

import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { DEFAULT_INPUT_SCHEMA_MAX_CHARS, schemaToType } from "./codemode/declarations.ts"
import { toCodemodeIdentifier } from "./codemode/identifier.ts"
import type { Declaration, JsonSchema } from "./head.ts"
import { part } from "./limit.ts"
import { Memory } from "./memory.ts"
import { Store, type StoreError } from "./store.ts"

// Declarations
// ------------

// The type is the head's, which shows them.
export type { Declaration, JsonSchema }

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
  signature: "(id: number, from?: number, to?: number): Promise<string>",
  description: "The result of an earlier program or function, by the number that a shortened result names: the whole, or its characters from `from` (0 when not given) to before `to` (the end when not given)."
} as const satisfies Declaration

// The declarations of a host's chat, in the head's order.
export const HOSTED = [ZOOM, DATE, RESULT] as const satisfies ReadonlyArray<Declaration>

// The check of a list
// -------------------

// The sandbox's own globals, which no function's name or namespace may be:
// a copy of the sandbox's list (packages/codemode/src/pi/runtime/execution.ts,
// `RESERVED_GLOBALS`), which the core may not import.
export const RESERVED: ReadonlyArray<string> = ["tools", "ALL_TOOLS", "console", "text", "image", "exit", "globalThis", "store", "load"]

// The engine's own globals, which no function's name or namespace may be
// either: the prelude makes them read-only before it defines the functions
// (packages/codemode/src/pi/runtime/prelude-source.ts, `lockdown`), so a
// function named as one fails the boot of every program of its chat. They
// are the own names of the global object at a program's boot with no
// function, but `RESERVED` (measured on both engines, ec-kcn81: 77 names,
// 68 of them not in `RESERVED`; sandbox.test.ts and inline.test.ts hold
// that the list covers the engine). After them, by trial, two names that
// the global object inherits: a function of the name boots, but hides what
// it gives (`globalThis.__proto__` is no longer `Object.prototype`, a bare
// `constructor` no longer `Object`). A member's name after the dot is free.
export const ENGINE_GLOBALS: ReadonlyArray<string> = [
  "Object", "Function", "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError",
  "InternalError", "AggregateError", "SuppressedError", "Iterator", "Array", "parseInt", "parseFloat", "isNaN",
  "isFinite", "queueMicrotask", "decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent", "escape",
  "unescape", "Infinity", "NaN", "undefined", "eval", "Number", "Boolean", "String", "Math", "Reflect", "Symbol",
  "DisposableStack", "BigInt", "Date", "RegExp", "JSON", "Proxy", "Map", "Set", "WeakMap", "WeakSet", "ArrayBuffer",
  "SharedArrayBuffer", "Uint8ClampedArray", "Int8Array", "Uint8Array", "Int16Array", "Uint16Array", "Int32Array",
  "Uint32Array", "BigInt64Array", "BigUint64Array", "Float16Array", "Float32Array", "Float64Array", "DataView",
  "Promise", "AsyncDisposableStack", "WeakRef", "FinalizationRegistry", "DOMException", "btoa", "atob", "performance",
  "__proto__", "constructor"
]

// The names that the global object inherits, which no function's name or
// namespace may be: a function of the name boots, but it hides the built-in
// in every program of its chat (with a function `toString`,
// `String(globalThis)` fails). They are the own names of each prototype of
// the global object at a program's boot: one, `Object.prototype`, with 12
// names, the same on both engines (measured, ec-l31zd; sandbox.test.ts and
// inline.test.ts hold that the list covers the engine). `__proto__` and
// `constructor` are in `ENGINE_GLOBALS` too, from before (ec-kcn81), and
// keep its sentence.
export const INHERITED: ReadonlyArray<string> = [
  "toString", "toLocaleString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "__proto__",
  "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__", "constructor"
]

// The names that the engine calls by itself on a value that has them, which
// no function's name or namespace may be: `then` (a value with it is taken
// as a promise: `return globalThis` never settles) and `toJSON`
// (`JSON.stringify` calls it).
export const CALLED: ReadonlyArray<string> = ["then", "toJSON"]

// The most characters of a rendered input type, and of a rendered output
// type, of a declaration with schemas: the renderer's own bound of a
// `tools` entry, which a global does not get.
export const TYPE_MAX = DEFAULT_INPUT_SCHEMA_MAX_CHARS

// A function that a list cannot hold: its name, and why, as a sentence.
export interface Refusal {
  readonly name: string
  readonly reason: string
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

// The type of a schema as the head shows it, or undefined when it cannot be
// rendered (a schema from outside may be anything).
const rendered = (schema: JsonSchema): string | undefined => {
  try {
    return schemaToType(schema)
  } catch {
    return undefined
  }
}

// The faults of a list of declarations, in the list's order: none for a good
// list. It throws nothing.
export const refusals = (declarations: ReadonlyArray<Declaration>): ReadonlyArray<Refusal> => {
  const found: Array<Refusal> = []
  const refuse = (name: string, reason: string) => found.push({ name, reason })
  const names = new Set(declarations.map((one) => one.name))
  const identifiers = new Map<string, string>()
  for (const one of declarations) {
    const name = one.name
    const parts = name.split(".")
    if (parts.length > 2 || !parts.every((part) => IDENTIFIER.test(part))) {
      refuse(name, "A name is an identifier, or a namespace and a member with one dot between them.")
    } else if (RESERVED.includes(parts[0] as string)) {
      refuse(name, `"${parts[0]}" is a global of the sandbox.`)
    } else if (ENGINE_GLOBALS.includes(parts[0] as string)) {
      refuse(name, `"${parts[0]}" is a global of the sandbox's engine.`)
    } else if (INHERITED.includes(parts[0] as string)) {
      refuse(name, `"${parts[0]}" is a name that the sandbox's global object inherits.`)
    } else if (CALLED.includes(parts[0] as string)) {
      refuse(name, `"${parts[0]}" is a name that the sandbox's engine calls by itself.`)
    } else if (parts.length === 2 && names.has(parts[0] as string)) {
      refuse(name, `Its namespace "${parts[0]}" is the name of another function.`)
    }
    const identifier = toCodemodeIdentifier(name)
    const before = identifiers.get(identifier)
    if (before === undefined) identifiers.set(identifier, name)
    else refuse(name, before === name ? "Another function before it has this name." : `Its identifier ${identifier} is that of "${before}", before it.`)
    const schemas = one.inputSchema !== undefined || one.outputSchema !== undefined
    if (one.signature !== undefined && schemas) {
      refuse(name, "It has a signature and a schema: give one of them.")
    } else if (one.signature === undefined && one.inputSchema === undefined) {
      refuse(name, "It has no signature and no input schema: give one of them.")
    } else if (one.signature === undefined) {
      for (const [what, schema] of [["input", one.inputSchema], ["output", one.outputSchema]] as const) {
        if (schema === undefined) continue
        const type = rendered(schema)
        if (type === undefined) refuse(name, `Its ${what} schema cannot be shown as a type.`)
        else if (type.length > TYPE_MAX) refuse(name, `Its ${what} type is ${type.length} characters, more than ${TYPE_MAX}.`)
      }
    }
  }
  return found
}

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

// A result that the program gets shortened: the call's row keeps `whole`,
// and the program gets the text `given` (`given` of limit.ts), never this
// object. No built-in function gives one; a function from outside does,
// for a result over `MAX`.
export class Shortened {
  constructor(readonly whole: string, readonly given: string) {}
}

// One function: its declaration, and its work. A result must be a JSON
// value, or a `Shortened`. `args` is always the list of the call's arguments, as the call's
// row keeps it (its `input`, as JSON): a function with a signature gets
// what the program gave, one with an `inputSchema` gets `[object]`. So a
// later run of a recorded call is `call(name, JSON.parse(input), caller)`
// for every function.
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
        message: "Wrong arguments: " + cause.message.replace(/\s*\n\s*/g, " ") + ". Use " + declaration.name + (declaration.signature ?? "(args)") + "."
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
  // Runs one function with the list of its arguments (`Entry`). A result
  // must be a JSON value, or a `Shortened`: its row keeps `whole`, and the
  // program gets `given`.
  call(name: string, args: ReadonlyArray<unknown>, caller: Caller): Effect.Effect<unknown, FunctionError>
}>()("everchat/functions/Functions") {}

// How the declarations of `entries` differ from `declarations`, the list of
// the head, as sentences: none when they are that list. Each check is apart
// from the others: a name of the list that no entry has, a name of an entry
// that the list does not have, the names that both have in another order,
// and a name whose entry's declaration is another than the list's.
export const mismatches = (declarations: ReadonlyArray<Declaration>, entries: ReadonlyArray<Entry>): ReadonlyArray<string> => {
  const listed = declarations.map((one) => one.name)
  const given = entries.map((one) => one.declaration.name)
  const quoted = (names: ReadonlyArray<string>) => names.map((name) => `"${name}"`).join(", ")
  const found: Array<string> = []
  const missing = listed.filter((name) => !given.includes(name))
  if (missing.length > 0) found.push(`The list has ${quoted(missing)}, and no entry.`)
  const extra = given.filter((name) => !listed.includes(name))
  if (extra.length > 0) found.push(`An entry has ${quoted(extra)}, and the list does not.`)
  const both = listed.filter((name) => given.includes(name))
  const order = given.filter((name) => listed.includes(name))
  if (both.join("\n") !== order.join("\n")) found.push(`The list has ${quoted(both)} in this order, and the entries ${quoted(order)}.`)
  for (const one of declarations) {
    const entry = entries.find((each) => each.declaration.name === one.name)
    if (entry !== undefined && JSON.stringify(entry.declaration) !== JSON.stringify(one)) found.push(`The entry of "${one.name}" has another declaration than the list's.`)
  }
  return found
}

// The service over a list of functions: `declarations`, the list that the
// head of the same stack shows (one value, given to the turn loop's layer,
// the compactor's and this one), and `entries`, the functions themselves.
// The entries' declarations must be that list, in its order: another one is
// a defect of the code, as is a list that `refusals` refuses. Then `make`
// throws, so the layer that calls it dies at its build, with the names in
// its message.
export const make = (declarations: ReadonlyArray<Declaration>, entries: ReadonlyArray<Entry>) => {
  const differ = mismatches(declarations, entries)
  if (differ.length > 0) {
    throw new Error("The functions are not the list of the head: " + differ.join(" "))
  }
  const refused = refusals(declarations)
  if (refused.length > 0) {
    throw new Error("The list of functions is refused: " + refused.map((one) => `"${one.name}": ${one.reason}`).join(" "))
  }
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
// A bound of a part of a result: a whole number of 0 or more.
const bound = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const resultArgs = decoder(RESULT, Schema.Tuple([Schema.Int, maybe(bound), maybe(bound)]))

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

  // A call's output, from the store: the whole, or the part from `from` to
  // before `to` (`part`, limit.ts). It reads and writes no file: `read`
  // gives the whole text too, for a layer that keeps a copy of it.
  const read = Effect.fnUntraced(function*(args: ReadonlyArray<unknown>) {
    const [id, from, to] = yield* resultArgs(args)
    if (from != null && to != null && from > to) {
      return yield* new FunctionError({ message: "Wrong arguments: from (" + from + ") is over to (" + to + "). Use " + RESULT.name + RESULT.signature + "." })
    }
    const call = yield* stored(store.call(id))
    if (call._tag === "None") {
      return yield* new FunctionError({ message: "No call " + id + "." })
    }
    const whole = call.value.output
    if (whole === null) {
      return yield* new FunctionError({ message: "Call " + id + " still runs: it has no result yet." })
    }
    return { id, whole, part: part(whole, from ?? 0, to ?? whole.length) }
  })
  const result: Entry & { readonly read: typeof read } = {
    declaration: RESULT,
    read,
    run: (args) => Effect.map(read(args), (got) => got.part)
  }

  return { zoom, date, result }
})

// The functions of a host's chat (`HOSTED`, in its order), over
// `declarations`, the list of the stack's head: it dies at its build when
// that list is not `HOSTED` (`make`).
export const hostedLayer = (declarations: ReadonlyArray<Declaration>): Layer.Layer<Functions, never, Store | Memory> =>
  Layer.effect(
    Functions,
    Effect.gen(function*() {
      const entries = yield* core
      return make(declarations, HOSTED.map((one) => entries[one.name]))
    })
  )
