// The client of MCP servers: the functions from outside of a chat. It loads
// a server's definitions and gives a chat's stack their declarations and
// their entries, of the core's shape, so that a program calls a server's
// tool as it calls any other function. The local connectors use it now, and
// the provider of a hosted deployment later; neither imports the other, and
// the core does not know this package. It has no transport of its own: the
// caller gives one (a program on stdio in the local build, or an address
// over HTTP).
//
// The load (`load`)
// -----------------
//
// From a list of servers to the functions of a chat's list. What a server
// gives is input from outside: it reaches the head of the chat, which the
// model reads. So every definition is checked before it becomes a
// declaration, and no server can stop a load: a server that does not answer
// in time, or fails, gives no function and one refusal, and the others load.
//
// - The servers load side by side, each under one time limit (`load`) for
//   its connection, every page of its list of tools and the checks of its
//   definitions (G5): the checks run one definition for each step, with a
//   yield between two, and a server whose checks have not ended when the
//   limit passes is refused whole. No step of one definition is long: G2,
//   G4 and H4 bound it. The client pins the version of the protocol
//   (`VERSION`): the SDK's default is the old handshake.
// - The pages are asked by the client's public `request`, not by the SDK's
//   `listTools` (G8), which scans each raw schema and writes to the
//   console: at most PAGES pages; a cursor that comes again, or a page past
//   the last, refuses the server ("Its list of tools failed.").
// - A page of the list that the SDK's codec refuses ends that server's
//   load: the SDK checks each page against its own schema of the protocol
//   before this file sees a definition, so one malformed tool refuses the
//   server's whole list (2.4.0; the lead's ruling on ec-x890l).
// - The definitions are ordered by name (code units), and nothing makes a
//   JSON text of one as the server sent it (G6): two of one name are both
//   refused. A throw while one definition is handled is that tool's
//   refusal, and one while the list is handled is the server's (G7): the
//   load never fails by what a server sent.
// - Each definition is then checked with `pi-schema` (`DEFINITION`): its
//   name, its description, the kind of its schemas. Then each schema gets
//   its form and its shown schema ("The form of a schema"), before anything
//   else reads it. A fault refuses that tool, and the server's other tools
//   stay. The declaration takes only the name, the description and the two
//   shown schemas, never the schemas as they came (H1): a field that this
//   client does not know is no fault, and is not copied.
// - A tool's setting (`Setting`) comes from the server's: `deny` leaves it
//   out, `ask` lets it in with `approval: true` (a program's call of it
//   waits for a person's yes: the core's `Entry`), `auto` lets it in with no
//   flag. A server that is `marked` (a hosted provider's) also gates each
//   tool whose definition's `_meta` has the own key `io.everchat/approval`
//   (`MARK`) with a value other than `false`, whatever its setting but
//   `deny`. Without `marked`, the key is not read.
// - The function's name is `<server>.<member>`, the member the tool's name
//   made an identifier (`toCodemodeIdentifier`); the entry keeps the tool's
//   own name for the call.
// - The list is sorted by name, by code units, so the same definitions give
//   the same list byte for byte, in any order of the servers and their
//   pages. Then the core's check of a list (`refusals`, functions.ts) runs
//   over the built-in functions (`beside`) and this list: a function that it
//   refuses is left out, and a built-in never is. Then the bounds: at most
//   `count` functions, at most `budget` characters of their rendered
//   declarations together, and at most `HEAD_RENDER` of their weights
//   together (H9: a function's shown size times its levels, summed over
//   its input and its output schema). So the render of the head at the
//   launch reads the shown schemas of at most `count` kept functions, each
//   within H4, and their sum within H9 (H6).
// - Each refusal is also a warning of Effect's log, with the source `mcp`.
//   Its reason is a sentence of this file, with the server's and the tool's
//   names: never a text of the transport (an address, a header, a variable).
//
// The connections live in the caller's scope, and close with it, all at
// one time: the scope's end runs every close side by side and waits for
// each, so it takes as long as the slowest close, not their sum. A server
// that failed starts its close at once, and the load does not wait for it:
// the scope's end does, under the same bound.
//
// The call (an entry's `run`)
// ---------------------------
//
// From a program's call to the server's tool, and back. The arguments and
// the result are input from outside too: each is checked by EverChat
// itself, with `pi-schema` and no coercion, against the form of its schema,
// under the bound of its work ("The form of a schema"). The SDK checks
// neither: the client gives it a check that takes every value
// (`TAKES_ALL`).
//
// - The arguments are `[object]` (the core's `Entry`). The object is checked
//   against the form of the definition's `inputSchema` before anything is
//   sent: a fault is a `FunctionError` with each fault's path and sentence
//   (or, past the bound of the list's work, with no list), and the server
//   sees no call. A check whose work would pass `work` is not run: the call
//   is refused, and nothing is sent.
// - The call is the SDK's `callTool`, with the tool's own name, under a time
//   limit (`call`), and with a signal that the interruption of the entry's
//   effect aborts: when the program ends or is stopped, the request ends,
//   and the SDK tells the server it is cancelled. Calls on one connection
//   may run at one time: there is no lock. Its options carry a definition
//   of EverChat's own, `{ name, inputSchema: { type: "object" } }` (G9), so
//   the SDK scans, compiles and asks again nothing of the server's. So no
//   `Mcp-Param-*` header is sent (G10): a server over HTTP that asks for
//   one refuses the call, and the program gets that refusal.
// - An error is a `FunctionError` with the server's or the SDK's text: a
//   result with `isError`, a refusal of the protocol (an unknown tool), the
//   time limit, a connection that is gone (it names the server), a cause
//   that has no text (a value with a null prototype: the ordinary sentence
//   of a failed call). After a time limit the connection serves the next
//   call. Nothing connects again: the next load does. The text from
//   outside in an error (the server's text, the SDK's, the faults of a
//   check) is bounded too, by `quoted` (see "The cap").
// - The result. With an `outputSchema`, its `structuredContent` must be
//   there (the SDK says so first) and pass EverChat's check against the
//   form of that schema, and the program gets that object. A check whose
//   work would pass `work` is not run: the call fails. An object nested so
//   deep that the check or its JSON text overflows the stack (a
//   `RangeError`) is the server's failure: a `FunctionError` that names the
//   server and says that its result is nested too deep.
//   With none, the text parts of `content`, joined by a line end; a part of
//   another kind (an image, a sound, a resource) is one line that names its
//   kind and its type, without its data.
// - The cap. The result's text is that text, or the JSON text of the
//   object. More than `hard` bytes (`HARD` of the core's limit.ts) is a
//   `FunctionError` that says the size: refused, never cut with no way to
//   the rest. More than `max` characters (`MAX`): the entry gives a
//   `Shortened` (functions.ts), whose `whole` the call's row keeps, and
//   whose `given`, the head, a line that names `result(<call>, from, to)`
//   and the tail, the program gets. The `Shortened` is the entry's whole
//   value, never a part of one: only that is seen (calls.ts).
// - An error's text from outside has the same bounds: more than `hard`
//   bytes is not shown (its size and the bound are); more than `max`
//   characters is cut to its first `max`, with a closing part that gives
//   the whole count. An error is a message: it has no way to the rest, and
//   a `Shortened` is never a failure. A list of faults stops once it is
//   past `max` characters, and its closing part gives the count of all.
// - Nothing here writes the store: the call's row is calls.ts's.

import { compile, lit, map, obj, opt, str, unknown, type Validator } from "@earendil-works/pi-schema"
import { type Caller, type Declaration, type Entry, FunctionError, type JsonSchema, refusals, Shortened } from "@everchat/core/functions"
import { bytes, given as givenOf, HARD, MAX, part } from "@everchat/core/limit"
import { renderDeclarations, toCodemodeIdentifier } from "@everchat/core/declarations"
import { globalOf } from "@everchat/core/head"
import { type CallToolResult, Client, type JsonSchemaValidator, type jsonSchemaValidator, ProtocolError, SdkError, SdkErrorCode, type Transport } from "@modelcontextprotocol/client"
import { Effect, type Scope } from "effect"

