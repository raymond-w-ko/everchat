// Tests of the client (client.ts). With no server: the layer over a
// socket's path that no file has fails its build with the driver's
// `SqlError`, and the password given to it is in no text of that error; a
// socket's path that is not absolute fails it before the driver chooses a
// transport, and an absolute one reaches the driver as a socket. On
// each server that `EVERCHAT_MARIADB` names (`just test-mariadb` gives 10.11
// and 11.8; the helper `../tests/server.ts` starts each one under the case's
// temporary directory, and the case stops it): the server's root with no
// schema, a schema given, and a user with a password, right and wrong. With
// the variable not there (the unit tier, the scoped check), the cases on a
// server skip, and their name says so; set with no path in it, one case
// fails.

import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Redacted, Result } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import * as fs from "node:fs"
import net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { type Server, serverPaths, start, VARIABLE, WAIT_MAX } from "../tests/server.ts"
import { client, type Options } from "./client.ts"

// A socket's path in a new directory, which no file has.
const nowhere = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "everchat-mariadb-")), "mysqld.sock")

// The build of the layer, in a scope that closes after it: its failure as a
// value. A defect is no failure: it rejects the promise, and the case fails.
const build = (options: Options) => Effect.runPromise(Effect.result(Effect.scoped(Layer.build(client(options)))))

test("the layer over a socket's path that no file has fails its build with the driver's SqlError, not a defect", async () => {
  const socket = nowhere()
  for (const options of [{ socket, user: "everchat" }, { socket, user: "everchat", password: Redacted.make("a password"), schema: "acme_dev" }]) {
    const built = await build(options)
    expect(Result.isFailure(built)).toBe(true)
    const error = Result.isFailure(built) ? built.failure : undefined
    expect(SqlError.isSqlError(error)).toBe(true)
    expect(error?.reason.operation).toBe("connect")
    expect(error?.message).toBe("MysqlClient: Failed to connect")
  }
  expect(fs.existsSync(socket)).toBe(false)
})

test("a password given to client is in no text that the error gives", async () => {
  const password = "pw-" + crypto.randomUUID()
  const built = await build({ socket: nowhere(), user: "everchat", password: Redacted.make(password), schema: "acme_qa" })
  expect(Result.isFailure(built)).toBe(true)
  const error = Result.isFailure(built) ? built.failure : undefined
  const cause = error?.reason.cause
  const texts = [
    String(error),
    JSON.stringify(error),
    error?.message,
    error?.stack,
    String(error?.reason),
    error?.reason.message,
    cause instanceof Error ? cause.message : String(cause),
    cause instanceof Error ? cause.stack : undefined,
    JSON.stringify(cause)
  ]
  // The error gives these texts: the check below reads something.
  expect(texts.filter((one) => typeof one === "string" && one.length > 0).length).toBe(texts.length)
  for (const text of texts) expect(text).not.toContain(password)
})

// Runs `body` with `node:net`'s ways to connect replaced by a recorder that
// throws before any network operation, and puts the real ones back after
// it: the arguments of each call that the driver made. The case's own: the
// other cases run with the real module.
const recorded = async (body: () => Promise<unknown>) => {
  const real = { connect: net.connect, createConnection: net.createConnection }
  const calls: Array<ReadonlyArray<unknown>> = []
  const recorder = ((...args: Array<unknown>) => {
    calls.push(args)
    throw new Error("the case's recorder: no network")
  }) as typeof net.connect
  net.connect = recorder
  net.createConnection = recorder
  try {
    await body()
  } finally {
    net.connect = real.connect
    net.createConnection = real.createConnection
  }
  return calls
}

test("a socket's path that is not absolute (empty, spaces, relative) fails the build with SqlError before the driver chooses a transport: no call to connect", async () => {
  const password = "pw-" + crypto.randomUUID()
  for (const socket of ["", " ", "s.sock"]) {
    // The exit, a defect too: a driver that reached the recorder dies of its
    // throw, and the case fails on the calls, not on that throw.
    let built: Exit.Exit<unknown, SqlError.SqlError> | undefined
    const calls = await recorded(async () => {
      built = await Effect.runPromise(Effect.exit(Effect.scoped(Layer.build(client({ socket, user: "acme_reader", password: Redacted.make(password), schema: "acme_dev" })))))
    })
    expect({ socket, calls }).toEqual({ socket, calls: [] })
    expect(built !== undefined && Exit.isFailure(built) && !Cause.hasDies(built.cause)).toBe(true)
    const found = built !== undefined && Exit.isFailure(built) ? Cause.findError(built.cause) : undefined
    const error = found !== undefined && Result.isSuccess(found) ? found.success : undefined
    expect(SqlError.isSqlError(error)).toBe(true)
    expect(error?.reason._tag).toBe("UnknownError")
    expect(error?.reason.operation).toBe("connect")
    expect(error?.message).toContain("the socket's path is not an absolute path")
    for (const text of [String(error), JSON.stringify(error), error?.stack, String(error?.reason.cause)]) {
      expect(text).not.toContain(password)
    }
  }
})

