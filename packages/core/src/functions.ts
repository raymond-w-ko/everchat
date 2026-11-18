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
// from outside runs it first, and leaves a refused function out. It throws
// for no list: a list from outside may hold anything. Its rules:
//
// - an entry is an object whose name is a text;
// - a declaration has a `signature` or an `inputSchema`: not both, not
//   neither, and no `outputSchema` beside a signature;
// - a name is an identifier, or `ns.member`: one dot, each part an
//   identifier; its first part is no reserved word of JavaScript
//   (`RESERVED_WORDS`), no reserved global of the sandbox (`RESERVED`), no
//   global of its engine (`ENGINE_GLOBALS`), no name that its global object
//   inherits (`INHERITED`) and no name that its engine calls by itself
//   (`CALLED`); its member, after the dot, is no name of `CALLED` either,
//   and is free of the other lists; a namespace is no other function's
//   name; no two names are equal after `toCodemodeIdentifier` (two entries
//   of one name too);
// - the rendered input type and the rendered output type of a declaration
//   with schemas are each at most `TYPE_MAX` characters.
//
// Not here yet: the functions for agents (to start one, to tell one
// something), and `zoom` of an agent's chat.

import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { DEFAULT_INPUT_SCHEMA_MAX_CHARS, schemaToType } from "./codemode/declarations.ts"
import { toCodemodeIdentifier } from "./codemode/identifier.ts"
import type { Declaration, JsonSchema } from "./head.ts"
import { part } from "./limit.ts"
import { Memory } from "./memory.ts"
import { type Approval, Store, type StoreError, type WakeOf } from "./store.ts"

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
// no function's name, namespace or member may be: `then` (a value with it
// is taken as a promise: `return globalThis` never settles, and `await ns`,
// `return ns` or `Promise.race([ns])` calls a member `ns.then`) and `toJSON`
// (`JSON.stringify` calls it). A member of the list would be a call that the
// program never wrote, and one that needs approval would ask a person for
// it (ec-lsny0).
export const CALLED: ReadonlyArray<string> = ["then", "toJSON"]

// The reserved words of JavaScript, which no function's name or namespace
// may be: the head would declare `declare const delete: …`, and no program
// can name it. The reserved words of the standard (ECMA-262, "Keywords and
// Reserved Words") and those of strict mode, with `await` and `yield`: a
// program is the body of an async function. Each is no name of a binding in
// such a body on either engine (sandbox.test.ts and inline.test.ts). A
// member after the dot is free (`ns.delete` is a property), but for
// `CALLED`.
export const RESERVED_WORDS: ReadonlyArray<string> = [
  "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum",
  "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "new", "null", "return",
  "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield", "implements",
  "interface", "let", "package", "private", "protected", "public", "static"
]

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

// An entry of a list with a name: an object whose `name` is a text.
const named = (one: unknown): one is Declaration =>
  typeof one === "object" && one !== null && typeof (one as { readonly name?: unknown }).name === "string"