// The version of the protocol that the client pins.
export const VERSION = "2026-07-28"

// Shapes
// ------

// What a tool may do: run at once, run after a yes, or never be offered.
export type Setting = "auto" | "ask" | "deny"

// A server, as the caller gives it. `name` is the namespace of its
// functions. `transport` makes the SDK's transport (a program on stdio, an
// address over HTTP): this package makes none. `approval` is the setting of
// each of its tools, `tools` the setting of one tool by its own name, which
// wins; with neither, a tool is `auto`. `marked`: the server's definitions
// may mark a tool that needs approval (`MARK`); a hosted provider sets it,
// the local connectors do not.
export interface Server {
  readonly name: string
  readonly transport: () => Transport
  readonly approval?: Setting
  readonly tools?: Readonly<Record<string, Setting>>
  readonly marked?: boolean
}

// The key of a definition's `_meta` that marks a tool that needs a
// person's yes before each call, read only for a `marked` server.
export const MARK = "io.everchat/approval"

// A function from outside: the core's entry, with the server, the tool's
// own name, the `_meta` object of its definition (or undefined), and the
// forms of its schemas that its checks use ("The form of a schema").
export interface Outside extends Entry {
  readonly server: string
  readonly tool: string
  readonly meta: Readonly<Record<string, unknown>> | undefined
  readonly form: { readonly input: unknown; readonly output: unknown }
}

// A server or a tool that the load left out, and why, as a sentence.
export interface Refused {
  readonly server: string
  readonly tool?: string
  readonly reason: string
}

// What a load gives: the declarations and the entries in one order, and
// every refusal.
export interface Loaded {
  readonly declarations: ReadonlyArray<Declaration>
  readonly entries: ReadonlyArray<Outside>
  readonly refused: ReadonlyArray<Refused>
}

// `beside`: the declarations of the stack's built-in functions. `load`: the
// time limit of one server's load, in ms. `call`: of one call, in ms (the
// call's). `tools`: the most definitions taken from one server. `count`:
// the most functions from outside. `budget`: the most characters of their
// rendered declarations together. `max`: the most characters of a call's
// result that a program is given whole (the call's). `hard`: the most bytes
// of a call's result; a larger one is refused (the call's). `work`: the
// bound of the work of one check of a value ("The form of a schema").
export interface Options {
  readonly beside: ReadonlyArray<Declaration>
  readonly load?: number
  readonly call?: number
  readonly tools?: number
  readonly count?: number
  readonly budget?: number
  readonly max?: number
  readonly hard?: number
  readonly work?: number
}

// The bounds of a schema's form ("The form of a schema"): its most parts,
// its most size (`sizeOf`), its most schema levels, and the most pairs of a
// property and a `required` name summed over its schemas. Then the bound of
// a check's work, and the most pages of a server's list of tools. Then the
// bounds of a shown schema (H2, H4): the most size of a `default` that it
// copies and the most units of a `format` or a `pattern` (the renderer
// shows no tag of more than 80 characters), and the most of its size times
// the form's levels.
export const FORM = 50_000
export const FORM_SIZE = 1_000_000
export const DEPTH = 64
export const PAIRS = 1_000_000
export const WORK = 100_000_000
export const PAGES = 64
export const TAG = 80
export const RENDER = 2_000_000
// The most of the sum of the weights (H4's size times levels, over the
// input and the output schema) of the kept functions together (H9): two
// times RENDER, so one function with both schemas at RENDER still fits.
export const HEAD_RENDER = 4_000_000

export const DEFAULTS = {
  load: 10_000,
  call: 60_000,
  tools: 256,
  count: 100,
  budget: 32_768,
  max: MAX,
  hard: HARD,
  work: WORK
} as const

// The check of a definition
// -------------------------

// A tool's name, as the protocol advises it.
const NAME = "^[A-Za-z0-9_.-]{1,128}$"

// The most characters of a description; a longer one is refused, not cut.
const DESCRIPTION_MAX = 1024

// A definition of a tool, as this client takes it. Other fields are no
// fault. That `inputSchema` is an object schema is checked here too, though
// the SDK at 2.4.0 refuses the page first: so this check does not lean on
// the SDK's version.
const DEFINITION = compile(obj({
  name: str({ pattern: NAME }),
  description: opt(str({ maxLength: DESCRIPTION_MAX })),
  inputSchema: obj({ type: lit("object") }, { open: true }),
  outputSchema: opt(obj({}, { open: true })),
  _meta: opt(map(unknown()))
}, { open: true }))

// The sentence of a definition's first fault, by the field at its place.
const FAULTS: Readonly<Record<string, string>> = {
  name: `Its name does not fit ${NAME}.`,
  description: `Its description is not a text of at most ${DESCRIPTION_MAX} characters.`,
  inputSchema: "Its input schema is not an object schema.",
  outputSchema: "Its output schema is not an object.",
  _meta: "Its _meta is not an object."
}

interface Definition {
  readonly name: string
  readonly description?: string
  readonly inputSchema: Record<string, unknown>
  readonly outputSchema?: Record<string, unknown>
  readonly _meta?: Record<string, unknown>
}

// The checked forms of a definition's schemas ("The form of a schema").
interface Forms {
  readonly input: Checked
  readonly output: Checked | undefined
}

// The fault of one definition, as a sentence, or its checked forms. The
// forms are made before anything else reads the schemas.
const fault = (definition: unknown): string | Forms => {
  const errors = DEFINITION.errors(definition)
  const first = errors[0]
  if (first !== undefined) {
    const field = first.path.split("/")[1] ?? ""
    return Object.hasOwn(FAULTS, field) ? (FAULTS[field] as string) : "It is not a definition of a tool."
  }
  const checked = definition as Definition
  const input = checkOf(checked.inputSchema, "input")
  if (typeof input === "string") return input
  const output = checked.outputSchema === undefined ? undefined : checkOf(checked.outputSchema, "output")
  if (typeof output === "string") return output
  return { input, output }
}

