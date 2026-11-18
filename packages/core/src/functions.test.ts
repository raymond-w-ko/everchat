// Tests of the core's functions, the whole list of a host's chat: `zoom`,
// `date` and `result`, over the store and the memory. The core imports no
// file system (tools/graph.ts); that a host's `result` makes no file is
// checked with one, in packages/local/src/functions.test.ts. Then the check
// of a list (`refusals`, `make`), the check of the entries against the list
// of the head (`make`, `hostedLayer`) and a declaration with schemas in the
// head.

import * as assert from "node:assert/strict"
import { test } from "node:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { compactor, newFile, options, PICK } from "@everchat/local/testing"
import { CALLED, type Caller, DATE, type Declaration, type Entry, Functions, HOSTED, hostedLayer, ENGINE_GLOBALS, INHERITED, make, pending, refusals, RESERVED, RESERVED_WORDS, RESULT, Shortened, shownInput, TYPE_MAX, visible, waits, WAITS_INPUT, ZOOM } from "./functions.ts"
import { globalOf, head, spreads } from "./head.ts"
import { given, MAX } from "./limit.ts"
import { Memory } from "./memory.ts"
import { storeLayer } from "@everchat/sqlite/bun"
import { type Approval, Store } from "./store.ts"

// One launch of a host's chat: the store, the memory, and the hosted set.
const withHosted = <A, E>(file: string, effect: Effect.Effect<A, E, Functions | Store | Memory>) => {
  const store = storeLayer(file, options())
  const memory = Memory.layer.pipe(Layer.provideMerge(store), Layer.provide(compactor(() => "a summary")))
  return Effect.runPromise(effect.pipe(Effect.provide(hostedLayer(HOSTED).pipe(Layer.provideMerge(memory)))))
}

const CALLER: Caller = { turn: 1, program: 1, call: 1 }

const call = (name: string, ...args: ReadonlyArray<unknown>) => Functions.use((functions) => functions.call(name, args, CALLER))

const fails = (name: string, ...args: ReadonlyArray<unknown>) =>
  Effect.map(Effect.result(call(name, ...args)), (got) => (got._tag === "Failure" ? got.failure.message : "it did not fail"))

test("the hosted set declares zoom, date and result, in this order, and runs each", async () => {
  const file = newFile()
  await withHosted(file, Effect.gen(function*() {
    const functions = yield* Functions
    assert.deepEqual(HOSTED.map((one) => one.name), ["zoom", "date", "result"])
    assert.deepEqual(functions.declarations, HOSTED)
    assert.deepEqual(functions.names, ["zoom", "date", "result"])
    assert.equal(yield* fails("shell", "echo hi"), "No function shell.")
    assert.equal(yield* fails("read", "a.txt"), "No function read.")

    const memory = yield* Memory
    yield* memory.push([{ kind: "user", text: "hello" }, { kind: "asst", text: "hi there" }])
    yield* memory.idle
    assert.equal(yield* call("zoom", 0), "0+0|user: hello")
    assert.match(String(yield* call("date", 1)), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/)

    const store = yield* Store
    const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
    const done = yield* store.startCall({ turn: turn.id, vendorId: "call_1", fn: "run", input: "" })
    yield* store.endCall(done, { status: "done", output: "the output", shown: 10 })
    assert.equal(yield* call("result", done), "the output")
  }))
})

test("result gives a call's whole output from the store, and says when there is none", async () => {
  const file = newFile()
  await withHosted(file, Effect.gen(function*() {
    const store = yield* Store
    const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
    const done = yield* store.startCall({ turn: turn.id, vendorId: "call_1", fn: "run", input: "" })
    const open = yield* store.startCall({ turn: turn.id, vendorId: "call_2", fn: "run", input: "" })
    const whole = "a long result\n".repeat(5000)
    yield* store.endCall(done, { status: "done", output: whole, shown: 1000 })
    assert.equal(yield* call("result", done), whole)
    assert.equal(yield* fails("result", open), "Call " + open + " still runs: it has no result yet.")
    assert.equal(yield* fails("result", 99), "No call 99.")
    assert.equal(yield* fails("result", "1"), "Wrong arguments: Expected number at [0]. " + USE)
  }))
})

// The end of an error of `result`'s arguments: the signature.
const USE = "Use result(id: number, from?: number, to?: number): Promise<string>."

// The parts of `text` of `size` characters each, from `result`, in order.
const partsOf = (id: number, text: string, size: number) =>
  Effect.gen(function*() {
    const got: Array<string> = []
    for (let from = 0; from < text.length; from += size) {
      got.push(String(yield* call("result", id, from, from + size)))
    }
    return got
  })

