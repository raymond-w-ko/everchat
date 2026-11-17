// The registry and the channel
// ============================
// The host's place for one chat, and the give (docs/host.md, section 2,
// "The channel and the loaded chat" and "The give"; section 8, "A slow
// client"; lead, ec-3xoc2). No load, no store and no route here: the first
// read, the join's caller, the load and the unload build on it.
//
// The registry finds the channel of a chat by its tenant and its UUID, both
// (a map of maps: two tenants never share a channel, also for the same UUID
// text). It has one lock, and two steps change it, each one step under that
// lock that an interruption cannot split, and neither reads a store: `hold`
// finds the channel or makes it, and adds a holder; `letGo` removes a
// holder, and takes the channel out when none is left. Callers use `held`,
// which holds now and lets go when its scope closes, so no path can lose a
// holder.
//
// A channel holds its tenant and UUID, the count of its holders, its
// clients, `last` (`null` before the first load), a place for the loaded
// chat (`loaded`, of a type that the caller picks), the lock and the give
// lock (each a semaphore of one permit).
//
// A client has a buffer of fitted JSON texts with two bounds, `buffer`
// entries and `bufferBytes` bytes; its `given`; and whether it joined. Its
// reader takes entries one at a time (`take`), which frees their room, and
// sees its end with the reason. `waitForPage` waits until the buffer has
// room for a page (`page` entries and `pageBytes` bytes): a first read's
// step 1. `whenEnded` waits for the client's end alone, with no take: the
// watch of a stream's client that nothing pulls (R4).
//
// Each change of the clients and of their buffers runs under the give lock,
// as one step that an interruption cannot split (`Effect.uninterruptible`),
// and never waits on a client:
//
// - `addClient(given, options)` and `removeClient(client, reason)`. A chat
//   has at most `chatClients` clients and the registry's channels together
//   at most `hostClients`: one count, shared. Past either, `ClientRefused`
//   (`busy`). A client's end gives its place back. After the registry's
//   `stop`, every channel of it refuses each new client with
//   `ClientRefused` (`busy`, bound `host`), as a full host does. With `pieces: false` the
//   client gets no piece (R5's, which answers numbered events only; lead,
//   ec-cxuj5): the give of a piece passes it by. All else is as for any
//   client: its numbered events, the host's frames, its join, its place in
//   the counts and its ends.
// - `give(entry)`, a numbered event: into the buffer of each client that
//   joined and whose `given` is below the event's number; it sets that
//   client's `given`, and sets `last`.
// - `givePiece(entry)`: into the buffer of each client that joined and gets
//   pieces; it moves no number. A client with `pieces: false` is passed by:
//   no entry, no byte, no wake of its reader and no end by it.
// - `tell(client, text)`: one of the host's own frames, for one client,
//   joined or not; it counts in both bounds and moves no number.
// - `tellIfEmpty(client, text)`: a ping (R4, R6; lead, ec-ek7fa): the
//   check that the buffer is empty and the put are one step, so no give
//   that waits on the lock falls between them. It puts nothing into a
//   buffer that holds a text, nor into one with no room for it (`waiting`),
//   and never ends the client.
// - `giveTo(client, entries)`: a page of a client's own first read, into
//   that client's buffer. It checks the room here: a page that does not fit
//   whole is not put, no part of it, and the client stays (`noRoom`).
// - `join(client)`: the client joins when its `given` is `last` or more (or
//   the channel has no `last`), and its buffer has room for one entry of
//   `entry` bytes and for one entry in count. Else it does not join.
// - `listen(seq)`: the listener's start at a load; it sets `last` to the
//   lower of `seq` and the lowest `given` of the clients that joined, or to
//   `seq` with none. A client's `given` never raises `last` above `seq`.
// - `lowestGiven`: that lowest `given`, or none: where an unload reads.
// - `cannotGive(n)`: an event that cannot be given; each client that
//   joined and whose `given` is below `n` ends with `internal`, and `last`
//   becomes `n` when that is higher.
//
// A give, a piece and a frame never wait: a client with no room for its
// entry ends as `slow` in the same step. Its buffer is freed, it leaves the
// channel's clients, and its reader sees the end. A client that has not
// joined gets no give and no piece.
//
// JavaScript runs one fiber at a time, but a step of Effect can yield to
// another fiber between its parts; the give lock keeps two gives (and a
// give and a page) from mixing, and `uninterruptible` keeps an interruption
// from stopping a give between two clients.