// The form of a schema
// --------------------
//
// A server writes the schemas of its tools, and a check of a value is one
// synchronous step of the library: nothing can end it once it runs. So
// EverChat checks a value only against a form of each schema that it made
// itself (`formOf`), at the load, and neither `pi-schema` nor the SDK gets
// a server's schema as it came. The form is a new JSON value, made by a
// walk that knows the keywords: a key of `properties` is a name, and the
// members of `enum` and the value of `const` are data, never schemas. A
// fault of the form refuses that tool (`Refusal`), and the server's other
// tools stay. Nothing but this walk reads a server's schema as it came
// (H1): the declaration that the model reads holds the shown schema, a
// value that the same walk makes beside the form.
//
// - References. The walk follows a `$ref` only when its text is `#` or
//   `#/` and a JSON pointer (RFC 6901, with `~0` and `~1`, after the
//   fragment's percent escapes are decoded) into the same schema, whose
//   target is an object or a boolean. A schema with an `$id` that is no
//   fragment is a schema of its own: a pointer under it starts there. A
//   copy of the target's form takes the place of the reference; the
//   keywords beside the `$ref` stay beside it (the copy joins their
//   `allOf`), so both hold. Any other `$ref`, a pointer that names nothing
//   or no schema, `$dynamicRef` and `$recursiveRef` refuse the tool. The
//   form holds no `$ref`, `$id`, `$anchor`, `$dynamicAnchor`, `$defs` or
//   `definitions`.
// - The shown schema (H2). The form, with, at each schema object, these
//   annotations of the same object of the server's schema and nothing
//   else: `description` when it is a text; `default` only as a scalar
//   (H11): a text, a number or a boolean of a size (G1) of at most `TAG`,
//   and a list, an object or null is left out with no read of what is in
//   it (no `@default` tag, H5b); `format` and `pattern`, each when it is a
//   text of at most `TAG` units (a tag only: the form and the check never
//   get them; one that is no text gives no tag, H5a); `uniqueItems` and
//   `deprecated`, each when it is `true`. The annotations beside a `$ref`
//   are those of the place: on the copy of the target they take the place
//   of the target's own (a reference to a boolean shows none). A `type`
//   list has each entry one time, in the order of its first places, in the
//   form too (H3: the form is otherwise as it was, with no annotation); the
//   walk still counts each entry as it came (H12).
// - The walk reads only what it counts (H10). No step's work grows with a
//   list, an object or a text of the server's that the walk has not
//   counted toward FORM (a part for each entry) or toward the sizes (G1,
//   H4) before or as it reads it. The test of a kept keyword's kind (a
//   `type` list, `required`, `dependentRequired`) counts one part for each
//   entry as it reads it and stops at the first entry not of its kind
//   (H13): a long list is refused at FORM whether or not it is of its
//   kind, a value not of its kind is left out with what was read counted,
//   and for a value of its kind the counts are as before (H3). A text is
//   taken by its reference and its length.
// - The keys of an object of the server's count at once (H14). Where a
//   later test could stop before each key is counted (`dependentRequired`),
//   the walk counts one part for every key in one step, right after
//   `Object.keys` and before it reads a value; elsewhere (`properties`,
//   `dependentSchemas`, the data of `enum` and `const`) each key's value is
//   walked and counted, or the walk is refused. So no expansion of a
//   reference enumerates an object that it does not count.
// - No schema that holds itself. A reference to a schema that is being
//   filled in at that moment (the target, or a schema on the way to it)
//   refuses the tool, also through `properties` or `items` (a tree): no
//   simple rule tells a tree that is safe to check from one whose check
//   doubles at each level of the value.
// - The size (G2). A part is one object, array, text, number, boolean or
//   null of the form (a key is not one). A form of more than `FORM` parts,
//   of a size (`sizeOf`, G1: its parts and the units of its texts and keys)
//   of more than `FORM_SIZE`, or of more than `DEPTH` schema levels refuses
//   the tool: the walk counts as it goes and stops at the bound, so it never
//   makes the copies of a schema that grows without a cycle, nor walks a
//   schema deeper than DEPTH.
// - The bounds of the shown schema (H4). Its size (G1), the form's and its
//   annotations', is at most `FORM_SIZE`, counted as the walk puts each
//   annotation, so the walk stops at the bound: past it the tool is
//   refused as too large. And its size times the form's levels (`D`) is
//   at most `RENDER`, or the tool is refused: each level of the rendered
//   type copies the text below it, so the renderer's work is some constant
//   times the size times the levels. Both are checked before the compile
//   and before the declaration is made.
// - The pairs (G4). The library's compile looks a name up in a list by a
//   scan: each property in `required`, each property of the first branch of
//   an `anyOf` or a `oneOf` in each branch's `required`, each `const` of a
//   `oneOf` among those before it. Their products, summed over the form,
//   are at most `PAIRS`, or the tool is refused; so each compile is linear.
// - The keywords. The form keeps those of `KEPT`, and leaves every other
//   out, as an annotation is. `pattern` and `uniqueItems` are left out too,
//   since no bound of their work exists: the server's own check is the one
//   that holds for them (`format` is no check of `pi-schema` here either).
//   Left out below `not`, `if` or `oneOf`, or in a `contains` that has a
//   `maxContains`, they could make the form refuse a value that the schema
//   takes: there they refuse the tool. So do the other left-out keywords
//   that assert there (`GUARDED`): a draft-7 list of `items`,
//   `additionalItems`, `dependencies`, and a `required` with an entry that
//   is no text. `patternProperties` refuses the tool, since a pattern
//   decides there which schema a property takes. A
//   kept keyword whose value has not its kind is left out; a schema's place
//   that holds no object or boolean refuses the tool, as the library would.
//
// The form's counts, made once at the load (`Checked`): its parts (`P`),
// its text checks (`T`: each `minLength`, each `maxLength`, and each text
// and key at any depth in a `const` or an `enum`) and its depth (`D`: the
// most schemas on one way from its root, every keyword that holds a schema
// counted, and a reference filled in as a level of its own; S7c), and its
// size (G1). The work of a check of a value (`weigh`) is `P × V + T × U`,
// with `V` the value's parts and `U` the UTF-16 units of its texts and keys:
// over `work`, no check is run (S7, S7a). The library's list of a refused
// value's faults copies the form's data (a `const`, an `enum`) and walks
// the value's texts at each failing place, on each level of its way down,
// so the list is made only when (the form's size) × (V + U) × (D + 1) is at
// most `work`; past that, the value is refused with no list (G3).

type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

// Why a form was refused: the fault, and for `below`, the keyword that was
// left out and the one above it.
type Fault = "compile" | "reference" | "itself" | "large" | "render" | "patternProperties" | "below"
class Refusal {
  constructor(readonly fault: Fault, readonly keyword?: string, readonly under?: string) {}
}

// The sentence of a form's refusal, for the input or the output schema. It
// names keywords of this file only, never a text of the schema.
const refusalOf = (refusal: Refusal, which: "input" | "output"): string => {
  const its = `Its ${which} schema`
  switch (refusal.fault) {
    case "compile":
      return `${its} does not compile.`
    case "reference":
      return `${its} has a reference that EverChat does not follow: only a $ref to # or to a JSON pointer #/... in the same schema, whose target is a schema.`
    case "itself":
      return `${its} holds itself: a $ref names a schema that holds that $ref, and EverChat does not check such a schema.`
    case "large":
      return `${its} is too large for EverChat's check: its form has more than ${FORM} parts, a size of more than ${FORM_SIZE}, more than ${DEPTH} levels, or more than ${PAIRS} pairs of a property and a required name.`
    case "render":
      return `${its} is too large for EverChat to show: its size times its levels is more than ${RENDER}.`
    case "patternProperties":
      return `${its} has patternProperties, which EverChat does not check.`
    case "below":
      return `${its} has ${refusal.keyword} below ${refusal.under}, where EverChat cannot leave it out.`
  }
}

// The kept keywords, by the kind of their value, in the form's order.
type Kind = "type" | "schema" | "schemas" | "list" | "data" | "texts" | "lists" | "number"
const KEPT: ReadonlyArray<readonly [string, Kind]> = [
  ["type", "type"],
  ["enum", "data"],
  ["const", "data"],
  ["properties", "schemas"],
  ["required", "texts"],
  ["additionalProperties", "schema"],
  ["propertyNames", "schema"],
  ["minProperties", "number"],
  ["maxProperties", "number"],
  ["dependentRequired", "lists"],
  ["dependentSchemas", "schemas"],
  ["items", "schema"],
  ["prefixItems", "list"],
  ["contains", "schema"],
  ["minContains", "number"],
  ["maxContains", "number"],
  ["minItems", "number"],
  ["maxItems", "number"],
  ["unevaluatedProperties", "schema"],
  ["unevaluatedItems", "schema"],
  ["minLength", "number"],
  ["maxLength", "number"],
  ["minimum", "number"],
  ["maximum", "number"],
  ["exclusiveMinimum", "number"],
  ["exclusiveMaximum", "number"],
  ["multipleOf", "number"],
  ["allOf", "list"],
  ["anyOf", "list"],
  ["oneOf", "list"],
  ["not", "schema"],
  ["if", "schema"],
  ["then", "schema"],
  ["else", "schema"]
]

// The keywords that are left out though a schema asserts them, and the
// places where leaving one out could refuse a value that the schema takes.
const UNCHECKED = ["pattern", "uniqueItems"] as const
// The keywords that the form leaves out and that refuse the tool below a
// guard when they assert: the two above, and two of draft 7 (S5, ec-egsmp).
// A list of `items` and a `required` with an entry that is no text are
// refused below a guard where the form leaves them out.
const GUARDED = [...UNCHECKED, "additionalItems", "dependencies"] as const
const REFUSED = ["$dynamicRef", "$recursiveRef"] as const

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

// A key of a new object, as a data property: a key `__proto__` too.
const put = (object: Record<string, Json>, key: string, value: Json) => {
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true })
}

// A schema with an `$id` that is no fragment is a schema of its own.
const isResource = (node: Record<string, unknown>) => typeof node.$id === "string" && !node.$id.startsWith("#")

// A reference's target, and the schema whose pointers apply under it.
interface Target {
  readonly node: Record<string, unknown> | boolean
  readonly resource: Record<string, unknown>
}