test("result(id, from, to) gives the characters from `from` to before `to`: no range the whole, a part from the middle, a `to` past the end, a `from` at the end or past it the empty text; the parts of a text with a pair at a bound join to the whole; each refusal shows the signature", async () => {
  const file = newFile()
  await withHosted(file, Effect.gen(function*() {
    const store = yield* Store
    const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
    const ended = (output: string) =>
      Effect.gen(function*() {
        const id = yield* store.startCall({ turn: turn.id, vendorId: "call_" + output.length, fn: "run", input: "" })
        yield* store.endCall(id, { status: "done", output, shown: 10 })
        return id
      })
    const text = "0123456789"
    const id = yield* ended(text)
    // No range: the whole; null is a bound not given.
    assert.equal(yield* call("result", id), text)
    assert.equal(yield* call("result", id, null, null), text)
    // A part from the middle: `to` is the first character after it.
    assert.equal(yield* call("result", id, 3, 7), "3456")
    assert.equal(yield* call("result", id, 3), "3456789")
    assert.equal(yield* call("result", id, null, 4), "0123")
    assert.equal(yield* call("result", id, 4, 4), "")
    // A `to` past the end: up to the end. A `from` at the end or past it.
    assert.equal(yield* call("result", id, 8, 1000), "89")
    assert.equal(yield* call("result", id, 10), "")
    assert.equal(yield* call("result", id, 10, 12), "")
    assert.equal(yield* call("result", id, 50, 60), "")

    // A text with a surrogate pair at each bound of parts of 3 characters:
    // a bound between its halves moves one character back, so no part has
    // half a pair, and the parts join to the whole.
    const paired = "ab" + "\u{1F600}".repeat(6) + "c\u{1F600}"
    const pairs = yield* ended(paired)
    for (const size of [1, 2, 3, 4, 5]) {
      const parts = yield* partsOf(pairs, paired, size)
      assert.equal(parts.join(""), paired, "parts of " + size)
      for (const one of parts) assert.ok(one.isWellFormed(), JSON.stringify(one) + " in parts of " + size)
    }
    assert.equal(yield* call("result", pairs, 0, 3), "ab")
    assert.equal(yield* call("result", pairs, 3, 6), "\u{1F600}\u{1F600}")
    assert.equal(yield* call("result", pairs, 3), paired.slice(2))

    // Each refusal shows the signature.
    assert.equal(yield* fails("result", id, -1), "Wrong arguments: Expected a value greater than or equal to 0 at [1]. " + USE)
    assert.equal(yield* fails("result", id, 0, -2), "Wrong arguments: Expected a value greater than or equal to 0 at [2]. " + USE)
    assert.equal(yield* fails("result", id, 1.5), "Wrong arguments: Expected an integer at [1]. " + USE)
    assert.equal(yield* fails("result", id, 0, 2.5), "Wrong arguments: Expected an integer at [2]. " + USE)
    assert.equal(yield* fails("result", id, "1"), "Wrong arguments: Expected number | null | undefined at [1]. " + USE)
    assert.equal(yield* fails("result", id, 5, 3), "Wrong arguments: from (5) is over to (3). " + USE)
  }))
})

// The check of a list, and a declaration with schemas
// ---------------------------------------------------

// A function from outside: `ns.member`, with both schemas.
const SEARCH: Declaration = {
  name: "docs.search",
  description: "Searches the docs.",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  outputSchema: { type: "object", properties: { hits: { type: "array", items: { type: "string" } } } }
}

// A declaration with schemas, of `name`.
const schemaOf = (name: string, more: Partial<Declaration> = {}): Declaration => ({ name, description: "A function.", inputSchema: { type: "object" }, ...more })

// The functions of a head, as its tool's description lists them.
const listed = (declarations: ReadonlyArray<Declaration>) => head(declarations).tools[0]!.description.split("these functions:\n\n")[1] ?? ""

