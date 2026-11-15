// The check of the engines' options (calls.ts, `numbers`): each numeric
// option of an engine's layer, when given, is an integer from 1 to
// 2**31 - 1, read once by its field, and the layer's call throws a
// RangeError for any other value, before any layer is built. Then the
// memory option on the real engines: the wall holds at both ends of the
// domain.

import { expect, test } from "bun:test"
import { loadQuickJSWasm } from "@earendil-works/pi-codemode"
import { Effect, Layer } from "effect"
import { Functions } from "@everchat/core/functions"
import { type Ran, Sandbox } from "@everchat/core/sandbox"
import { Store } from "@everchat/core/store"
import { newFile, PICK, withStore } from "@everchat/sqlite/testing"
import { inlineLayer, type Options as InlineOptions } from "./inline.ts"
import { threadLayer, type Options as ThreadOptions } from "./thread.ts"

// The numeric fields of an engine's options. Each list below names every
// one, with a good value: a numeric field that a list lacks, or a name in
// it that is no such field, fails the type check (`just check`), so a new
// numeric option cannot be left out of this test.
type Numeric<T> = { [K in keyof T]-?: NonNullable<T[K]> extends number ? K : never }[keyof T]
const THREAD = { memory: 32 * 1024 * 1024, compute: 250, budget: 5000 } satisfies Record<Numeric<ThreadOptions>, number>
const INLINE = { memory: 32 * 1024 * 1024, polls: 10_000 } satisfies Record<Numeric<InlineOptions>, number>

const wasm = loadQuickJSWasm()

type Layered = Layer.Layer<Sandbox, never, Functions | Store>

// Each engine's layer for the options `given`, as they are: an inherited
// property and a getter of `given` stay what they are (the inline engine's
// `wasm` is set on `given` itself).
const engines: ReadonlyArray<{ name: string; good: Record<string, number>; make: (given: object) => Layered }> = [
  { name: "thread", good: THREAD, make: (given) => threadLayer(given as ThreadOptions) },
  { name: "inline", good: INLINE, make: (given) => inlineLayer(Object.assign(given, { wasm }) as InlineOptions) }
]

const LARGEST = 2 ** 31 - 1
const MiB = 2 ** 20

// Every value that is no integer from 1 to 2**31 - 1, with the way the
// message shows it.
const BAD: ReadonlyArray<readonly [unknown, string]> = [
  ["Infinity", `"Infinity"`],
  ["32", `"32"`],
  [null, "null"],
  [10n, "10n"],
  [true, "true"],
  [Number.NaN, "NaN"],
  [0.5, "0.5"],
  [Number.MIN_VALUE, "5e-324"],
  [0, "0"],
  [-1, "-1"],
  [2 ** 31, "2147483648"],
  [2 ** 32, "4294967296"],
  [2 ** 53, "9007199254740992"],
  [1e300, "1e+300"],
  [Number.POSITIVE_INFINITY, "Infinity"],
  [Number.NEGATIVE_INFINITY, "-Infinity"]
]

// The error of `make`, or undefined.
const thrown = (make: () => unknown): unknown => {
  try {
    make()
  } catch (error) {
    return error
  }
  return undefined
}

const message = (engine: string, name: string, shown: string) =>
  "The option `" + name + "` of the " + engine + " engine must be an integer from 1 to 2147483647, not " + shown + "."