// One walk: its counts, the size of the shown schema's annotations, the
// targets found (by schema and text), and the schemas being filled in now.
interface Walk {
  parts: number
  texts: number
  depth: number
  pairs: number
  extra: number
  readonly targets: Map<object, Map<string, Target>>
  readonly filling: Set<object>
}

// Where a schema stands: the schema whose pointers apply, the keyword above
// it that makes a left-out keyword unsafe, and its depth.
interface Place {
  readonly resource: Record<string, unknown>
  readonly guard: string | undefined
  readonly depth: number
}

const count = (walk: Walk) => {
  walk.parts += 1
  if (walk.parts > FORM) throw new Refusal("large")
}

// `n` parts in one step: the keys of an object of the server's, right
// after their enumeration (H14).
const counts = (walk: Walk, n: number) => {
  walk.parts += n
  if (walk.parts > FORM) throw new Refusal("large")
}

// The test of a list's kind (H13): one part for each entry as it is read,
// up to the first entry not of its kind. Whether all are of it.
const texts = (walk: Walk, list: ReadonlyArray<unknown>): boolean => {
  for (const one of list) {
    count(walk)
    if (typeof one !== "string") return false
  }
  return true
}

// The target of `ref` from `resource`; a refusal for one that the walk does
// not follow.
const targetOf = (walk: Walk, resource: Record<string, unknown>, ref: string): Target => {
  let known = walk.targets.get(resource)
  if (known === undefined) {
    known = new Map()
    walk.targets.set(resource, known)
  }
  const found = known.get(ref)
  if (found !== undefined) return found
  if (ref !== "#" && !ref.startsWith("#/")) throw new Refusal("reference")
  let fragment: string
  try {
    fragment = decodeURIComponent(ref.slice(1))
  } catch {
    throw new Refusal("reference")
  }
  let at: unknown = resource
  let base = resource
  if (fragment !== "") {
    for (const token of fragment.slice(1).split("/").map((one) => one.replace(/~1/g, "/").replace(/~0/g, "~"))) {
      if (Array.isArray(at)) {
        if (!/^(0|[1-9][0-9]*)$/.test(token) || Number(token) >= at.length) throw new Refusal("reference")
        at = at[Number(token)]
      } else if (isObject(at) && Object.hasOwn(at, token)) {
        at = at[token]
      } else {
        throw new Refusal("reference")
      }
      if (isObject(at) && isResource(at)) base = at
    }
  }
  if (typeof at !== "boolean" && !isObject(at)) throw new Refusal("reference")
  const target = { node: at, resource: base }
  known.set(ref, target)
  return target
}

// A copy of data: a member of `enum`, the value of `const`. Its texts and
// keys are text checks.
const dataOf = (walk: Walk, value: unknown): Json => {
  count(walk)
  if (value === null || typeof value === "boolean" || typeof value === "number") return value
  if (typeof value === "string") {
    walk.texts += 1
    return value
  }
  if (Array.isArray(value)) return value.map((one) => dataOf(walk, one))
  if (isObject(value)) {
    const copy: Record<string, Json> = {}
    for (const key of Object.keys(value)) {
      walk.texts += 1
      put(copy, key, dataOf(walk, value[key]))
    }
    return copy
  }
  throw new Refusal("compile")
}

// Whether a keyword that the form leaves out asserts anything. Of an
// `additionalItems`, anything but `true`; of `dependencies`, an object (its
// keys are not read: no count of them is due here, H10).
const asserts = (keyword: string, value: unknown) =>
  keyword === "pattern"
    ? typeof value === "string"
    : keyword === "additionalItems"
    ? value !== true
    : keyword === "dependencies"
    ? isObject(value)
    : value === true

// The pairs of one schema of the form (G4): the library's compile looks a
// name up in a list by a scan at three places, so their products, summed
// over the form, are bounded by PAIRS. Each property in `required`; for an
// `anyOf` or a `oneOf` (its tagged union), each property of the first
// branch in each branch's `required` and in the list of branches; for a
// `oneOf`, each `const` among those of the branches before it.
const pairsOf = (walk: Walk, form: Record<string, Json>) => {
  const properties = form.properties
  const required = form.required
  if (isObject(properties) && Array.isArray(required)) walk.pairs += Object.keys(properties).length * required.length
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = form[keyword]
    if (!Array.isArray(branches)) continue
    const first = branches[0]
    if (branches.length >= 2 && isObject(first) && isObject(first.properties)) {
      let names = branches.length
      for (const branch of branches) {
        if (isObject(branch) && Array.isArray(branch.required)) names += branch.required.length
      }
      walk.pairs += Object.keys(first.properties).length * names
    }
    if (keyword === "oneOf") {
      const consts = branches.filter((branch) => isObject(branch) && Object.hasOwn(branch, "const")).length
      walk.pairs += consts * consts
    }
  }
  if (walk.pairs > PAIRS) throw new Refusal("large")
}

// The annotations of a schema object that the shown schema copies (H2),
// from `from`: the schema at the place (beside a `$ref`, the place's own,
// not the target's). Their size is counted as they are put, and the walk
// stops once it is past FORM_SIZE (H4).
const annotate = (walk: Walk, shown: Record<string, Json>, from: Record<string, unknown>) => {
  const add = (key: string, value: Json, size: number) => {
    walk.extra += key.length + size
    if (walk.extra > FORM_SIZE) throw new Refusal("large")
    put(shown, key, value)
  }
  const own = (key: string): unknown => (Object.hasOwn(from, key) ? from[key] : undefined)
  const description = own("description")
  if (typeof description === "string") add("description", description, 1 + description.length)
  // A `default` only as a scalar (H11): a list, an object or null is left
  // out with no read of what is in it.
  const given = own("default")
  if (typeof given === "string" && 1 + given.length <= TAG) add("default", given, 1 + given.length)
  else if (typeof given === "number" || typeof given === "boolean") add("default", given, 1)
  for (const key of ["format", "pattern"]) {
    const text = own(key)
    if (typeof text === "string" && text.length <= TAG) add(key, text, 1 + text.length)
  }
  for (const key of ["uniqueItems", "deprecated"]) {
    if (own(key) === true) add(key, true, 1)
  }
}