// A result from outside kept whole and given short (`Shortened`, `given`;
// the sandbox's side: packages/codemode/src/sandbox.test.ts and
// inline.test.ts).
test("given of a text within max is the text; of a longer one, the head, the line with the call's number, the tail, and no half of a pair; MAX is 1,048,576", () => {
  assert.equal(MAX, 1_048_576)
  const fits = "x".repeat(2000)
  assert.equal(given(7, fits, 2000), fits)
  assert.equal(given(7, "", 2000), "")
  // max 2000: the head is 1000 characters and the tail 488 (limit.ts,
  // `shorten`). The head's cut falls inside the first pair, the tail's
  // inside the second: each moves out of the pair, so neither half is kept.
  const pair = "\u{1F600}"
  const text = "a".repeat(999) + pair + "b".repeat(3000) + pair + "c".repeat(487)
  const line = "\n[... 3004 of " + text.length + " characters left out. result(7, from, to) gives a part of the whole result to a program. ...]\n"
  assert.equal(given(7, text, 2000), "a".repeat(999) + line + "c".repeat(487))
  assert.equal(given(42, "y".repeat(3000), 2000).includes("result(42, from, to) gives a part of the whole result to a program."), true)
})

test("a Shortened goes through Functions.call as it is, with its whole and its given; a plain value as before", async () => {
  const short = new Shortened("the whole", "the given")
  const entries: ReadonlyArray<Entry> = [
    { declaration: schemaOf("ns.short"), run: () => Effect.succeed(short) },
    { declaration: schemaOf("ns.plain"), run: () => Effect.succeed({ a: 1 }) }
  ]
  const functions = make(entries.map((one) => one.declaration), entries)
  const got = await Effect.runPromise(functions.call("ns.short", [{}], CALLER))
  assert.equal(got instanceof Shortened, true)
  assert.deepEqual([(got as Shortened).whole, (got as Shortened).given], ["the whole", "the given"])
  assert.deepEqual(await Effect.runPromise(functions.call("ns.plain", [{}], CALLER)), { a: 1 })
})

test("a function ns.member with both schemas renders in the head as declare const ns: { member(args: <input>): Promise<<output>> }, after the built-ins, which keep their bytes; its global takes one object (spread false), a built-in's a list (spread true)", () => {
  assert.deepEqual(refusals([...HOSTED, SEARCH]), [])
  const shown = listed([...HOSTED, SEARCH])
  assert.equal(shown, listed(HOSTED) + "\n\ndeclare const docs: {\n  /** Searches the docs. */\n  search(args: { query: string; }): Promise<{ hits?: Array<string>; }>;\n};")
  // No output schema: the result is `unknown`.
  assert.match(listed([schemaOf("lookup")]), /^\/\*\* A function\. \*\/\ndeclare function lookup\(args: \{ \[key: string\]: unknown; \}\): Promise<unknown>;$/)
  assert.deepEqual(globalOf(SEARCH), { name: "docs.search", description: "Searches the docs.", inputSchema: SEARCH.inputSchema, outputSchema: SEARCH.outputSchema, spread: false })
  assert.deepEqual(globalOf(ZOOM), { name: "zoom", description: ZOOM.description, signature: ZOOM.signature, spread: true })
})