import { Deferred, Effect, Exit, Schema, type Scope, Semaphore } from "effect"
import { type Entry, utf8 } from "./fit.ts"

// The reasons of a client's end, which the routes map to their codes.
export const REASONS = ["slow", "token", "busy", "stop", "internal"] as const
export type Reason = (typeof REASONS)[number]

// The limits that the registry uses, as the host's `Limits` names them.
export interface ChannelLimits {
  readonly buffer: number
  readonly bufferBytes: number
  readonly entry: number
  readonly page: number
  readonly pageBytes: number
  readonly chatClients: number
  readonly hostClients: number
}

// A client past the bound of its chat (`chat`) or of the host (`host`).
export class ClientRefused extends Schema.TaggedError<ClientRefused>()("ClientRefused", {
  reason: Schema.Literal("busy"),
  bound: Schema.Literals(["chat", "host"])
}) {}

// What a client's reader takes: the next text of its buffer, or its end,
// with the reason (`null`: removed with none, as when it went away).
export type Taken =
  | { readonly _tag: "Text"; readonly text: string; readonly bytes: number }
  | { readonly _tag: "End"; readonly reason: Reason | null }

// A change that the waiters of a client wait for.
class Signal {
  private waiters: Array<Deferred.Deferred<void>> = []
  wake() {
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) Deferred.doneUnsafe(waiter, Exit.void)
  }
  // The value of `check`, once it gives one (not `undefined`). When it gives
  // none, the waiter is made and put into the list in the same synchronous
  // body as the check: Effect's fiber loop can yield between two steps, and
  // a `wake` in that gap would find no waiter, and the reader would wait for
  // good with a text, with room or after its end. The check and the
  // registration are not interruptible; the wait is, and a waiter that
  // leaves the wait (woken, or interrupted) is taken out of the list. After
  // a wake, the check runs again.
  until<A>(check: () => A | undefined): Effect.Effect<A> {
    const step = Effect.uninterruptibleMask((restore) =>
      Effect.suspend((): Effect.Effect<A | undefined> => {
        const found = check()
        if (found !== undefined) return Effect.succeed(found)
        const waiter = Deferred.makeUnsafe<void>()
        this.waiters.push(waiter)
        return restore(Deferred.await(waiter)).pipe(
          Effect.ensuring(Effect.sync(() => this.remove(waiter))),
          Effect.as(undefined)
        )
      })
    )
    const loop: Effect.Effect<A> = Effect.flatMap(step, (found) => (found === undefined ? loop : Effect.succeed(found)))
    return loop
  }
  // The waiters in the list now.
  get size(): number {
    return this.waiters.length
  }
  private remove(waiter: Deferred.Deferred<void>) {
    const at = this.waiters.indexOf(waiter)
    if (at >= 0) this.waiters.splice(at, 1)
  }
}

export class Client {
  private texts: Array<{ readonly text: string; readonly bytes: number }> = []
  private head = 0
  private used = 0
  private finished: { readonly reason: Reason | null } | null = null
  private isJoined = false
  private number: number
  private readonly changed = new Signal()

  constructor(given: number, private readonly limits: ChannelLimits) {
    this.number = given
  }

  // The highest event number put into the buffer: at the start, the
  // client's `after` or its snapshot's `seq`.
  get given(): number {
    return this.number
  }
  get joined(): boolean {
    return this.isJoined
  }
  // The end and its reason, or `null` while it is a client.
  get ended(): { readonly reason: Reason | null } | null {
    return this.finished
  }
  // The texts in the buffer, and their bytes.
  get size(): { readonly entries: number; readonly bytes: number } {
    return { entries: this.texts.length - this.head, bytes: this.used }
  }

  // Room for `entries` more texts of `bytes` bytes in all.
  hasRoom(entries: number, bytes: number): boolean {
    return this.texts.length - this.head + entries <= this.limits.buffer && this.used + bytes <= this.limits.bufferBytes
  }

  // The next text, when there is one, or the end; else it waits.
  get take(): Effect.Effect<Taken> {
    return this.changed.until((): Taken | undefined => {
      if (this.head < this.texts.length) {
        const taken = this.texts[this.head] as { readonly text: string; readonly bytes: number }
        this.texts[this.head] = undefined as never
        this.head += 1
        if (this.head > 1024 && this.head * 2 > this.texts.length) {
          this.texts = this.texts.slice(this.head)
          this.head = 0
        }
        this.used -= taken.bytes
        this.changed.wake()
        return { _tag: "Text", ...taken }
      }
      if (this.finished !== null) return { _tag: "End", reason: this.finished.reason }
      return undefined
    })
  }