// The form of one schema at its place, and its shown schema (H2): the same
// value with the annotations of `from` at each schema object. The two
// share their data (a type list, an `enum`, a `const`); neither is changed
// after the walk.
interface Pair {
  readonly form: Json
  readonly shown: Json
}
const schemaOf = (walk: Walk, node: unknown, place: Place, source?: Record<string, unknown>): Pair => {
  if (typeof node === "boolean") {
    if (place.depth > DEPTH) throw new Refusal("large")
    count(walk)
    return { form: node, shown: node }
  }
  if (!isObject(node)) throw new Refusal("compile")
  if (place.depth > DEPTH) throw new Refusal("large")
  if (place.depth > walk.depth) walk.depth = place.depth
  for (const keyword of REFUSED) {
    if (Object.hasOwn(node, keyword)) throw new Refusal("reference")
  }
  if (Object.hasOwn(node, "patternProperties")) throw new Refusal("patternProperties")
  if (place.guard !== undefined) {
    for (const keyword of GUARDED) {
      if (Object.hasOwn(node, keyword) && asserts(keyword, node[keyword])) throw new Refusal("below", keyword, place.guard)
    }
  }
  const resource = isResource(node) ? node : place.resource
  const below = (guard: string | undefined): Place => ({ resource, guard: place.guard ?? guard, depth: place.depth + 1 })
  // The annotations shown here: the place's own, also on a reference's
  // target filled in at this place.
  const from = source ?? node
  walk.filling.add(node)
  const form: Record<string, Json> = {}
  const shown: Record<string, Json> = {}
  const both = (keyword: string, value: Json) => {
    put(form, keyword, value)
    put(shown, keyword, value)
  }
  let used = false
  for (const [keyword, kind] of KEPT) {
    if (!Object.hasOwn(node, keyword)) continue
    const value = node[keyword]
    switch (kind) {
      case "type":
        if (typeof value === "string") {
          count(walk)
          both(keyword, value)
        } else if (Array.isArray(value)) {
          // Each entry as it came is counted as it is read (H12, H13); the
          // form and the shown schema have each type one time, in the order
          // of its first places (H2, H3).
          if (!texts(walk, value)) continue
          count(walk)
          both(keyword, [...new Set(value as ReadonlyArray<string>)])
        } else {
          continue
        }
        break
      case "data":
        if (keyword === "enum" && !Array.isArray(value)) continue
        both(keyword, dataOf(walk, value))
        break
      case "texts":
        // Each entry counted as it is read (H13). Below a guard, a list with
        // an entry that is no text is not left out: it refuses the tool.
        if (!Array.isArray(value)) continue
        if (!texts(walk, value)) {
          if (place.guard !== undefined) throw new Refusal("below", keyword, place.guard)
          continue
        }
        count(walk)
        both(keyword, [...value])
        break
      case "lists": {
        if (!isObject(value)) continue
        // Every key counted at once, right after the enumeration (H14);
        // then each entry of each list as it is read (H13).
        const keys = Object.keys(value)
        counts(walk, keys.length)
        let kind = true
        for (const key of keys) {
          const list = value[key]
          if (!Array.isArray(list) || !texts(walk, list)) {
            kind = false
            break
          }
        }
        if (!kind) continue
        count(walk)
        const lists: Record<string, Json> = {}
        for (const key of keys) put(lists, key, [...(value[key] as ReadonlyArray<string>)])
        both(keyword, lists)
        break
      }
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) continue
        count(walk)
        if (keyword === "minLength" || keyword === "maxLength") walk.texts += 1
        both(keyword, value)
        break
      case "schema": {
        // A list of `items` is the old form of `prefixItems`: left out, and
        // below a guard it refuses the tool.
        if (keyword === "items" && Array.isArray(value)) {
          if (place.guard !== undefined) throw new Refusal("below", keyword, place.guard)
          continue
        }
        const guard = keyword === "not" || keyword === "if" ? keyword : keyword === "contains" && Object.hasOwn(node, "maxContains") ? "contains" : undefined
        const one = schemaOf(walk, value, below(guard))
        put(form, keyword, one.form)
        put(shown, keyword, one.shown)
        break
      }
      case "schemas": {
        if (!isObject(value)) continue
        count(walk)
        const forms: Record<string, Json> = {}
        const showns: Record<string, Json> = {}
        for (const key of Object.keys(value)) {
          const one = schemaOf(walk, value[key], below(undefined))
          put(forms, key, one.form)
          put(showns, key, one.shown)
        }
        put(form, keyword, forms)
        put(shown, keyword, showns)
        break
      }
      case "list": {
        if (!Array.isArray(value)) continue
        count(walk)
        const guard = keyword === "oneOf" ? "oneOf" : undefined
        const ones = value.map((one) => schemaOf(walk, one, below(guard)))
        put(form, keyword, ones.map((one) => one.form))
        put(shown, keyword, ones.map((one) => one.shown))
        break
      }
    }
    used = true
  }
  pairsOf(walk, form)
  let result: Pair = { form, shown }
  if (Object.hasOwn(node, "$ref")) {
    const ref = node.$ref
    if (typeof ref !== "string") throw new Refusal("reference")
    const target = targetOf(walk, resource, ref)
    if (isObject(target.node) && walk.filling.has(target.node)) throw new Refusal("itself")
    // A reference filled in counts as a level of its own (S7c). The copy
    // shows the annotations of this place, not the target's own (H2).
    const copy = schemaOf(walk, target.node, { resource: target.resource, guard: place.guard, depth: place.depth + 1 }, from)
    if (!used) {
      // Alone: the target's form in its place.
      result = copy
    } else {
      const all = form.allOf
      const shownAll = shown.allOf
      count(walk)
      put(form, "allOf", Array.isArray(all) ? [...all, copy.form] : [copy.form])
      put(shown, "allOf", Array.isArray(shownAll) ? [...shownAll, copy.shown] : [copy.shown])
    }
  }
  if (result.form === form) {
    count(walk)
    annotate(walk, shown, from)
  }
  walk.filling.delete(node)
  return result
}

// A form and its counts, or the refusal of the schema; and its shown
// schema (H2) with its size.
export interface Form {
  readonly form: Json
  readonly parts: number
  readonly texts: number
  readonly depth: number
  readonly size: number
  readonly shown: Json
  readonly shownSize: number
}

// The size of a JSON value (G1): its parts, and the UTF-16 units of all its
// texts and of all its keys. One walk with no recursion; it stops once the
// size is past `bound`, and gives that size then.
export const sizeOf = (value: unknown, bound: number): number => {
  const values: Array<unknown> = [value]
  let size = 0
  while (values.length > 0 && size <= bound) {
    const one = values.pop()
    size += 1
    if (typeof one === "string") {
      size += one.length
    } else if (Array.isArray(one)) {
      for (const item of one) values.push(item)
    } else if (isObject(one)) {
      for (const key of Object.keys(one)) {
        size += key.length
        values.push(one[key])
      }
    }
  }
  return size
}

// The form of a server's schema (the head of this part).
export const formOf = (schema: unknown): Form | Refusal => {
  if (!isObject(schema) && typeof schema !== "boolean") return new Refusal("compile")
  const walk: Walk = { parts: 0, texts: 0, depth: 0, pairs: 0, extra: 0, targets: new Map(), filling: new Set() }
  try {
    const root = isObject(schema) ? schema : {}
    const { form, shown } = schemaOf(walk, schema, { resource: root, guard: undefined, depth: 1 })
    // At most FORM parts: the size's walk is short, and its texts are the
    // server's own (the form copies none).
    const size = sizeOf(form, FORM_SIZE)
    if (size > FORM_SIZE) return new Refusal("large")
    // The shown schema is the form and its annotations (H4).
    const shownSize = size + walk.extra
    if (shownSize > FORM_SIZE) return new Refusal("large")
    if (shownSize * walk.depth > RENDER) return new Refusal("render")
    return { form, parts: walk.parts, texts: walk.texts, depth: walk.depth, size, shown, shownSize }
  } catch (cause) {
    if (cause instanceof Refusal) return cause
    // The walk's stack: a schema too deep.
    if (cause instanceof RangeError) return new Refusal("large")
    return new Refusal("compile")
  }
}

// A form with its compiled check.
export interface Checked extends Form {
  readonly validator: Validator<unknown>
}

// The checked form of a server's schema, or the sentence of its refusal.
export const checkOf = (schema: unknown, which: "input" | "output"): Checked | string => {
  const made = formOf(schema)
  if (made instanceof Refusal) return refusalOf(made, which)
  try {
    return { ...made, validator: compile(made.form as Parameters<typeof compile>[0]) }
  } catch {
    return refusalOf(new Refusal("compile"), which)
  }
}

// The work of a check
// -------------------

// What a check of `value` against `checked` would cost (the head of "The
// form of a schema"): the value's parts and the units of its texts and
// keys, counted with no recursion; the count stops once the work is past
// `work`.
interface Weight {
  readonly parts: number
  readonly units: number
  readonly work: number
  readonly over: boolean
}
const weigh = (checked: Form, value: unknown, work: number): Weight => {
  const values: Array<unknown> = [value]
  let parts = 0
  let units = 0
  const cost = (pending: number) => checked.parts * (parts + pending) + checked.texts * units
  const past = (pending: number): Weight => ({ parts: parts + pending, units, work: cost(pending), over: true })
  while (values.length > 0) {
    const one = values.pop()
    parts += 1
    if (typeof one === "string") {
      units += one.length
    } else if (Array.isArray(one)) {
      // Each item is one part at least: past the bound, none is pushed.
      if (cost(values.length + one.length) > work) return past(values.length + one.length)
      for (const item of one) values.push(item)
    } else if (isObject(one)) {
      const keys = Object.keys(one)
      if (cost(values.length + keys.length) > work) return past(values.length + keys.length)
      for (const key of keys) {
        units += key.length
        values.push(one[key])
      }
    }
    if (cost(values.length) > work) return past(values.length)
  }
  return { parts, units, work: cost(0), over: false }
}

