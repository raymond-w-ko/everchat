// The client
// ==========
// The driver's client of a MariaDB server over its socket file: the layer
// of `@effect/sql-mysql2`'s `MysqlClient`, and so of `effect`'s generic
// `SqlClient`, a pool of connections. `client(options)` names the socket
// file, the user, the password (a `Redacted` text, or none for a user with
// no password) and the schema (or none: the caller then names a table with
// its schema). No option has a default: no user, schema or path is in the
// code; they come from the caller.
//
// The layer's build runs the driver's `select 1` once: a server that does
// not answer fails the build with the driver's `SqlError` (its reason a
// `ConnectionError`, or an `AuthenticationError` for a wrong password), not
// a defect, and the pool is closed with the layer's scope. The password
// goes to the driver only, as its `Redacted` value: it is in no error's
// text.
//
// What it is not: no host and port, since a connection over TCP needs TLS,
// which comes with the config (lead, ec-dwjz, the plan's bead 16), and so a
// socket's path that is not absolute is refused before the driver sees it
// (the driver takes an empty one as TCP: lead, ec-sv4aet, J1); no setting
// of the session (the store's: R13), and no SQL of its own: the store
// (`@everchat/sqlite/sql`, with MariaDB's dialect) is a later bead's.

import { MysqlClient } from "@effect/sql-mysql2"
import { Context, Effect, Layer, type Redacted } from "effect"
import * as Reactivity from "effect/reactivity/Reactivity"
import { SqlClient, SqlError } from "effect/sql"

export interface Options {
  // The path of the server's socket file: an absolute path, or the build
  // fails before the driver is called (an empty one would be TCP to it).
  readonly socket: string
  // The user's name.
  readonly user: string
  // The user's password; none for a user with no password.
  readonly password?: Redacted.Redacted | undefined
  // The schema that the connections use; none when the caller names none.
  readonly schema?: string | undefined
}

// The refusal of a socket's path that does not start with "/" (the empty
// text, spaces, a relative path), before the driver is called: mysql2 takes
// a socket only for a path that is not empty, and goes to TCP on port 3306
// of `localhost`, with no TLS, for an empty one (lead, ec-sv4aet, J1). The
// failure has the form of the driver's for a socket that is not there: an
// `UnknownError` of the operation "connect". Its text names no option's
// value.
const absolute = (socket: string): Effect.Effect<void, SqlError.SqlError> =>
  socket.startsWith("/") ? Effect.void : Effect.fail(
    new SqlError.SqlError({
      reason: new SqlError.UnknownError({
        cause: new Error("The socket's path is not an absolute path."),
        message: "MysqlClient: the socket's path is not an absolute path: the client connects only over a socket file",
        operation: "connect"
      })
    })
  )

// The layer of the driver's client over the socket file: `MysqlClient` and
// `SqlClient`, one pool. Its build fails with the driver's `SqlError` when
// the socket's path is not absolute, or the server does not answer
// `select 1`.
export const client = (options: Options): Layer.Layer<MysqlClient.MysqlClient | SqlClient.SqlClient, SqlError.SqlError> =>
  Layer.effectContext(
    Effect.andThen(
      absolute(options.socket),
      Effect.map(
        MysqlClient.make({
          username: options.user,
          password: options.password,
          database: options.schema,
          poolConfig: { socketPath: options.socket }
        }),
        (made) => Context.make(MysqlClient.MysqlClient, made).pipe(Context.add(SqlClient.SqlClient, made))
      )
    )
  ).pipe(Layer.provide(Reactivity.layer))