test("a socket's absolute path that no file has reaches the driver as a socket: one call to connect, of that path, with no port and no host", async () => {
  const socket = nowhere()
  const calls = await recorded(() =>
    Effect.runPromise(Effect.exit(Effect.scoped(Layer.build(client({ socket, user: "acme_reader", password: Redacted.make("a password") })))))
  )
  expect(calls).toEqual([[socket]])
})

// The cases on a server, in the form of the helper's own test
// (`../tests/server.test.ts`): the variable not there (they skip), there
// with no path in it (a case fails: nothing skips in silence), or the paths
// that it names (they run).
const GIVEN = process.env[VARIABLE]
const PATHS = serverPaths(process.env)

// The hang limit of a case that starts a server: a start makes a data
// directory. No measure of speed.
const SLOW = 4 * WAIT_MAX

// The version that a server's Nix output path names: `...-mariadb-server-10.11.18`.
const versionOf = (server: string) => /-mariadb-server-([0-9.]+)$/.exec(server)?.[1] ?? "(no version in the path)"

// A server of `server`, started under a new directory of the case's
// temporary root, for `body`; stopped in a `finally`.
const onServer = async (server: string, body: (one: Server) => Promise<void>) => {
  const one = await start(server, fs.mkdtempSync(path.join(os.tmpdir(), "db-")))
  try {
    await body(one)
  } finally {
    await one.stop()
  }
}

// The rows of `sql` through the client of `options`, whose layer is built
// for this run and closed after it.
const rows = (options: Options, sql: string) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const db = yield* SqlClient.SqlClient
      return yield* db.unsafe<Record<string, unknown>>(sql)
    }).pipe(Effect.provide(client(options)))
  )

if (GIVEN === undefined) {
  const why = `the cases on a server: skipped, ${VARIABLE} is not set (just test-mariadb sets it)`
  // `bun test` prints no skipped case's name: the output says it too.
  console.log("packages/mariadb/src/client.test.ts: " + why)
  test.skip(why, () => {})
} else if (PATHS.length === 0) {
  test(`the cases on a server: ${VARIABLE} is set and names no server`, () => {
    throw new Error(`${VARIABLE} is set and names no server (${JSON.stringify(GIVEN)}): give the servers' paths, separated by spaces, or leave it unset to skip the cases on a server`)
  })
}

for (const server of PATHS) {
  describe(`the client on MariaDB ${versionOf(server)} (${server})`, () => {
    test("the server's root over the socket, with no schema: select version() through the client is the helper's version", async () => {
      await onServer(server, async (one) => {
        expect(one.version.startsWith(versionOf(server) + "-")).toBe(true)
        expect(await rows({ socket: one.socket, user: "root" }, "select version() as version, database() as current")).toEqual([
          { version: one.version, current: null }
        ])
      })
    }, SLOW)

    test("with a schema given, select database() gives its name", async () => {
      await onServer(server, async (one) => {
        await one.query("create database acme_dev")
        expect(await rows({ socket: one.socket, user: "root", schema: "acme_dev" }, "select database() as current")).toEqual([{ current: "acme_dev" }])
      })
    }, SLOW)

    test("a user with a password (mysql_native_password) connects with it and reads a row; with a wrong one the layer fails with the driver's SqlError, and neither password is in a text of the error", async () => {
      await onServer(server, async (one) => {
        const right = "pw-" + crypto.randomUUID()
        const wrong = "pw-" + crypto.randomUUID()
        await one.query(
          [
            "create database acme_qa",
            "create table acme_qa.notes (id int primary key, body varchar(40))",
            "insert into acme_qa.notes values (1, 'a row')",
            `create user 'acme_reader'@'localhost' identified via mysql_native_password using password('${right}')`,
            "grant select on acme_qa.* to 'acme_reader'@'localhost'"
          ].join("; ")
        )
        expect((await one.query("select plugin from mysql.user where user = 'acme_reader'")).trim()).toBe("mysql_native_password")
        const given = { socket: one.socket, user: "acme_reader", schema: "acme_qa" }
        expect(await rows({ ...given, password: Redacted.make(right) }, "select id, body from notes")).toEqual([{ id: 1, body: "a row" }])
        const built = await Effect.runPromise(Effect.result(Effect.scoped(Layer.build(client({ ...given, password: Redacted.make(wrong) })))))
        expect(Result.isFailure(built)).toBe(true)
        const error = Result.isFailure(built) ? built.failure : undefined
        expect(SqlError.isSqlError(error)).toBe(true)
        expect(error?.reason.operation).toBe("connect")
        const cause = error?.reason.cause
        const texts = [
          String(error),
          JSON.stringify(error),
          error?.message,
          error?.stack,
          String(error?.reason),
          error?.reason.message,
          cause instanceof Error ? cause.message : String(cause),
          cause instanceof Error ? cause.stack : undefined,
          JSON.stringify(cause)
        ]
        // The error gives these texts, and the server's refusal is among
        // them: the check below reads something.
        expect(texts.filter((text) => typeof text === "string" && text.length > 0).length).toBe(texts.length)
        expect(texts.some((text) => text?.includes("Access denied for user 'acme_reader'"))).toBe(true)
        for (const text of texts) {
          expect(text).not.toContain(right)
          expect(text).not.toContain(wrong)
        }
      })
    }, SLOW)
  })
}