// The counts of a check whose work is past the bound, as a sentence's end.
const pastBound = (checked: Form, weight: Weight, work: number) =>
  `its work (${checked.parts} parts of the form × ${weight.parts} of the value + ${checked.texts} text checks × ${weight.units} units of text) is ${weight.work} at least, past the bound of ${work}`

// The check of a value against a form (the head of "The form of a schema"):
// it fits, or it is not checked, or it does not fit, with or without the
// list of its faults (bounded by `limits`).
type Verdict =
  | { readonly kind: "fits" }
  | { readonly kind: "unchecked"; readonly why: string }
  | { readonly kind: "unlisted"; readonly why: string }
  | { readonly kind: "faults"; readonly faults: string }
const verdict = (checked: Checked, value: unknown, limits: Pick<Limits, "max" | "hard" | "work">): Verdict => {
  const weight = weigh(checked, value, limits.work)
  if (weight.over) {
    return { kind: "unchecked", why: pastBound(checked, weight, limits.work) }
  }
  if (checked.validator.check(value)) return { kind: "fits" }
  // The library's list copies the form's data and walks the value's texts
  // at each failing place, on each level of its way down (G3).
  const sized = weight.parts + weight.units
  if (checked.size * sized * (checked.depth + 1) > limits.work) {
    return {
      kind: "unlisted",
      why: `its work (${checked.size} of the form's size × ${sized} of the value's size × ${checked.depth + 1} levels of the form) would pass the bound of ${limits.work}`
    }
  }
  return { kind: "faults", faults: faults(checked.validator.errors(value), limits) }
}

// The load
// --------

// A tool's name as a refusal and a log show it: a name from outside may be
// long, and may hold control characters. It is cut to its first 128 units,
// and then each control character (C0, DEL, C1, U+2028 and U+2029) is
// written as `\u` and four hex digits, so it is one line of printable text.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g
const shown = (name: unknown): string | undefined => {
  if (typeof name !== "string") return undefined
  const cut = name.length > 128 ? name.slice(0, 128) + "…" : name
  return cut.replace(CONTROL, (one) => "\\u" + one.charCodeAt(0).toString(16).padStart(4, "0"))
}

// A tool's setting: its own, else its server's, else `auto`. A value that is
// no setting counts as `ask`, so it never runs unasked.
const settingOf = (server: Server, tool: string): Setting => {
  const own = server.tools !== undefined && Object.hasOwn(server.tools, tool) ? server.tools[tool] : undefined
  const setting: unknown = own ?? server.approval ?? "auto"
  return setting === "auto" || setting === "deny" ? setting : "ask"
}

// Code units, not a locale: the same on every machine.
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// What one server gave: its definitions, or why it gave none.
type Listed =
  | { readonly kind: "listed"; readonly refused: ReadonlyArray<Refused>; readonly candidates: ReadonlyArray<Candidate> }
  | { readonly kind: "refused"; readonly reason: string }

// Why the work of one server's load ended without its list.
class Failed {
  constructor(readonly reason: string) {}
}

// The connection and every page of the list, as the SDK's codec gives
// them. The pages are asked by the client's public `request`, not by
// `listTools` (G8): that one scans each raw schema for `x-mcp-header`, with
// a cost of the depth squared, and writes a dropped tool's text to the
// console. At most PAGES pages; a cursor that comes again ends the load.
const listOf = async (client: Client, transport: Transport, limit: number, signal: AbortSignal): Promise<ReadonlyArray<unknown>> => {
  try {
    await client.connect(transport, { timeout: limit, signal })
  } catch (cause) {
    throw new Failed(
      cause instanceof SdkError && cause.code === SdkErrorCode.EraNegotiationFailed
        ? `It did not connect with the protocol's version ${VERSION}.`
        : "It did not connect."
    )
  }
  // A server with no tools has no list.
  if (client.getServerCapabilities()?.tools === undefined) return []
  const tools: Array<unknown> = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 1; page <= PAGES; page++) {
    let got: { readonly tools: ReadonlyArray<unknown>; readonly nextCursor?: string | undefined }
    try {
      got = await client.request({ method: "tools/list", ...(cursor === undefined ? {} : { params: { cursor } }) }, { timeout: limit, signal })
    } catch (cause) {
      throw new Failed(
        cause instanceof SdkError && cause.code === SdkErrorCode.InvalidResult
          ? "Its list of tools does not fit the protocol."
          : "Its list of tools failed."
      )
    }
    for (const one of got.tools) tools.push(one)
    if (got.nextCursor === undefined) return tools
    if (seen.has(got.nextCursor)) break
    seen.add(got.nextCursor)
    cursor = got.nextCursor
  }
  // A list that does not end: a cursor again, or a page past PAGES.
  throw new Failed("Its list of tools failed.")
}

// The SDK's check of a structured result, in its place: it compiles no
// schema and takes every value, so EverChat's check on the form is the
// only one ("The form of a schema").
const TAKES_ALL: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input: unknown) => ({ valid: true, data: input as T, errorMessage: undefined })
  }
}

// One server's load: its connection, every page of its list, and the
// checks of its definitions, under one limit (G5). Its client closes when
// the caller's scope does: `register` hands its close to the load's one
// end, which runs the closes of all the servers at one time. When its load
// fails, its close starts at once and the load does not wait for it: the
// refusal is given as soon as the failure is known (a program on stdio may
// take the SDK's steps, up to 4 s, to end). The scope's end waits for that
// same close, under the same bound; it never begins a second one.
const listed = (server: Server, limit: number, most: number, limits: Limits, register: (close: Effect.Effect<void>) => void): Effect.Effect<Listed> =>
  Effect.gen(function*() {
    let transport: Transport
    try {
      transport = server.transport()
    } catch {
      return { kind: "refused", reason: "Its transport could not be made." } as const
    }
    const client = new Client({ name: "everchat", version: "0.1.0" }, { versionNegotiation: { mode: { pin: VERSION } }, jsonSchemaValidator: TAKES_ALL })
    // The client, and then the transport itself: the SDK does not close a
    // transport whose connection never ended its handshake (a server that
    // never answered), and a program on stdio would live on. It never
    // rejects: a close that fails, also one that ends after the load
    // returned, changes nothing.
    let closing: Promise<void> | undefined
    const shut = async () => {
      try {
        await client.close()
      } catch {
        // Nothing: the transport's own close comes next.
      }
      try {
        await transport.close()
      } catch {
        // Nothing: the close is over.
      }
    }
    const begin = () => (closing ??= shut())
    const close = Effect.promise(begin).pipe(
      Effect.timeoutOption(limit),
      Effect.asVoid
    )
    yield* Effect.sync(() => register(close))
    const got = yield* Effect.tryPromise({
      try: (signal) => listOf(client, transport, limit, signal),
      catch: (cause) => (cause instanceof Failed ? cause : new Failed("It failed."))
    }).pipe(
      Effect.flatMap((definitions) => checked(server, client, definitions, most, limits)),
      Effect.timeoutOrElse({ duration: limit, orElse: () => Effect.fail(new Failed(`It did not load in ${limit} ms.`)) }),
      Effect.result
    )
    if (got._tag === "Failure") {
      yield* Effect.sync(() => void begin())
      return { kind: "refused", reason: got.failure.reason } as const
    }
    return { kind: "listed", ...got.success } as const
  })

// The call
// --------

// The limits of a call: its time in ms, its characters given whole, its
// bytes, and the bound of the work of one check of a value.
interface Limits {
  readonly call: number
  readonly max: number
  readonly hard: number
  readonly work: number
}

// A text from outside as an error's message holds it (the head comment,
// "The cap"): whole at most `max` characters; past `hard` bytes, only its
// size and the bound; else its first `max` characters and a closing part of
// EverChat's own with the whole count. An error has no way to the rest: no
// `Shortened`, no `result(<call>, from, to)`. `faults`: the count of all
// faults, when the text is a list of them (it may be a part of the list).
const quoted = (text: string, limits: Pick<Limits, "max" | "hard">, faults?: number): string => {
  const all = faults === undefined ? "" : `; ${faults} faults in all`
  const size = bytes(text)
  if (size > limits.hard) return `[a text of ${size} bytes, over the bound of ${limits.hard} bytes, not shown${all}]`
  if (text.length <= limits.max) return text
  const whole = faults === undefined ? `of ${text.length} characters` : `of the list of ${faults} faults in all`
  return part(text, 0, limits.max) + `… [the text was cut: its first ${limits.max} characters are shown, ${whole}]`
}

