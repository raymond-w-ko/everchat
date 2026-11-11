// Tests of the diagnostics: Effect's logger for the table `log`. What a
// line holds, when it is written, what is dropped, and that nothing goes
// to the console.

import { afterEach, beforeEach, expect, test } from "bun:test"
import { Cause, Effect, Layer, References, Schedule } from "effect"
import { compactor, newFile, options, rows, write } from "../tests/help.ts"
import * as Diagnostics from "./diagnostics.ts"
import { CompactionRetry, CompactorError, Memory } from "./memory.ts"
import { Store, StoreError } from "./store.ts"

interface Line {
  readonly level: string
  readonly source: string
  readonly text: string
}

const lines = (file: string) => rows<Line>(file, "select level, source, text from log order by seq")

// One launch with the store and the logger.
const withDiagnostics = <A, E>(file: string, effect: Effect.Effect<A, E, Store>) => {
  const store = Store.layer(file, options())
  return Effect.runPromise(effect.pipe(Effect.provide(Diagnostics.layer.pipe(Layer.provideMerge(store)))))
}

// What the console and stderr got during a test.
let printed: Array<string> = []
const real = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug, write: process.stderr.write }
beforeEach(() => {
  printed = []
  const keep = (...parts: Array<unknown>) => void printed.push(parts.join(" "))
  Object.assign(console, { log: keep, error: keep, warn: keep, info: keep, debug: keep })
  process.stderr.write = ((chunk: unknown) => (printed.push(String(chunk)), true)) as typeof process.stderr.write
})
afterEach(() => {
  Object.assign(console, { log: real.log, error: real.error, warn: real.warn, info: real.info, debug: real.debug })
  process.stderr.write = real.write
})

test("each line goes to the table with its level and its source, in order, and nothing goes to the console", async () => {
  const file = newFile()
  await withDiagnostics(file, Effect.gen(function*() {
    yield* Effect.logInfo("it started")
    yield* Effect.logWarning("a request failed").pipe(Effect.annotateLogs("source", "ask"))
    yield* Effect.logError("a node is not built").pipe(Effect.annotateLogs(Diagnostics.SOURCE, "memory"))
    yield* Effect.logFatal("the end")
    // Below the minimum level: dropped.
    yield* Effect.logDebug("a detail")
    yield* Effect.logTrace("a small detail")
  }))
  expect(lines(file)).toEqual([
    { level: "info", source: Diagnostics.NONE, text: "it started" },
    { level: "warn", source: "ask", text: "a request failed" },
    { level: "error", source: "memory", text: "a node is not built" },
    { level: "error", source: "everchat", text: "the end" }
  ])
  expect(printed).toEqual([])
  // Each line names its launch, and its time is a time of now.
  const [first] = rows<{ launch: number; created: number }>(file, "select launch, created from log order by seq")
  expect(first!.launch).toBe(1)
  expect(Math.abs(Date.now() - first!.created)).toBeLessThan(60_000)
})

test("the minimum level is Effect's: with Debug, the details are written too", async () => {
  const file = newFile()
  await withDiagnostics(file, Effect.gen(function*() {
    yield* Effect.logDebug("a detail")
    yield* Effect.logTrace("a small detail")
  }).pipe(Effect.provideService(References.MinimumLogLevel, "Debug")))
  expect(lines(file)).toEqual([{ level: "debug", source: "everchat", text: "a detail" }])
})

test("a line's text is its message, then its other annotations, then its cause", async () => {
  const file = newFile()
  await withDiagnostics(file, Effect.gen(function*() {
    yield* Effect.logWarning("prompt cache miss", { model: "gpt-test", read: 0 }, 42)
    yield* Effect.logWarning("asked again").pipe(Effect.annotateLogs({ source: "ask", node: "3/7", tries: 2 }))
    yield* Effect.logWarning("it failed", new StoreError({ op: "append", cause: "disk full" }))
    yield* Effect.logError("the turn loop stopped", Cause.fail(new Error("boom")))
    yield* Effect.logError(Cause.die("only a cause"))
  }))
  const got = lines(file)
  expect(got[0]!.text).toBe("prompt cache miss {\"model\":\"gpt-test\",\"read\":0} 42")
  expect(got[1]).toEqual({ level: "warn", source: "ask", text: "asked again node=3/7 tries=2" })
  expect(got[2]!.text).toStartWith("it failed StoreError")
  expect(got[3]!.text).toStartWith("the turn loop stopped\nError: boom")
  expect(got[4]!.text).toContain("only a cause")
})

test("lines are written within a window while the program runs, and the rest when it ends", async () => {
  const file = newFile()
  await withDiagnostics(file, Effect.gen(function*() {
    yield* Effect.logInfo("early")
    expect(lines(file)).toEqual([])
    yield* Effect.sleep(Diagnostics.WINDOW * 4)
    expect(lines(file).map((line) => line.text)).toEqual(["early"])
    yield* Effect.logInfo("late")
  }))
  expect(lines(file).map((line) => line.text)).toEqual(["early", "late"])
})