test("each refusal of a list, with its name and its sentence: two entries of one name, a-b beside a_b, a.b.c, store, a namespace x beside a global x, a signature with a schema, neither, a rendered type past the cap", () => {
  const cases: ReadonlyArray<readonly [string, ReadonlyArray<Declaration>, ReadonlyArray<{ name: string; reason: string }>]> = [
    ["two entries of one name", [ZOOM, DATE, DATE], [{ name: "date", reason: "Another function before it has this name." }]],
    ["a-b beside a_b", [schemaOf("a_b"), schemaOf("a-b")], [
      { name: "a-b", reason: "A name is an identifier, or a namespace and a member with one dot between them." },
      { name: "a-b", reason: 'Its identifier a_b is that of "a_b", before it.' }
    ]],
    ["a.b.c", [schemaOf("a.b.c")], [{ name: "a.b.c", reason: "A name is an identifier, or a namespace and a member with one dot between them." }]],
    ["an empty name, a dot at an end", [schemaOf(""), schemaOf("a."), schemaOf(".b")], [
      { name: "", reason: "A name is an identifier, or a namespace and a member with one dot between them." },
      { name: "a.", reason: "A name is an identifier, or a namespace and a member with one dot between them." },
      { name: ".b", reason: "A name is an identifier, or a namespace and a member with one dot between them." }
    ]],
    ["store", [schemaOf("store")], [{ name: "store", reason: '"store" is a global of the sandbox.' }]],
    ["a namespace of a global of the sandbox", [schemaOf("tools.search"), schemaOf("console.log")], [
      { name: "tools.search", reason: '"tools" is a global of the sandbox.' },
      { name: "console.log", reason: '"console" is a global of the sandbox.' }
    ]],
    ["a namespace x beside a global x", [schemaOf("x"), schemaOf("x.y")], [{ name: "x.y", reason: 'Its namespace "x" is the name of another function.' }]],
    ["a global x after a namespace x", [schemaOf("x.y"), schemaOf("x")], [{ name: "x.y", reason: 'Its namespace "x" is the name of another function.' }]],
    ["a signature with a schema", [{ ...ZOOM, inputSchema: { type: "object" } }, { ...DATE, outputSchema: { type: "string" } }], [
      { name: "zoom", reason: "It has a signature and a schema: give one of them." },
      { name: "date", reason: "It has a signature and a schema: give one of them." }
    ]],
    ["neither", [{ name: "bare", description: "No form." }, { name: "only", description: "An output alone.", outputSchema: { type: "string" } }], [
      { name: "bare", reason: "It has no signature and no input schema: give one of them." },
      { name: "only", reason: "It has no signature and no input schema: give one of them." }
    ]],
    // A `const` of n characters renders as n + 2 (its quotes).
    ["a rendered type past the cap", [
      schemaOf("at_cap", { inputSchema: { const: "a".repeat(TYPE_MAX - 2) }, outputSchema: { const: "b".repeat(TYPE_MAX - 2) } }),
      schemaOf("long_in", { inputSchema: { const: "a".repeat(TYPE_MAX - 1) } }),
      schemaOf("long_out", { outputSchema: { const: "b".repeat(TYPE_MAX - 1) } })
    ], [
      { name: "long_in", reason: `Its input type is ${TYPE_MAX + 1} characters, more than ${TYPE_MAX}.` },
      { name: "long_out", reason: `Its output type is ${TYPE_MAX + 1} characters, more than ${TYPE_MAX}.` }
    ]]
  ]
  for (const [what, list, expected] of cases) {
    assert.deepEqual([what, refusals(list).map((one) => ({ ...one }))], [what, expected])
  }
  assert.equal(TYPE_MAX, 16_000)
  assert.deepEqual(RESERVED, ["tools", "ALL_TOOLS", "console", "text", "image", "exit", "globalThis", "store", "load"])
  for (const name of RESERVED) assert.deepEqual([name, refusals([schemaOf(name)]).length], [name, 1])
  // The built-in lists pass, and a member may share a reserved name.
  assert.deepEqual(refusals(HOSTED), [])
  assert.deepEqual(refusals([schemaOf("docs.store"), schemaOf("x.y"), schemaOf("x.z"), schemaOf("$a_1")]), [])
  // A schema that cannot be rendered is refused, and the check throws nothing.
  const deep: Record<string, unknown> = {}
  let at = deep
  for (let k = 0; k < 100_000; k++) {
    const next: Record<string, unknown> = {}
    at["type"] = "array"
    at["items"] = next
    at = next
  }
  assert.deepEqual(refusals([schemaOf("deep", { inputSchema: deep })]).map((one) => ({ ...one })), [{ name: "deep", reason: "Its input schema cannot be shown as a type." }])
})

test("a function named as a global of the sandbox's engine, or in its namespace, is refused with the sentence: JSON.member, Math.x, a global Object, each of ENGINE_GLOBALS, and by trial __proto__ and constructor (not prototype); a member's name is free: ns.JSON passes; make dies for one", async () => {
  const engine = (name: string) => `"${name}" is a global of the sandbox's engine.`
  assert.deepEqual(refusals([schemaOf("JSON.member"), schemaOf("Math.x"), schemaOf("Object"), { name: "undefined", description: "A spread one.", signature: "(): Promise<void>" }]).map((one) => ({ ...one })), [
    { name: "JSON.member", reason: engine("JSON") },
    { name: "Math.x", reason: engine("Math") },
    { name: "Object", reason: engine("Object") },
    { name: "undefined", reason: engine("undefined") }
  ])
  // Each name of the list, as a global and as a namespace, once (no other refusal comes with it).
  assert.equal(ENGINE_GLOBALS.length, 70)
  assert.deepEqual(ENGINE_GLOBALS.filter((name) => RESERVED.includes(name)), [])
  for (const name of ENGINE_GLOBALS) {
    assert.deepEqual([name, refusals([schemaOf(name)]).map((one) => one.reason)], [name, [engine(name)]])
    assert.deepEqual([name, refusals([schemaOf(name + ".m")]).map((one) => one.reason)], [name, [engine(name)]])
  }
  // Ruling 3's trial (ec-kcn81): __proto__ and constructor hide what the global object inherits; prototype hides nothing.
  assert.deepEqual(ENGINE_GLOBALS.slice(-2), ["__proto__", "constructor"])
  assert.deepEqual([refusals([schemaOf("prototype")]), refusals([schemaOf("prototype.m")])], [[], []])
  // A member's name after the dot is free.
  assert.deepEqual(refusals([schemaOf("ns.JSON"), schemaOf("ns.Object"), schemaOf("ns.__proto__"), schemaOf("docs.constructor")]), [])
  const exit = await Effect.runPromiseExit(Effect.provide(Effect.gen(function*() { return yield* Functions }), Layer.effect(Functions, Effect.sync(() => make([schemaOf("JSON.member")], [{ declaration: schemaOf("JSON.member"), run: () => Effect.succeed(null) }])))))
  assert.equal(Exit.isFailure(exit) && Cause.hasDies(exit.cause), true)
  assert.equal(String((Cause.squash(Exit.isFailure(exit) ? exit.cause : Cause.empty) as Error).message), 'The list of functions is refused: "JSON.member": "JSON" is a global of the sandbox\'s engine.')
})