// The faults of a check of `pi-schema`, as one sentence: each fault's path
// (`/` for the whole value) and its sentence, bounded by `quoted`. The join
// stops once it is past `max` characters, so a million faults are never
// joined whole; the closing part then gives the count of all.
const faults = (errors: ReadonlyArray<{ readonly path: string; readonly message: string }>, limits: Pick<Limits, "max" | "hard">): string => {
  const parts: Array<string> = []
  let length = 0
  for (const one of errors) {
    if (length > limits.max) break
    const text = (one.path === "" ? "/" : one.path) + ": " + one.message
    length += (parts.length === 0 ? 0 : 2) + text.length
    parts.push(text)
  }
  const text = parts.join("; ")
  return quoted(text, limits, parts.length < errors.length || text.length > limits.max ? errors.length : undefined)
}

// A part of a result's `content` as one line: a text part is its text;
// another part names its kind and its type, without its data.
const line = (part: unknown): string => {
  const one = (typeof part === "object" && part !== null ? part : {}) as Record<string, unknown>
  if (one.type === "text" && typeof one.text === "string") return one.text
  const kind = typeof one.type === "string" ? one.type : "unknown"
  const inner = (typeof one.resource === "object" && one.resource !== null ? one.resource : {}) as Record<string, unknown>
  const type = typeof one.mimeType === "string" ? one.mimeType : typeof inner.mimeType === "string" ? inner.mimeType : "no type"
  return `[a part of the kind ${kind}, of the type ${type}, not shown]`
}

// The text of a result's `content`: its parts, one line each.
const textOf = (result: CallToolResult): string =>
  (Array.isArray(result.content) ? result.content : []).map(line).join("\n")

// The text of a cause. One that has none (a value with a null prototype, or
// whose conversion throws) is said so, and the call fails with the ordinary
// sentence: never a defect.
const said = (cause: unknown): string => {
  try {
    return cause instanceof Error ? String(cause.message) : String(cause)
  } catch {
    return "an error with no text"
  }
}

// Why a call failed, as a sentence with the SDK's or the server's text.
// `gone`: the client has no transport now (the SDK's own error for a call
// on a closed connection is a plain `Error`).
const failure = (name: string, server: string, limits: Limits, cause: unknown, gone: boolean): FunctionError => {
  const text = quoted(said(cause), limits)
  if (gone) return new FunctionError({ message: `${name}: the server "${server}" is not connected (${text}).` })
  if (cause instanceof SdkError) {
    if (cause.code === SdkErrorCode.RequestTimeout) return new FunctionError({ message: `${name}: no answer in ${limits.call} ms (${text}).` })
    if (
      cause.code === SdkErrorCode.ConnectionClosed || cause.code === SdkErrorCode.NotConnected ||
      cause.code === SdkErrorCode.SendFailed
    ) {
      return new FunctionError({ message: `${name}: the server "${server}" is not connected (${text}).` })
    }
    if (cause.code === SdkErrorCode.InvalidResult) return new FunctionError({ message: `${name}: its result does not fit its schema (${text}).` })
  }
  if (cause instanceof ProtocolError) return new FunctionError({ message: `${name}: the call was refused (${text}).` })
  return new FunctionError({ message: `${name}: the call failed (${text}).` })
}

// What a program gets of a result: the checked object or the text; past
// `max` characters, a `Shortened` (the head comment, "The cap"). `server`:
// the server's name, which the failure of a result nested too deep names.
export const resultOf = (
  name: string,
  server: string,
  output: Checked | undefined,
  result: CallToolResult,
  call: number,
  limits: Pick<Limits, "max" | "hard" | "work">
): Effect.Effect<unknown, FunctionError> =>
  Effect.gen(function*() {
    if (result.isError === true) {
      return yield* new FunctionError({ message: `${name}: the server gave an error: ${quoted(textOf(result), limits)}` })
    }
    let value: unknown
    let text: string
    if (output !== undefined) {
      if (result.structuredContent === undefined) {
        return yield* new FunctionError({ message: `${name}: its result has no structured content, and its definition has an output schema.` })
      }
      // A `RangeError` of the check or of the JSON text is the stack's end: an
      // object nested too deep, the server's failure. No other throw is
      // caught here.
      const deep = new FunctionError({ message: `${name}: the server "${server}" gave a result nested too deep for EverChat's check.` })
      let got: Verdict
      try {
        got = verdict(output, result.structuredContent, limits)
      } catch (cause) {
        if (cause instanceof RangeError) return yield* deep
        throw cause
      }
      if (got.kind === "unchecked") return yield* new FunctionError({ message: `${name}: its result is not checked: ${got.why}.` })
      if (got.kind === "unlisted") {
        return yield* new FunctionError({ message: `${name}: its result does not fit its output schema; the list of its faults was not made, since ${got.why}.` })
      }
      if (got.kind === "faults") return yield* new FunctionError({ message: `${name}: its result does not fit its output schema: ${got.faults}.` })
      value = result.structuredContent
      try {
        text = JSON.stringify(value)
      } catch (cause) {
        if (cause instanceof RangeError) return yield* deep
        throw cause
      }
    } else {
      text = textOf(result)
      value = text
    }
    const size = bytes(text)
    if (size > limits.hard) {
      return yield* new FunctionError({ message: `${name}: its result is ${size} bytes, over the bound of ${limits.hard} bytes: it is refused.` })
    }
    return text.length > limits.max ? new Shortened(text, givenOf(call, text, limits.max)) : value
  })

// The `run` of an entry: the check of the arguments, the call, the check of
// the result, each against its form.
const runOf = (
  client: Client,
  server: string,
  tool: string,
  declaration: Declaration,
  forms: Forms,
  limits: Limits
) => {
  const name = declaration.name
  return (args: ReadonlyArray<unknown>, caller: Caller): Effect.Effect<unknown, FunctionError> =>
    Effect.gen(function*() {
      if (args.length !== 1) {
        return yield* new FunctionError({ message: `Wrong arguments of ${name}: it takes one object, and was given ${args.length} arguments.` })
      }
      const object = args[0]
      const got = verdict(forms.input, object, limits)
      if (got.kind === "unchecked") {
        return yield* new FunctionError({ message: `Wrong arguments of ${name}: they are not checked, and nothing is sent: ${got.why}.` })
      }
      if (got.kind === "unlisted") {
        return yield* new FunctionError({ message: `Wrong arguments of ${name}: they do not fit its input schema; the list of their faults was not made, since ${got.why}.` })
      }
      if (got.kind === "faults") return yield* new FunctionError({ message: `Wrong arguments of ${name}: ${got.faults}.` })
      const result = yield* Effect.tryPromise({
        // EverChat's own definition (G9): the SDK scans and compiles
        // nothing of the server's, and asks no list again.
        try: (signal) =>
          client.callTool({ name: tool, arguments: object as Record<string, unknown> }, {
            timeout: limits.call,
            signal,
            toolDefinition: { name: tool, inputSchema: { type: "object" } }
          }),
        catch: (cause) => failure(name, server, limits, cause, client.transport === undefined)
      })
      return yield* resultOf(name, server, forms.output, result, caller.call, limits)
    })
}

// A function that passed its own server's checks: its entry, the core's
// refusals of its declaration alone, the characters of its rendered
// declaration, and its weight (H9). The first two are made in its step,
// from the shown schemas (H1).
interface Candidate {
  readonly entry: Outside
  readonly own: ReadonlyArray<{ readonly reason: string }>
  readonly size: number
  readonly weight: number
}

