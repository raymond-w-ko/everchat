// Hosted
// ======
// The stack of a host's chat: the local program's stack as a function of a
// store, for `everchat serve` (docs/host.md, section 9, item 5; section 8,
// "The bytes of one entry", 5). The host gives it as `HostOptions.stack`
// (`@everchat/server`), and builds it over the store that `Chats.store`
// gives for each chat that it loads. The terminal keeps its own stack
// (main.ts, `layer`).
//
// `hostedStack(options)` is an effect with a `Scope`. It builds, one time
// for the process and in that scope, what holds no chat's state: the wire,
// over the author's inference gateway. `gatewayLayer` deletes the gateway's
// key from the environment at its first read, so a second build in the
// process would find none (docs/host.md, section 2, "What a loaded chat
// holds, and what the process holds"). It gives the function of a store.
// For each store, that function's layer builds every part that holds a
// chat's state, over that store and for that chat alone: the diagnostics
// (into the chat's log), the cache watch, the ask service, the compactor
// and the memory, the output limit, the functions, the sandbox's thread,
// and the turn loop. Two chats share no state of a chat.
//
// The chat's diagnostics. The terminal runs its interface inside its stack,
// so every fiber has the logger of the table `log` (main.ts). The host calls
// a chat's `Turns` from its own fibers, and the turn loop forks a turn, and
// the memory a compaction, from the fiber that calls: with the caller's
// loggers. So this stack's `Turns` runs `say` and `stop` with the chat's own
// loggers: what a turn or a compaction logs (a retry of a request, a
// compaction that failed, a loop that stopped) goes into the chat's log, as
// in the terminal.
//
// The hosted set. A host's chat has no machine: its functions are the
// core's `hostedLayer` (`zoom`, `date`, `result`), and the turn loop and the
// compactor show `HOSTED` in the head: one value, made once for the process
// and given to the three layers (functions.ts, "One list for each stack").
// There is no shell, no function of
// the files and no work directory, and the output limit is `noFileLayer`:
// a long result is shortened and names `result(id)`, and no file is
// written. A program that calls `shell`, `read`, `write` or `edit` gets the
// sandbox's error for a name that is not there, and nothing runs.
//
// The hub. The turn loop's hub has the capacity `hub` (`Turns.layer`'s
// option): a full hub drops its oldest event, so a turn never waits for a
// listener that does not take (docs/host.md, section 8, "The bounds between
// the turn loop and a client").
//
// The cap of one answer. Every request of the chat to a model, a turn's and
// a compaction's, goes with `max` at most `max` tokens (16,384 when not
// given): a request with no `max` or a larger one gets the cap, one with a
// smaller one keeps its own. The wire sends it as `max_output_tokens`. It is
// set on the ask service of the chat, so it holds for every vendor's wire.
// Its measure in bytes (the page's C, section 8, "The bytes of one entry",
// 5): 16,384 tokens at up to 24 bytes of JSON for a token is 393,216 bytes,
// under 394,452, the largest `accepted` at the defaults. The 24 bytes for a
// token are the lead's assumption, not a measure: a case of hosted.test.ts
// gives a fake wire's answer of 393,216 bytes in one program and measures
// its `call` event's JSON; the vendor's true bytes for a token are for a
// real run, which no test here makes.
//
// The bounds of one program. The sandbox's thread gets the deadline of a
// program, `deadline` (600,000 ms when not given: the design's 10 minutes,
// docs/design.md, "Limits for hosted programs"), and the count of the calls
// of one program, `calls` (256 when not given): thread.ts says what each
// does at its limit. They bound one program, not a turn: a turn's programs
// are the model's steps, and their sum is the server plan's limit
// (ec-sceh). The count bounds the bytes that one program's calls write to
// the store at `calls` times the largest input and output of one call (a
// review's probe of `for (;;) { await result(1) }` with neither wrote
// 2,136 call rows, about 107 MB, in 8 s: ec-ihoya); the deadline bounds the
// time, a function at work too. The compute limit and the count of polls
// stay the thread engine's defaults.
//
// This module imports no HTTP server and nothing of `@everchat/server`: the
// type of the function is `HostOptions.stack`'s, written out.

import { type Context, Effect, Layer, Logger, type Scope } from "effect"
import { Ask } from "@everchat/core/ask"
import { Cache } from "@everchat/core/cache"
import * as Compactor from "@everchat/core/compactor"
import * as Diagnostics from "@everchat/core/diagnostics"
import { type Declaration, HOSTED, hostedLayer } from "@everchat/core/functions"
import { head } from "@everchat/core/head"
import { noFileLayer } from "@everchat/core/limit"
import { Memory } from "@everchat/core/memory"
import type { Request, VendorWire } from "@everchat/core/request"
import { type Pick, Store } from "@everchat/core/store"
import { Turns } from "@everchat/core/turn"
import { type Options as ThreadOptions, threadLayer } from "@everchat/codemode/thread"
import { openaiLayer } from "@everchat/openai"
import type { GatewayError } from "@everchat/openai/gateway"
import { gatewayLayer } from "./gateway.ts"