for (const engine of engines) {
  for (const name of Object.keys(engine.good)) {
    test(`${engine.name}: the option ${name} must be an integer from 1 to 2**31 - 1, of any type that it is given as`, () => {
      for (const [bad, shown] of BAD) {
        const error = thrown(() => engine.make({ [name]: bad }))
        expect(error).toBeInstanceOf(RangeError)
        expect((error as RangeError).message).toBe(message(engine.name, name, shown))
        // A bad value among good ones is still refused.
        expect(thrown(() => engine.make({ ...engine.good, [name]: bad }))).toBeInstanceOf(RangeError)
      }
      // The two ends of the domain, a field given as undefined, and a field
      // not given.
      for (const good of [1, LARGEST, engine.good[name], undefined]) {
        expect(thrown(() => engine.make({ [name]: good }))).toBeUndefined()
      }
      expect(thrown(() => engine.make({}))).toBeUndefined()
      expect(thrown(() => engine.make({ ...engine.good }))).toBeUndefined()
    })

    test(`${engine.name}: a bad ${name} that an inherited property or a getter gives is refused too`, () => {
      for (const [bad, shown] of BAD) {
        const inherited = Object.create({ [name]: bad }) as object
        expect((thrown(() => engine.make(inherited)) as RangeError).message).toBe(message(engine.name, name, shown))
        const getter = Object.defineProperty({}, name, { get: () => bad, enumerable: false })
        expect((thrown(() => engine.make(getter)) as RangeError).message).toBe(message(engine.name, name, shown))
      }
      // A good value that they give passes.
      expect(thrown(() => engine.make(Object.create({ [name]: engine.good[name] }) as object))).toBeUndefined()
    })
  }
}

// Runs `programs` one after the other on the sandbox of `layer`, each in a
// new call of one turn, in a new store, with no functions.
const runs = (layer: Layered, programs: ReadonlyArray<string>): Promise<Array<Ran>> => {
  const none = Layer.succeed(Functions, Functions.of({ declarations: [], names: [], call: () => Effect.die("no function") }))
  return withStore(
    newFile(),
    Effect.gen(function*() {
      const store = yield* Store
      const box = yield* Sandbox
      const turn = yield* store.startTurn({ pick: PICK, head: "{}", firstMsg: 0 })
      const results: Array<Ran> = []
      for (const [n, program] of programs.entries()) {
        const call = yield* store.startCall({ turn: turn.id, vendorId: "call_" + n, fn: "run", input: program })
        results.push(yield* box.run(program, { turn: turn.id, call }))
      }
      return results
    }).pipe(Effect.provide(layer.pipe(Layer.provide(none))))
  )
}

// A program that holds `megabytes` strings of 1 MiB at once, then returns
// how many it holds.
const hold = (megabytes: number) =>
  `const all = []; for (let i = 0; i < ${megabytes}; i++) all.push('x'.repeat(${MiB}) + i); return all.length`

for (const engine of engines) {
  test(`${engine.name}: a getter of each numeric option is read once, at the layer's call, and a bad value after the first never reaches the engine`, async () => {
    for (const name of Object.keys(engine.good)) {
      // The first read gives the good value, and every read after it 2**32:
      // as a memory limit that wraps to 0, which is no limit, and as a
      // delay it is out of `setTimeout`'s range.
      let reads = 0
      const given = Object.defineProperty({}, name, {
        get: () => (++reads === 1 ? engine.good[name] : 2 ** 32),
        enumerable: true
      })
      const layer = engine.make(given)
      expect([name, reads]).toEqual([name, 1])
      // How the test knows that the engine has the first value: building
      // the layer and running programs on it reads the getter no more. For
      // the memory, the engine also acts on the good value: the program of
      // twice its limit fails, which it would not do with no limit.
      const [small, over] = await runs(layer, ["return 1", hold(64)])
      expect([name, reads, small]).toEqual([name, 1, { output: "1", failed: false }])
      if (name === "memory") {
        expect(over!.failed).toBe(true)
        expect(over!.output).not.toBe("64")
      }
    }
  }, 30_000)

  test(`${engine.name}: the memory wall at the ends of the domain: 32 MiB stops 64 MiB, 1 byte stops everything, 2**31 - 1 runs a small program`, async () => {
    const [control] = await runs(engine.make({ memory: 32 * MiB }), [hold(64)])
    expect(control!.failed).toBe(true)
    expect(control!.output).toContain("out of memory")
    const [tiny, after] = await runs(engine.make({ memory: 1 }), [hold(64), "return 1"])
    // With 1 byte, the engine cannot even start the program.
    expect(tiny!.failed).toBe(true)
    expect(tiny!.output).not.toBe("64")
    expect(after!.failed).toBe(true)
    const [large] = await runs(engine.make({ memory: LARGEST }), ["return 1 + 1"])
    expect(large).toEqual({ output: "2", failed: false })
  }, 30_000)
}