test("a launch deletes the diagnostics that are older than 30 days", async () => {
  const file = newFile()
  await withDiagnostics(file, Effect.logInfo("of the first launch"))
  const day = 24 * 60 * 60 * 1000
  write(file, "insert into log (level, source, text, launch, created) values ('info', 'old', 'of 31 days ago', 1, ?), ('info', 'old', 'of 29 days ago', 1, ?)", [
    Date.now() - 31 * day,
    Date.now() - 29 * day
  ])
  await withDiagnostics(file, Effect.logInfo("of the second launch"))
  expect(lines(file).map((line) => line.text)).toEqual(["of the first launch", "of 29 days ago", "of the second launch"])
  expect(Diagnostics.KEEP).toBe(30 * day)
})

test("a batch that the database refuses is counted, and the next batch says how many were lost", async () => {
  const file = newFile()
  let refuse = true
  const real = Store.layer(file, options())
  // The same store, but its first writes of diagnostics fail.
  const flaky = Layer.effect(
    Store,
    Store.use((store) =>
      Effect.succeed(Store.of({
        ...store,
        addDiagnostics: (given) => (refuse ? Effect.fail(new StoreError({ op: "addDiagnostics", cause: "refused" })) : store.addDiagnostics(given))
      })))
  ).pipe(Layer.provide(real))
  await Effect.runPromise(
    Effect.gen(function*() {
      yield* Effect.logInfo("lost 1")
      yield* Effect.logInfo("lost 2")
      yield* Effect.sleep(Diagnostics.WINDOW * 3)
      yield* Effect.logInfo("lost 3")
      yield* Effect.sleep(Diagnostics.WINDOW * 3)
      refuse = false
      yield* Effect.logInfo("kept")
    }).pipe(Effect.provide(Diagnostics.layer.pipe(Layer.provide(flaky))))
  )
  expect(lines(file)).toEqual([
    { level: "warn", source: "diagnostics", text: "3 diagnostics were lost: the database refused them" },
    { level: "info", source: "everchat", text: "kept" }
  ])
  // A refused batch is not printed either.
  expect(printed).toEqual([])
})

test("the store reads diagnostics after a place, oldest first", async () => {
  const file = newFile()
  await Effect.runPromise(
    Effect.gen(function*() {
      const store = yield* Store
      yield* store.addDiagnostics([])
      yield* store.addDiagnostics([
        { level: "info", source: "a", text: "one", created: 10 },
        { level: "warn", source: "b", text: "two \ud800", created: 20 },
        { level: "error", source: "c", text: "three", created: 30 }
      ])
      const all = yield* store.diagnostics()
      expect(all.map((one) => [one.seq, one.level, one.source, one.text, one.launch, one.created])).toEqual([
        [1, "info", "a", "one", 1, 10],
        // A lone half of a character is replaced: the database holds valid text.
        [2, "warn", "b", "two �", 1, 20],
        [3, "error", "c", "three", 1, 30]
      ])
      expect((yield* store.diagnostics(1)).map((one) => one.text)).toEqual(["two �", "three"])
      expect((yield* store.diagnostics(0, 2)).map((one) => one.text)).toEqual(["one", "two �"])
      // Only those from before the time given: the one of that time stays.
      expect(yield* store.dropDiagnostics(20)).toBe(1)
      expect((yield* store.diagnostics()).map((one) => one.text)).toEqual(["two \ufffd", "three"])
      expect(yield* store.dropDiagnostics(21)).toBe(1)
      expect((yield* store.diagnostics()).map((one) => one.text)).toEqual(["three"])
    }).pipe(Effect.provide(Store.layer(file, options())))
  )
})

test("a fiber that a service forks logs to the table, when the logger is merged under the service", async () => {
  const file = newFile()
  let asked = 0
  // A compaction that fails once: the memory's own fiber asks again, and says so.
  const failing = compactor(() => (++asked === 1 ? Effect.fail(new CompactorError({ cause: "the vendor is down" })) : Effect.succeed({ text: "a short line" })))
  const pushLong = Effect.gen(function*() {
    const service = yield* Memory
    yield* service.push([{ kind: "user", text: "long ".repeat(200) }])
    yield* service.idle
  })
  const base = Diagnostics.layer.pipe(Layer.provideMerge(Store.layer(file, options())))
  const memory = Memory.layer.pipe(Layer.provide(failing), Layer.provideMerge(base))
  await Effect.runPromise(pushLong.pipe(Effect.provide(memory), Effect.provideService(CompactionRetry, Schedule.spaced("1 millis"))))
  expect(asked).toBe(2)
  const got = lines(file)
  expect(got.length).toBe(1)
  expect(got[0]).toMatchObject({ level: "warn", source: "memory" })
  expect(got[0]!.text).toStartWith("the compaction of node 0/0 failed, and is asked again")
  expect(printed).toEqual([])

  // The logger only under the layer, and not merged: the fiber is forked in
  // a method, with the caller's context, so its line goes to the console.
  const other = newFile()
  asked = 0
  const store = Store.layer(other, options())
  const under = Memory.layer.pipe(Layer.provide(failing), Layer.provide(Diagnostics.layer.pipe(Layer.provide(store))), Layer.provideMerge(store))
  await Effect.runPromise(pushLong.pipe(Effect.provide(under), Effect.provideService(CompactionRetry, Schedule.spaced("1 millis"))))
  expect(lines(other)).toEqual([])
  expect(printed.length).toBe(1)
  expect(printed[0]).toContain("the compaction of node 0/0 failed")
})