// The faults of a list of declarations, in the list's order: none for a good
// list. It throws for no list: an entry that is no object, or whose name is
// no text (a hole of the list too), is refused with the empty text as its
// name, and no other rule is checked for it.
export const refusals = (declarations: ReadonlyArray<Declaration>): ReadonlyArray<Refusal> => {
  const found: Array<Refusal> = []
  const refuse = (name: string, reason: string) => found.push({ name, reason })
  // `Array.from` reads a hole as undefined, which `map` would skip.
  const entries: ReadonlyArray<unknown> = Array.from(declarations)
  const names = new Set(entries.filter(named).map((one) => one.name))
  const identifiers = new Map<string, string>()
  for (const one of entries) {
    if (!named(one)) {
      refuse("", "The name is no text.")
      continue
    }
    const name = one.name
    const parts = name.split(".")
    if (parts.length > 2 || !parts.every((part) => IDENTIFIER.test(part))) {
      refuse(name, "A name is an identifier, or a namespace and a member with one dot between them.")
    } else if (RESERVED_WORDS.includes(parts[0] as string)) {
      refuse(name, `"${parts[0]}" is a reserved word of JavaScript.`)
    } else if (RESERVED.includes(parts[0] as string)) {
      refuse(name, `"${parts[0]}" is a global of the sandbox.`)
    } else if (ENGINE_GLOBALS.includes(parts[0] as string)) {
      refuse(name, `"${parts[0]}" is a global of the sandbox's engine.`)
    } else if (INHERITED.includes(parts[0] as string)) {
      refuse(name, `"${parts[0]}" is a name that the sandbox's global object inherits.`)
    } else if (CALLED.includes(parts[0] as string)) {
      refuse(name, `"${parts[0]}" is a name that the sandbox's engine calls by itself.`)
    } else if (parts.length === 2 && CALLED.includes(parts[1] as string)) {
      refuse(name, `"${parts[1]}" is a name that the sandbox's engine calls by itself.`)
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
//
// `approval`: true for a function that needs a person's yes before each
// run. A program's call of it does not run: the sandbox records the call
// and gives the program `pending(n)` (packages/codemode/src/calls.ts,
// `invoke`). It is not in the declaration, so the head and its bytes do not
// change with a setting.
export interface Entry {
  readonly declaration: Declaration
  readonly run: (args: ReadonlyArray<unknown>, caller: Caller) => Effect.Effect<unknown, FunctionError>
  readonly approval?: boolean
}

// What a program gets for a call that waits for a person's yes or no, as
// the approval `approval` (the store's `pendCall`): the call did not run.
export const pending = (approval: number) => ({
  pending: approval,
  note: "This call did not run. It waits for a person's yes or no, as approval " + approval +
    ". Go on without its result: it comes in a later turn if the person says yes."
})

// The most characters of a call's input in the note of its approval.
export const WAITS_INPUT = 500

// The note that the log keeps of a call that waits, after its program
// (turn.ts): its approval's number, its function and its input as
// `shownInput` gives it (no outer brackets, at most WAITS_INPUT characters,
// then each hidden code point as its escape, `visible`).
export const waits = (approval: Approval): string =>
  "Approval " + approval.id + " waits for a person's yes or no: " + approval.fn + "(" + shownInput(approval.input) + "). The call did not run."

// A time on a zone's wall clock, to the minute, with the zone's name:
// `2026-11-16 09:00 Europe/Berlin`. A time that the zone repeats has one
// text for its two instants. A name that the engine does not know (a row
// is data) gives the time in UTC, named `UTC`: it never throws. The
// wake-ups' texts of a slot (packages/wakeups, `slotText`) are this one.
export const wallClock = (at: number, zone: string): string => {
  const named = Option.getOrElse(DateTime.zoneMakeNamed(zone), () => DateTime.zoneMakeNamedUnsafe("UTC"))
  const parts = DateTime.toParts(DateTime.makeZonedUnsafe(at, { timeZone: named }))
  const two = (n: number) => String(n).padStart(2, "0")
  return `${String(parts.year).padStart(4, "0")}-${two(parts.month)}-${two(parts.day)} ${two(parts.hour)}:${two(parts.minute)} ${DateTime.zoneToString(named)}`
}

// The note that the log keeps of a wake-up that a call of a program made
// or stopped (`store.wakesOf`), after its program and after the approvals'
// notes (turn.ts): a make gives the row's first fire on its wall clock,
// from `first`, never from `due`, which a fire or a stop moves; a stop by
// the model gives the row's id.
export const wakeNote = (of: WakeOf): string =>
  of.by === "made" ? "Wake-up " + of.wake.id + " set: next " + wallClock(of.wake.first, of.wake.zone) : "Wake-up " + of.wake.id + " stopped."

// A text of a model or a server as a person reads it (the terminal's
// lines of an approval, and the notes of an approval through `shownInput`),
// so that the person sees every character of it and its order. Each code point that
// draws as nothing, or that can move the cursor, change the order on the
// screen or hide a part, is an escape: those of the General_Category Cc
// (C0, DEL, C1), Cf (the bidi controls, the zero-width ones, U+FEFF, the
// soft hyphen, the tags), Cs (a surrogate with no pair), Co (private use),
// Cn (unassigned), Zl and Zp (U+2028, U+2029), and each one with the
// property Default_Ignorable_Code_Point (the variation selectors, the
// fillers such as U+3164 and U+115F, U+034F). The match is by code point.
// The escape: below U+0100 `\x1b`, else `\u{202e}` (small letters, no
// leading zero). A line end is one too: such a text is on one line.
//
// Shown as they are: the spaces of Zs, a mark that joins a letter, and the
// letters of a script written from right to left (their order on the
// screen is the terminal's). An emoji that needs U+FE0F or U+200D is shown
// in parts, with the escapes between: the text is exact before it is
// pretty.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu

export const visible = (text: string): string =>
  text.replace(HIDDEN, (one) => {
    const code = one.codePointAt(0)!
    return code < 0x100 ? "\\x" + code.toString(16).padStart(2, "0") : "\\u{" + code.toString(16) + "}"
  })

// A call's input as the notes of its approval show it (`waits`, and the
// messages of approval.ts): with no outer brackets, at most WAITS_INPUT
// characters (a cut ends with "…", and never parts a pair of surrogates),
// then through `visible`: the cut first, then the escapes, so each note
// has the arguments with the escapes for every reader (the terminal, a
// page, the model). The call's row keeps its `input` exact.
export const shownInput = (input: string): string => {
  const open = input[0]
  const bare = input.length >= 2 && ((open === "{" && input.endsWith("}")) || (open === "[" && input.endsWith("]"))) ? input.slice(1, -1) : input
  // A well-formed text has a high surrogate only before its low one.
  const code = bare.charCodeAt(WAITS_INPUT - 1)
  return bare.length <= WAITS_INPUT ? visible(bare) : visible(bare.slice(0, code >= 0xd800 && code <= 0xdbff ? WAITS_INPUT - 1 : WAITS_INPUT)) + "…"
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
  // The names of the functions that need a person's yes before each run
  // (`Entry.approval`): a program's call of one does not run, and waits
  // (packages/codemode/src/calls.ts, `invoke`). `call` runs them as any
  // other: the run after a yes uses it.
  readonly approval: ReadonlySet<string>
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
// its message. The refusals come first: `mismatches` reads each
// declaration's name, which a refused entry may not have.
export const make = (declarations: ReadonlyArray<Declaration>, entries: ReadonlyArray<Entry>) => {
  const refused = refusals(declarations)
  if (refused.length > 0) {
    throw new Error("The list of functions is refused: " + refused.map((one) => `"${one.name}": ${one.reason}`).join(" "))
  }
  const differ = mismatches(declarations, entries)
  if (differ.length > 0) {
    throw new Error("The functions are not the list of the head: " + differ.join(" "))
  }
  const names: ReadonlyArray<string> = declarations.map((one) => one.name)
  const byName = new Map(entries.map((one) => [one.declaration.name, one.run]))
  const approval: ReadonlySet<string> = new Set(entries.filter((one) => one.approval === true).map((one) => one.declaration.name))
  return Functions.of({
    declarations,
    names,
    approval,
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
  // gives the whole text too, for a layer that keeps a copy of it. A call
  // that waited for approval (`pending`) has the output of its run after a
  // yes, which its approval's row keeps (approval.ts); before the run's
  // end, or after a no or an expiry, it has none.
  // The output of a pending call's run, or why it has none.
  const approved = Effect.fnUntraced(function*(id: number) {
    const found = yield* stored(store.approvalOf(id))
    if (found._tag === "None") {
      return yield* new FunctionError({ message: "Call " + id + " waits for approval: it has no result yet." })
    }
    const approval = found.value
    if (approval.status === "no") {
      return yield* new FunctionError({ message: "Call " + id + " did not run: the person said no to approval " + approval.id + "." })
    }
    if (approval.status === "expired") {
      return yield* new FunctionError({ message: "Call " + id + " did not run: approval " + approval.id + " expired with no answer." })
    }
    if (approval.ended === null || approval.output === null) {
      return yield* new FunctionError({ message: "Call " + id + " waits for approval " + approval.id + ": it has no result yet." })
    }
    return approval.output
  })
  const read = Effect.fnUntraced(function*(args: ReadonlyArray<unknown>) {
    const [id, from, to] = yield* resultArgs(args)
    if (from != null && to != null && from > to) {
      return yield* new FunctionError({ message: "Wrong arguments: from (" + from + ") is over to (" + to + "). Use " + RESULT.name + RESULT.signature + "." })
    }
    const call = yield* stored(store.call(id))
    if (call._tag === "None") {
      return yield* new FunctionError({ message: "No call " + id + "." })
    }
    const whole = call.value.status === "pending" ? yield* approved(id) : call.value.output
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