test("a function named as a name that the global object inherits, or that the engine calls by itself, as a global or as a namespace, is refused with the sentence: toString, toString.m, valueOf, hasOwnProperty, then, toJSON, each of INHERITED and CALLED; a member after the dot is free: ns.toString and ns.valueOf pass; make dies for one", async () => {
  const inherited = (name: string) => `"${name}" is a name that the sandbox's global object inherits.`
  const called = (name: string) => `"${name}" is a name that the sandbox's engine calls by itself.`
  const named = ["toString", "toString.m", "valueOf", "valueOf.m", "hasOwnProperty", "hasOwnProperty.m", "then", "then.m", "toJSON", "toJSON.m"]
  assert.deepEqual(refusals(named.map((name) => schemaOf(name))).map((one) => ({ ...one })), [
    { name: "toString", reason: inherited("toString") },
    { name: "toString.m", reason: inherited("toString") },
    { name: "valueOf", reason: inherited("valueOf") },
    { name: "valueOf.m", reason: inherited("valueOf") },
    { name: "hasOwnProperty", reason: inherited("hasOwnProperty") },
    { name: "hasOwnProperty.m", reason: inherited("hasOwnProperty") },
    { name: "then", reason: called("then") },
    { name: "then.m", reason: called("then") },
    { name: "toJSON", reason: called("toJSON") },
    { name: "toJSON.m", reason: called("toJSON") }
  ])
  // Each name of the two lists, as a global and as a namespace, once. The
  // two that ENGINE_GLOBALS has too keep its sentence (ec-kcn81).
  assert.deepEqual(INHERITED, ["toString", "toLocaleString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__", "constructor"])
  assert.deepEqual(CALLED, ["then", "toJSON"])
  for (const name of [...INHERITED, ...CALLED]) {
    const reason: string = ENGINE_GLOBALS.includes(name) ? `"${name}" is a global of the sandbox's engine.` : INHERITED.includes(name) ? inherited(name) : called(name)
    assert.deepEqual([name, refusals([schemaOf(name)]).map((one) => one.reason)], [name, [reason]])
    assert.deepEqual([name, refusals([schemaOf(name + ".m")]).map((one) => one.reason)], [name, [reason]])
  }
  assert.deepEqual(INHERITED.filter((name) => ENGINE_GLOBALS.includes(name)), ["__proto__", "constructor"])
  // A member after the dot is free of INHERITED (of CALLED it is not: the case below).
  assert.deepEqual(refusals([schemaOf("ns.toString"), schemaOf("ns.valueOf"), schemaOf("ns.hasOwnProperty")]), [])
  for (const name of ["toString", "then"]) {
    const exit = await Effect.runPromiseExit(Effect.provide(Effect.gen(function*() { return yield* Functions }), Layer.effect(Functions, Effect.sync(() => make([schemaOf(name)], [{ declaration: schemaOf(name), run: () => Effect.succeed(null) }])))))
    assert.equal(Exit.isFailure(exit) && Cause.hasDies(exit.cause), true)
    assert.equal(String((Cause.squash(Exit.isFailure(exit) ? exit.cause : Cause.empty) as Error).message), `The list of functions is refused: "${name}": ${name === "then" ? called(name) : inherited(name)}`)
  }
})

// The message of a build of `make` over `declarations`, each with an entry, or "it was built".
const builds = (declarations: ReadonlyArray<unknown>): string => {
  try {
    make(declarations as ReadonlyArray<Declaration>, declarations.map((declaration) => ({ declaration, run: () => Effect.succeed(null) }) as Entry))
    return "it was built"
  } catch (error) {
    return String((error as Error).message)
  }
}