  // Waits until the buffer has room for a page (`page` entries and
  // `pageBytes` bytes): `true`; or the client's end: `false`.
  get waitForPage(): Effect.Effect<boolean> {
    return this.changed.until((): boolean | undefined => {
      if (this.finished !== null) return false
      if (this.hasRoom(this.limits.page, this.limits.pageBytes)) return true
      return undefined
    })
  }

  // Waits until the client has ended, and gives its reason (`null`: removed
  // with none). It takes no text and frees no room; a wait that is
  // interrupted leaves no waiter (lead, ec-5njke, ruling 10).
  get whenEnded(): Effect.Effect<Reason | null> {
    return Effect.map(this.changed.until(() => (this.finished === null ? undefined : this.finished)), (end) => end.reason)
  }

  // The parts below run only in a step of the channel, under its give lock.

  /** @internal */
  put(text: string, bytes: number) {
    this.texts.push({ text, bytes })
    this.used += bytes
    this.changed.wake()
  }
  /** @internal */
  setGiven(n: number) {
    this.number = n
  }
  /** @internal */
  setJoined() {
    this.isJoined = true
  }
  /** @internal */
  finish(reason: Reason | null) {
    this.finished = { reason }
    this.texts = []
    this.head = 0
    this.used = 0
    this.changed.wake()
  }
}

// The count of the clients of the host, which all channels of a registry
// share, and whether the registry has stopped (its `stop`).
interface HostCount {
  clients: number
  stopped: boolean
}

export class Channel<L = unknown> {
  private holding = 0
  private readonly members = new Set<Client>()
  // The clients that were added with `pieces: false`.
  private readonly noPieces = new WeakSet<Client>()
  private latest: number | null = null
  // The loaded chat, or none.
  loaded: L | undefined = undefined
  // The lock for the load, the unload and each message in.
  readonly lock: Semaphore.Semaphore = Semaphore.makeUnsafe(1)
  // The give lock.
  readonly giveLock: Semaphore.Semaphore = Semaphore.makeUnsafe(1)

  constructor(
    readonly tenant: string,
    readonly uuid: string,
    private readonly limits: ChannelLimits,
    private readonly host: HostCount
  ) {}

  get holders(): number {
    return this.holding
  }
  // The highest event number given to the clients that joined, or `null`
  // before the first load.
  get last(): number | null {
    return this.latest
  }
  get clients(): ReadonlyArray<Client> {
    return [...this.members]
  }

  /** @internal */
  addHolder() {
    this.holding += 1
  }
  /** @internal */
  removeHolder(): number {
    this.holding -= 1
    return this.holding
  }

  // One step under the give lock that an interruption cannot split.
  private step<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> {
    return Semaphore.withPermit(this.giveLock, Effect.uninterruptible(effect))
  }

  // The end of `client`: it leaves the clients, its buffer is freed, and its
  // place in both counts is given back. Under the give lock.
  private end(client: Client, reason: Reason | null) {
    if (!this.members.delete(client)) return
    this.host.clients -= 1
    client.finish(reason)
  }

  // Puts `text` into `client`'s buffer, or ends it as `slow`.
  private putOrEnd(client: Client, text: string, bytes: number): boolean {
    if (!client.hasRoom(1, bytes)) {
      this.end(client, "slow")
      return false
    }
    client.put(text, bytes)
    return true
  }

  // A new client of the chat, whose `given` is `given`; with `pieces: false`,
  // one that gets no piece. A `given` that is not a safe whole number from 0
  // is the caller's fault (the routes refuse such an `after` first): it dies,
  // before every other check, and adds no client (lead, ec-ajj5m, 4).
  addClient(given: number, options?: { readonly pieces: boolean }): Effect.Effect<Client, ClientRefused> {
    if (!(Number.isSafeInteger(given) && given >= 0)) {
      return Effect.die(new Error("a client's given is a safe whole number from 0, not " + String(given)))
    }
    return this.step(Effect.suspend(() => {
      // The check and the add are one synchronous body: after the
      // registry's `stop` has returned, no client is added.
      if (this.host.stopped) return Effect.fail(new ClientRefused({ reason: "busy", bound: "host" }))
      if (this.members.size >= this.limits.chatClients) return Effect.fail(new ClientRefused({ reason: "busy", bound: "chat" }))
      if (this.host.clients >= this.limits.hostClients) return Effect.fail(new ClientRefused({ reason: "busy", bound: "host" }))
      const client = new Client(given, this.limits)
      this.members.add(client)
      if (options?.pieces === false) this.noPieces.add(client)
      this.host.clients += 1
      return Effect.succeed(client)
    }))
  }