// The functions of one server, and its refusals, one definition for each
// step, with a yield between two, so that the server's limit holds over
// them (G5); G2, G4 and H4 keep each step short. The order is by name (code
// units), and nothing makes a JSON text of a definition (G6): two of one
// name are both refused. A throw while one definition is handled is that
// tool's refusal; one while the list is handled, the server's (G7).
const checked = (
  server: Server,
  client: Client,
  definitions: ReadonlyArray<unknown>,
  most: number,
  limits: Limits
): Effect.Effect<{ readonly refused: ReadonlyArray<Refused>; readonly candidates: ReadonlyArray<Candidate> }, Failed> =>
  Effect.gen(function*() {
    const refused: Array<Refused> = []
    const candidates: Array<Candidate> = []
    let given: Array<{ readonly definition: unknown; readonly name: string }>
    const times = new Map<string, number>()
    try {
      given = definitions.map((definition) => {
        const name = isObject(definition) && typeof definition.name === "string" ? definition.name : ""
        times.set(name, (times.get(name) ?? 0) + 1)
        return { definition, name }
      })
      given.sort((a, b) => compare(a.name, b.name))
    } catch {
      return yield* Effect.fail(new Failed("Its list of tools failed."))
    }
    if (given.length > most) {
      refused.push({ server: server.name, reason: `It gives ${given.length} tools: the first ${most} by name are taken, and the rest are refused.` })
    }
    for (const { definition, name } of given.slice(0, most)) {
      yield* Effect.yieldNow
      const tool = shown(name)
      const refuse = (reason: string) => refused.push({ server: server.name, ...(tool === undefined ? {} : { tool }), reason })
      try {
        const setting = settingOf(server, name)
        if (setting === "deny") continue
        if (name !== "" && (times.get(name) ?? 0) > 1) {
          refuse("Its name is given more than once by its server.")
          continue
        }
        const forms = fault(definition)
        if (typeof forms === "string") {
          refuse(forms)
          continue
        }
        const one = definition as Definition
        // `ask`, or a marked server's mark of the tool: a yes before each
        // call. `_meta` is an object here, or undefined (`fault`).
        const approval = setting === "ask" ||
          (server.marked === true && one._meta !== undefined && Object.hasOwn(one._meta, MARK) && one._meta[MARK] !== false)
        // The shown schemas (H1): nothing reads the server's schemas again.
        const declaration: Declaration = {
          name: server.name + "." + toCodemodeIdentifier(name),
          description: one.description ?? "",
          inputSchema: forms.input.shown as JsonSchema,
          ...(forms.output === undefined ? {} : { outputSchema: forms.output.shown as JsonSchema })
        }
        // The declaration is rendered here, in the step, within H4.
        const own = refusals([declaration])
        const size = renderDeclarations({ globals: [{ ...globalOf(declaration), execute: () => undefined }] }).length
        candidates.push({
          entry: {
            declaration,
            server: server.name,
            tool: name,
            meta: one._meta,
            form: { input: forms.input.form, output: forms.output?.form },
            run: runOf(client, server.name, name, declaration, forms, limits),
            ...(approval ? { approval: true } : {})
          },
          own,
          size,
          weight: forms.input.shownSize * forms.input.depth + (forms.output === undefined ? 0 : forms.output.shownSize * forms.output.depth)
        })
      } catch {
        refuse("It is not a definition of a tool.")
      }
    }
    return { refused, candidates }
  })

// A declaration with a signature in place of its schemas: the core's check
// of a list then sees its name, and renders no type. The checks of names
// are the same; a type was checked when the function itself was.
const named = (declaration: Declaration): Declaration => ({ name: declaration.name, description: "", signature: "()" })

// The core's check of a list over the built-in functions and the list, in
// the list's order: a function that it refuses is left out. A function is
// checked as if it came last after the built-ins and the functions kept
// before it; so a function that is left out never refuses one after it.
// Its own faults (its name's form, its types) are checked alone; the
// faults between names are checked with names only, so that no type is
// rendered again for each function.
const kept = (beside: ReadonlyArray<Declaration>, candidates: ReadonlyArray<Candidate>) => {
  const refused: Array<Refused> = []
  const taken: Array<Candidate> = []
  const before: Array<Declaration> = beside.map(named)
  const base = refusals(before).length
  for (const candidate of candidates) {
    const { entry, own } = candidate
    const found = own.length > 0 ? own : refusals([...before, named(entry.declaration)]).slice(base)
    if (found.length > 0) {
      refused.push({ server: entry.server, tool: shown(entry.tool) as string, reason: found.map((one) => one.reason).join(" ") })
      continue
    }
    taken.push(candidate)
    before.push(named(entry.declaration))
  }
  return { refused, taken }
}

// The bounds, in the list's order: once a function passes one, it and every
// function after it are refused. In order: `count`, `budget`, then
// HEAD_RENDER (H9).
const bounded = (candidates: ReadonlyArray<Candidate>, count: number, budget: number) => {
  const refused: Array<Refused> = []
  const taken: Array<Outside> = []
  let used = 0
  let weighed = 0
  let past: string | undefined
  for (const { entry, size, weight } of candidates) {
    if (past === undefined && taken.length >= count) {
      past = `It is past the first ${count} functions from outside.`
    } else if (past === undefined && used + size > budget) {
      past = `Its declaration would pass the ${budget} characters of the declarations of the functions from outside.`
    } else if (past === undefined && weighed + weight > HEAD_RENDER) {
      past = `Its schemas would pass the ${HEAD_RENDER} of size times levels of the schemas of the functions from outside.`
    }
    if (past !== undefined) {
      refused.push({ server: entry.server, tool: shown(entry.tool) as string, reason: past })
      continue
    }
    used += size
    weighed += weight
    taken.push(entry)
  }
  return { refused, taken }
}

// The source of this file's diagnostics (diagnostics.ts of the core).
const diagnostic = Effect.annotateLogs("source", "mcp")

// Loads the servers' functions. It never fails: each fault is a refusal.
// The connections live in the scope, and close with it.
export const load = (servers: ReadonlyArray<Server>, options: Options): Effect.Effect<Loaded, never, Scope.Scope> =>
  Effect.gen(function*() {
    const limit = options.load ?? DEFAULTS.load
    const most = options.tools ?? DEFAULTS.tools
    const limits: Limits = {
      call: options.call ?? DEFAULTS.call,
      max: options.max ?? DEFAULTS.max,
      hard: options.hard ?? DEFAULTS.hard,
      work: options.work ?? DEFAULTS.work
    }
    // One end for every connection, put before the first can open: the
    // closes run at one time, so the scope's end takes as long as the
    // slowest close, not their sum; each still ends before the scope does.
    const closes: Array<Effect.Effect<void>> = []
    yield* Effect.addFinalizer(() => Effect.forEach(closes, (close) => close, { concurrency: "unbounded", discard: true }))
    const lists = yield* Effect.forEach(servers, (server) => listed(server, limit, most, limits, (close) => void closes.push(close)), { concurrency: "unbounded" })
    const refused: Array<Refused> = []
    const candidates: Array<Candidate> = []
    servers.forEach((server, i) => {
      const list = lists[i] as Listed
      if (list.kind === "refused") {
        refused.push({ server: server.name, reason: list.reason })
        return
      }
      for (const one of list.refused) refused.push(one)
      for (const one of list.candidates) candidates.push(one)
    })
    // No two of one server have one tool's name (G6).
    candidates.sort((a, b) =>
      compare(a.entry.declaration.name, b.entry.declaration.name) || compare(a.entry.tool, b.entry.tool) || compare(a.entry.server, b.entry.server)
    )
    const list = kept(options.beside, candidates)
    const final = bounded(list.taken, options.count ?? DEFAULTS.count, options.budget ?? DEFAULTS.budget)
    refused.push(...list.refused, ...final.refused)
    refused.sort((a, b) => compare(a.server, b.server) || compare(a.tool ?? "", b.tool ?? ""))
    for (const one of refused) {
      yield* diagnostic(Effect.logWarning(
        `A function from outside is refused: server "${one.server}"` + (one.tool === undefined ? "" : `, tool "${one.tool}"`) + `: ${one.reason}`
      ))
    }
    return {
      declarations: final.taken.map((entry) => entry.declaration),
      entries: final.taken,
      refused
    }
  })