test("a member named as a name of CALLED is refused with that list's sentence: ns.then, docs.toJSON, a schema one and a spread one; then.then once, as a namespace; a member of INHERITED or ENGINE_GLOBALS stays free; make dies for one", () => {
  const called = (name: string) => `"${name}" is a name that the sandbox's engine calls by itself.`
  assert.deepEqual(refusals([schemaOf("ns.then"), schemaOf("docs.toJSON"), { name: "s.then", description: "A spread one.", signature: "(): Promise<void>" }, schemaOf("then.then")]).map((one) => ({ ...one })), [
    { name: "ns.then", reason: called("then") },
    { name: "docs.toJSON", reason: called("toJSON") },
    { name: "s.then", reason: called("then") },
    { name: "then.then", reason: called("then") }
  ])
  for (const name of CALLED) assert.deepEqual([name, refusals([schemaOf("ns." + name)]).map((one) => one.reason)], [name, [called(name)]])
  // Only the exact name: a member that holds it, or another case of it, is free.
  assert.deepEqual(refusals([schemaOf("ns.thenable"), schemaOf("ns.Then"), schemaOf("ns.toJson"), schemaOf("ns.constructor"), schemaOf("ns.JSON")]), [])
  assert.equal(builds([schemaOf("z.other"), schemaOf("z.then")]), 'The list of functions is refused: "z.then": "then" is a name that the sandbox\'s engine calls by itself.')
})

test("a reserved word of JavaScript is refused as a global's name and as a namespace, with one sentence: the 46 words of RESERVED_WORDS, each once; a member after the dot is free: ns.delete, ns.class, ns.await pass; make dies for one", () => {
  const word = (name: string) => `"${name}" is a reserved word of JavaScript.`
  assert.deepEqual(RESERVED_WORDS, [
    "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum",
    "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "new", "null", "return",
    "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield", "implements",
    "interface", "let", "package", "private", "protected", "public", "static"
  ])
  // No word is in another list, so each has this sentence alone.
  assert.deepEqual(RESERVED_WORDS.filter((name) => [...RESERVED, ...ENGINE_GLOBALS, ...INHERITED, ...CALLED].includes(name)), [])
  for (const name of RESERVED_WORDS) {
    assert.deepEqual([name, refusals([schemaOf(name)]).map((one) => one.reason)], [name, [word(name)]])
    assert.deepEqual([name, refusals([schemaOf(name + ".m")]).map((one) => one.reason)], [name, [word(name)]])
    assert.deepEqual([name, refusals([{ name, description: "A spread one.", signature: "(): Promise<void>" }]).map((one) => one.reason)], [name, [word(name)]])
  }
  // A member after the dot is free; a word that is no reserved one is free as a global.
  assert.deepEqual(refusals([schemaOf("ns.delete"), schemaOf("ns.class"), schemaOf("ns.await"), schemaOf("ns.default"), schemaOf("async"), schemaOf("of"), schemaOf("get"), schemaOf("Delete")]), [])
  assert.equal(builds([schemaOf("delete")]), 'The list of functions is refused: "delete": ' + word("delete"))
})

test("refusals throws for no list: a name that is a number, null or an object, an entry that is a number, null or a text, and a hole of the list are each refused, with the empty text as the name and \"The name is no text.\"; the entries beside them are checked as before; make dies with those refusals", () => {
  const none = { name: "", reason: "The name is no text." }
  const odd: ReadonlyArray<unknown> = [
    { name: 5, description: "A number.", inputSchema: { type: "object" } },
    { name: null, description: "Null.", inputSchema: { type: "object" } },
    { name: { a: 1 }, description: "An object.", inputSchema: { type: "object" } },
    { description: "No name.", inputSchema: { type: "object" } },
    7,
    null,
    "zoom"
  ]
  // A list with a hole, between two good entries and before a refused one.
  const holed: ReadonlyArray<unknown> = [ZOOM, , DATE, schemaOf("store")]
  assert.equal(holed.length, 4)
  assert.equal(1 in holed, false)
  assert.deepEqual(refusals(odd as ReadonlyArray<Declaration>).map((one) => ({ ...one })), odd.map(() => none))
  assert.deepEqual(refusals(holed as ReadonlyArray<Declaration>).map((one) => ({ ...one })), [none, { name: "store", reason: '"store" is a global of the sandbox.' }])
  // The good entries beside them are checked as before: a name after a refused entry is still a duplicate.
  assert.deepEqual(refusals([ZOOM, null, ZOOM] as unknown as ReadonlyArray<Declaration>).map((one) => ({ ...one })), [none, { name: "zoom", reason: "Another function before it has this name." }])
  assert.deepEqual(refusals([...HOSTED, SEARCH]), [])
  // make dies with them, a name that is no text and an entry that is none alike.
  assert.equal(builds([ZOOM, { name: 5, description: "A number.", inputSchema: { type: "object" } }]), 'The list of functions is refused: "": The name is no text.')
  assert.equal(builds([ZOOM, null, schemaOf("store")]), 'The list of functions is refused: "": The name is no text. "store": "store" is a global of the sandbox.')
})