  // Ends `client` with `reason` (`null`: it went away). Its reader sees the
  // end; a client that ended already stays as it is.
  removeClient(client: Client, reason: Reason | null = null): Effect.Effect<void> {
    return this.step(Effect.sync(() => this.end(client, reason)))
  }

  // The give of a numbered event (above).
  give(entry: Entry): Effect.Effect<void> {
    const n = entry.n
    if (n === null) return Effect.die(new Error("a give takes a numbered event; a piece is givePiece's"))
    return this.step(Effect.suspend(() =>
      Effect.andThen(
        Effect.forEach(this.clients, (client) =>
          Effect.sync(() => {
            if (!client.joined || client.given >= n) return
            if (this.putOrEnd(client, entry.json, entry.bytes)) client.setGiven(n)
          }), { discard: true }),
        Effect.sync(() => {
          if (this.latest === null || n > this.latest) this.latest = n
        })
      )
    ))
  }

  // The give of a piece (above).
  givePiece(entry: Entry): Effect.Effect<void> {
    return this.step(Effect.suspend(() =>
      Effect.forEach(this.clients, (client) =>
        Effect.sync(() => {
          if (client.joined && !this.noPieces.has(client)) this.putOrEnd(client, entry.json, entry.bytes)
        }), { discard: true })
    ))
  }

  // One of the host's own frames for `client`: `told`, or `ended` (it found
  // no room and ended the client as `slow`, or the client had ended).
  tell(client: Client, text: string): Effect.Effect<"told" | "ended"> {
    return this.step(Effect.sync(() => {
      if (client.ended !== null || !this.members.has(client)) return "ended"
      return this.putOrEnd(client, text, utf8(text)) ? "told" : "ended"
    }))
  }

  // A ping for `client` (above): `told` (put into its empty buffer),
  // `waiting` (its buffer holds a text, or has no room for it: nothing is
  // put, and the client stays), or `ended` (the client had ended).
  tellIfEmpty(client: Client, text: string): Effect.Effect<"told" | "waiting" | "ended"> {
    return this.step(Effect.sync(() => {
      if (client.ended !== null || !this.members.has(client)) return "ended"
      const bytes = utf8(text)
      if (client.size.entries > 0 || !client.hasRoom(1, bytes)) return "waiting"
      client.put(text, bytes)
      return "told"
    }))
  }

  // A page of `client`'s own first read: `given`, `noRoom` (nothing put, the
  // client stays), or `ended` (the client had ended).
  giveTo(client: Client, entries: ReadonlyArray<Entry>): Effect.Effect<"given" | "noRoom" | "ended"> {
    return this.step(Effect.sync(() => {
      if (client.ended !== null || !this.members.has(client)) return "ended"
      let bytes = 0
      for (const entry of entries) bytes += entry.bytes
      if (!client.hasRoom(entries.length, bytes)) return "noRoom"
      for (const entry of entries) {
        client.put(entry.json, entry.bytes)
        if (entry.n !== null && entry.n > client.given) client.setGiven(entry.n)
      }
      return "given"
    }))
  }

  // The listener's start (Load, step 3): with the chat's `seq` from the
  // store, it sets `last` to the lower of `seq` and the lowest `given` of the
  // clients that joined, or, with no client that joined, to `seq`, and gives
  // it. It may set `last` lower than it was. A client's `given` begins at
  // its `after`, which comes from outside the host with no upper bound, so
  // it never raises `last` above `seq` (lead, ec-mhmpr, C): a client whose
  // `given` is above `seq` stays a client and stays joined, gets no event at
  // or below its `given` (the give skips it), and gets the events above it
  // as the others do. A client that has not joined does not count: it reads
  // on by itself, and the join's check covers it. One step, so no join falls
  // between the choice and the set.
  listen(seq: number): Effect.Effect<number> {
    return this.step(Effect.sync(() => {
      const lowest = this.lowestJoined()
      this.latest = lowest === null ? seq : Math.min(lowest, seq)
      return this.latest
    }))
  }