// The cap of one answer, in tokens, when the options give none.
export const MAX = 16_384

// The deadline of one program, in milliseconds, when the options give none:
// the design's 10 minutes.
export const DEADLINE = 600_000

// The count of the calls of functions in one program, when the options give
// none.
export const CALLS = 256

// The program of the sandbox's worker thread, next to this file as main.ts
// has it (main.ts, `WORKER`, says why).
const WORKER = new URL("./worker.ts", import.meta.url)

export interface HostedOptions<E> {
  readonly compactor: Pick // the compactor's model
  readonly hub: number // the turn loop's hub's capacity, from 1 to 65,536
  readonly max?: number | undefined // the cap of one answer in tokens (MAX)
  readonly deadline?: number | undefined // the deadline of one program in ms (DEADLINE)
  readonly calls?: number | undefined // the count of the calls of one program (CALLS)
  // For the tests: the wires in place of the gateway's (`openaiLayer` over
  // `gatewayLayer`). Built one time, as that one is.
  readonly wire?: Layer.Layer<VendorWire, E> | undefined
}

// The stack of one chat over its store, as `HostOptions.stack` has it.
export type HostedStack = (store: typeof Store.Service) => Layer.Layer<Turns | Memory, unknown>

// The turn loop of the layer below, whose `say` and `stop` run with the
// loggers of the chat's stack (the head comment).
const ownLogs = Layer.effect(
  Turns,
  Effect.gen(function*() {
    const turns = yield* Turns
    const loggers = yield* Logger.CurrentLoggers
    const own = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, Logger.CurrentLoggers, loggers)
    return Turns.of({ ...turns, say: (text, key, told) => own(turns.say(text, key, told)), stop: (why) => own(turns.stop(why)) })
  })
)

// The options of the sandbox's thread for `options`: the worker, and the
// bounds of one program (the head comment).
export const engineOptions = <E>(options: HostedOptions<E>): ThreadOptions => ({
  worker: WORKER,
  deadline: options.deadline ?? DEADLINE,
  calls: options.calls ?? CALLS
})

// `request` with `max` at most `cap`.
const capped = (request: Request, cap: number): Request =>
  request.max !== undefined && request.max <= cap ? request : { ...request, max: cap }

export const hostedStack = <E = GatewayError>(options: HostedOptions<E>): Effect.Effect<HostedStack, E, Scope.Scope> =>
  Effect.gen(function*() {
    const cap = options.max ?? MAX
    const engine = engineOptions(options)
    const given: Layer.Layer<VendorWire, E> = options.wire ?? (openaiLayer.pipe(Layer.provide(gatewayLayer)) as Layer.Layer<VendorWire, E>)
    // One time for the process: the wires.
    const wires = yield* Layer.build(given)
    const wire = Layer.succeedContext(wires as Context.Context<VendorWire>)
    // One time for the process: the chats' functions, for the head and the
    // sandbox, and the head made from them, for the turns and the
    // compactions.
    const declarations: ReadonlyArray<Declaration> = HOSTED
    const made = head(declarations)
    return (store) => {
      const base = Diagnostics.layer.pipe(Layer.provideMerge(Layer.succeed(Store, store)))
      const inner = Ask.layer.pipe(Layer.provide(Layer.merge(Cache.layer, wire)))
      const ask = Layer.effect(
        Ask,
        Effect.map(Ask, (asker) =>
          Ask.of({
            stream: (request, how) => asker.stream(capped(request, cap), how),
            ask: (request, how) => asker.ask(capped(request, cap), how)
          }))
      ).pipe(Layer.provide(inner), Layer.provideMerge(base))
      const memory = Memory.layer.pipe(Layer.provide(Compactor.layer({ pick: options.compactor, head: made })), Layer.provideMerge(ask))
      const limits = noFileLayer().pipe(Layer.provideMerge(memory))
      const functions = hostedLayer(declarations).pipe(Layer.provideMerge(limits))
      const sandbox = threadLayer(engine).pipe(Layer.provideMerge(functions))
      const turns = Turns.layer({ head: made, hub: options.hub }).pipe(Layer.provideMerge(sandbox))
      return ownLogs.pipe(Layer.provideMerge(turns))
    }
  })