test("one rule of spread: spreads is true for a declaration with a signature and false for one with schemas, and globalOf's spread is spreads for each", () => {
  assert.deepEqual([spreads(ZOOM), spreads(SEARCH), spreads(schemaOf("lookup"))], [true, false, false])
  for (const one of [...HOSTED, SEARCH, schemaOf("lookup")]) assert.deepEqual([one.name, globalOf(one).spread], [one.name, spreads(one)])
})

test("make dies at the layer's build with every refusal in its message, and builds a good list", async () => {
  const entry = (declaration: Declaration): Entry => ({ declaration, run: () => Effect.succeed(null) })
  const build = (declarations: ReadonlyArray<Declaration>) =>
    Effect.runPromiseExit(Effect.provide(Effect.gen(function*() { return yield* Functions }), Layer.effect(Functions, Effect.sync(() => make(declarations, declarations.map(entry))))))
  const exit = await build([ZOOM, DATE, DATE, schemaOf("store"), schemaOf("a.b.c")])
  assert.equal(Exit.isFailure(exit), true)
  const cause = Exit.isFailure(exit) ? exit.cause : Cause.empty
  assert.equal(Cause.hasDies(cause), true)
  const message = String((Cause.squash(cause) as Error).message)
  assert.equal(
    message,
    'The list of functions is refused: "date": Another function before it has this name. "store": "store" is a global of the sandbox. "a.b.c": A name is an identifier, or a namespace and a member with one dot between them.'
  )
  const good = await build([...HOSTED, SEARCH])
  assert.equal(Exit.isSuccess(good), true)
  assert.deepEqual(Exit.isSuccess(good) ? good.value.names : [], ["zoom", "date", "result", "docs.search"])
})

// The message of a layer that died at its build, or "it was built".
const died = (exit: Exit.Exit<unknown, unknown>): string =>
  Exit.isFailure(exit) && Cause.hasDies(exit.cause) ? String((Cause.squash(exit.cause) as Error).message) : "it was built"

test("make dies at the layer's build, with the names, when the entries' declarations are not the list: a missing name, an extra name, another order, another declaration; the same list builds", async () => {
  const entry = (declaration: Declaration): Entry => ({ declaration, run: () => Effect.succeed(null) })
  const build = (declarations: ReadonlyArray<Declaration>, entries: ReadonlyArray<Entry>) =>
    Effect.runPromiseExit(Effect.provide(Effect.gen(function*() { return yield* Functions }), Layer.effect(Functions, Effect.sync(() => make(declarations, entries)))))
  const head = "The functions are not the list of the head: "
  // A missing name: the list has result, no entry has it.
  assert.equal(died(await build([ZOOM, DATE, RESULT], [ZOOM, DATE].map(entry))), head + 'The list has "result", and no entry.')
  // An extra name: an entry has result, the list does not.
  assert.equal(died(await build([ZOOM, DATE], [ZOOM, DATE, RESULT].map(entry))), head + 'An entry has "result", and the list does not.')
  // Another order: the same names.
  assert.equal(
    died(await build([ZOOM, DATE, RESULT], [RESULT, ZOOM, DATE].map(entry))),
    head + 'The list has "zoom", "date", "result" in this order, and the entries "result", "zoom", "date".'
  )
  // Another declaration of one name: the head would show another function than the sandbox's.
  assert.equal(died(await build([ZOOM, DATE], [ZOOM, { ...DATE, description: "Another." }].map(entry))), head + 'The entry of "date" has another declaration than the list\'s.')
  // All at once, each with its sentence.
  assert.equal(
    died(await build([ZOOM, DATE, RESULT], [SEARCH, DATE, ZOOM].map(entry))),
    head + 'The list has "result", and no entry. An entry has "docs.search", and the list does not. The list has "zoom", "date" in this order, and the entries "date", "zoom".'
  )
  // The same list, as equal values (not the same objects), builds.
  const same = await build([...HOSTED, SEARCH], [...HOSTED, SEARCH].map((one) => entry(JSON.parse(JSON.stringify(one)) as Declaration)))
  assert.deepEqual(Exit.isSuccess(same) ? same.value.names : died(same), ["zoom", "date", "result", "docs.search"])
})