  // The lowest `given` of the clients that joined, or `null` with none: the
  // unload's read starts there (Unload, step 2).
  get lowestGiven(): Effect.Effect<number | null> {
    return this.step(Effect.sync(() => this.lowestJoined()))
  }

  // An event that cannot be given, by its number `n` (section 8, S2): each
  // client that joined and whose `given` is below `n` ends with `internal`,
  // and `last` is set to `n` when that is higher. Every other client that
  // joined needs nothing up to `n`, so a read goes on after it.
  cannotGive(n: number): Effect.Effect<void> {
    return this.step(Effect.sync(() => {
      for (const client of this.members) {
        if (client.joined && client.given < n) this.end(client, "internal")
      }
      if (this.latest === null || n > this.latest) this.latest = n
    }))
  }

  private lowestJoined(): number | null {
    let lowest: number | null = null
    for (const client of this.members) {
      if (client.joined && (lowest === null || client.given < lowest)) lowest = client.given
    }
    return lowest
  }

  // The join's check (above): `true` when the client joined.
  join(client: Client): Effect.Effect<boolean> {
    return this.step(Effect.sync(() => {
      if (client.ended !== null || !this.members.has(client)) return false
      if (client.joined) return true
      const caught = this.latest === null || client.given >= this.latest
      if (!caught || !client.hasRoom(1, this.limits.entry)) return false
      client.setJoined()
      return true
    }))
  }
}

export interface Registry<L = unknown> {
  // Finds the channel of the chat, or makes it, and adds a holder.
  readonly hold: (tenant: string, uuid: string) => Effect.Effect<Channel<L>>
  // Removes a holder; with none left, takes the channel out.
  readonly letGo: (channel: Channel<L>) => Effect.Effect<void>
  // Holds the chat's channel until the scope closes.
  readonly held: (tenant: string, uuid: string) => Effect.Effect<Channel<L>, never, Scope.Scope>
  // The channel of the chat, if the registry has it; it adds no holder.
  readonly find: (tenant: string, uuid: string) => Channel<L> | undefined
  // The count of channels, and of the clients of the host.
  readonly size: () => { readonly channels: number; readonly clients: number }
  // From now on, every channel of the registry, one that it has and one
  // that it makes later, refuses each new client with `ClientRefused`
  // (`busy`, bound `host`). One step that nothing splits; it ends no client
  // and changes no count, and a second `stop` does nothing (lead, ec-yculc,
  // ruling 1). The host's end runs it first.
  readonly stop: Effect.Effect<void>
}

// A new registry with the limits `limits`.
export const makeRegistry = <L = unknown>(limits: ChannelLimits): Registry<L> => {
  const tenants = new Map<string, Map<string, Channel<L>>>()
  const host: HostCount = { clients: 0, stopped: false }
  const lock = Semaphore.makeUnsafe(1)
  const step = <A>(body: () => A) => Semaphore.withPermit(lock, Effect.uninterruptible(Effect.sync(body)))
  const find = (tenant: string, uuid: string) => tenants.get(tenant)?.get(uuid)
  const hold = (tenant: string, uuid: string) =>
    step(() => {
      let chats = tenants.get(tenant)
      if (chats === undefined) {
        chats = new Map()
        tenants.set(tenant, chats)
      }
      let channel = chats.get(uuid)
      if (channel === undefined) {
        channel = new Channel<L>(tenant, uuid, limits, host)
        chats.set(uuid, channel)
      }
      channel.addHolder()
      return channel
    })
  const letGo = (channel: Channel<L>) =>
    step(() => {
      if (channel.removeHolder() > 0) return
      const chats = tenants.get(channel.tenant)
      if (chats?.get(channel.uuid) !== channel) return
      chats.delete(channel.uuid)
      if (chats.size === 0) tenants.delete(channel.tenant)
    })
  return {
    hold,
    letGo,
    held: (tenant, uuid) => Effect.acquireRelease(hold(tenant, uuid), letGo),
    find,
    stop: step(() => {
      host.stopped = true
    }),
    size: () => {
      let channels = 0
      for (const chats of tenants.values()) channels += chats.size
      return { channels, clients: host.clients }
    }
  }
}