test("hostedLayer takes the list of the stack's head: HOSTED builds; another list, HOSTED in another order or with one more, dies at the build", async () => {
  const file = newFile()
  const store = storeLayer(file, options())
  const memory = Memory.layer.pipe(Layer.provideMerge(store), Layer.provide(compactor(() => "a summary")))
  const build = (declarations: ReadonlyArray<Declaration>) =>
    Effect.runPromiseExit(Effect.provide(Effect.gen(function*() { return (yield* Functions).names }), hostedLayer(declarations).pipe(Layer.provideMerge(memory))))
  const good = await build(HOSTED)
  assert.deepEqual(Exit.isSuccess(good) ? good.value : died(good), ["zoom", "date", "result"])
  assert.equal(died(await build([DATE, ZOOM, RESULT])), 'The functions are not the list of the head: The list has "date", "zoom", "result" in this order, and the entries "zoom", "date", "result".')
  assert.equal(died(await build([...HOSTED, SEARCH])), 'The functions are not the list of the head: The list has "docs.search", and no entry.')
})

test("make: approval holds exactly the names of the entries that say approval: true (not false, not left out); call runs a gated function as any other, for the run after a yes; pending(n) is the value that a program gets", async () => {
  const ran: Array<string> = []
  const entry = (declaration: Declaration, approval?: boolean): Entry => ({
    declaration,
    run: (args) => Effect.sync(() => (ran.push(declaration.name), args)),
    ...(approval === undefined ? {} : { approval })
  })
  const functions = make([...HOSTED, SEARCH], [entry(ZOOM, true), entry(DATE, false), entry(RESULT), entry(SEARCH, true)])
  assert.deepEqual([...functions.approval], ["zoom", "docs.search"])
  assert.deepEqual(make(HOSTED, HOSTED.map((one) => entry(one))).approval, new Set())
  assert.deepEqual(await Effect.runPromise(functions.call("docs.search", [{ q: "a" }], CALLER)), [{ q: "a" }])
  assert.deepEqual(ran, ["docs.search"])
  // The declarations do not change with a setting: the head is the same.
  assert.deepEqual(functions.declarations, [...HOSTED, SEARCH])
  assert.deepEqual(pending(3), {
    pending: 3,
    note: "This call did not run. It waits for a person's yes or no, as approval 3. Go on without its result: it comes in a later turn if the person says yes."
  })
})


test("shownInput and waits of arguments with U+E0041, U+009B and U+202E give their escapes and no such code point; arguments longer than WAITS_INPUT are cut first, then escaped, and never inside a pair", () => {
  const hidden = (text: string) => [...text].filter((one) => one === "\u{e0041}" || one === "\u009b" || one === "\u202e").map((one) => one.codePointAt(0)!.toString(16))
  const input = "[\"a\u{e0041}b\",\"\u009b31m\",\"\u202eevil\"]"
  const shown = "\"a\\u{e0041}b\",\"\\x9b31m\",\"\\u{202e}evil\""
  assert.equal(shownInput(input), shown)
  assert.deepEqual(hidden(shownInput(input)), [])
  const approval: Approval = {
    id: 4, turn: 1, call: 2, fn: "acme.send", input, status: "pending", who: null, answer: null, answered: null,
    output: null, ended: null, msg: null, created: 0, updated: 0
  }
  assert.equal(waits(approval), "Approval 4 waits for a person's yes or no: acme.send(" + shown + "). The call did not run.")
  assert.deepEqual(hidden(waits(approval)), [])
  // The cut first: the last character kept is U+009B, whole as its escape.
  assert.equal(WAITS_INPUT, 500)
  assert.equal(shownInput("[" + "x".repeat(WAITS_INPUT - 1) + "\u009b" + "y".repeat(10) + "]"), "x".repeat(WAITS_INPUT - 1) + "\\x9b…")
  // A pair at the cut is left out whole: no half of it is escaped.
  assert.equal(shownInput("[" + "x".repeat(WAITS_INPUT - 1) + "\u{e0041}" + "y".repeat(10) + "]"), "x".repeat(WAITS_INPUT - 1) + "…")
  // One rule: shownInput is visible over the cut text.
  assert.equal(shownInput("[\u2066\u00ad]"), visible("\u2066\u00ad"))
  assert.equal(shownInput("[\u2066\u00ad]"), "\\u{2066}\\xad")
})
