// A private MariaDB for the checks
// ================================
// The full check runs the tests of the store on MariaDB, on each version
// that a hosted deployment may run (`just test-mariadb`). The `justfile`
// pins the servers' Nix output paths and gives them in `EVERCHAT_MARIADB`,
// separated by spaces; with none, the tests that need a server skip (the
// unit tier, the scoped check).
//
// For one server path, `start` makes a new data directory under the
// directory that the caller gives (a test's temporary directory), and
// starts `mariadbd` there:
//
// - on a socket file inside that directory, with no TCP port
//   (`--skip-networking`); a socket's path is at most 107 bytes (the 108
//   of `sun_path`, with its NUL), so a longer one is refused before
//   anything is made;
// - with no option file of the machine (`--no-defaults`), so no
//   `my.cnf` changes it;
// - with its temporary files in `tmp` inside that directory
//   (`--tmpdir`), so each place that it writes is inside it;
// - as `setpriv --pdeathsig KILL -- sh -c CHECK sh <caller> mariadbd ...`
//   (`guarded`):
//   the kernel kills the server when the process that started it dies,
//   also by SIGKILL, so no server outlives its test. `setpriv` asks for
//   that signal only when it runs: a caller that died before has sent
//   none. So the line then looks at its parent (`CHECK`), and ends with no
//   `mariadbd` when it is no longer the caller. Each step runs the next in
//   its own place, so the server's pid is the child's. util-linux, so
//   Linux only.
//
// The data directory is made first by `mariadb-install-db`, a shell script
// that runs a bootstrap `mariadbd` and the shells of a pipeline: processes
// that a parent-death signal does not reach (Linux does not pass it to a
// fork). So the installer runs as the leader of a process group (and a
// session) of its own (`setsid`), under a watcher (`WATCH`) that holds the
// read end of a pipe whose write end only the caller holds. At the pipe's
// end, when the caller closes it after the installer's end, or when the
// caller dies, by SIGKILL too, the watcher kills the leader and then the
// whole group, whatever made each process in it; then the caller waits
// until the group is gone
// (at most `WAIT_MAX`). The installer takes `--tmpdir` too, and passes it
// on to its bootstrap server (it passes each option that it does not know),
// with `TMPDIR` in its environment.
//
// It gives the socket's path, the version, `query`, which runs SQL as the
// server's root with the server's own client (`<path>/bin/mariadb`), and
// `stop`: SIGTERM, then a wait until the process is gone; a second stop is
// no error. The root has no password and reaches only the socket. Each run
// of the client, the answers that `start` waits for and each `query`, has
// the server's line (`guarded`): no client outlives its caller either.
//
// The processes that the helper starts, and no other (lead, ec-58rjh9,
// B16): the watcher, with the installer under it (`install`); the server's
// line, and the client's line (`guarded`, each). A new one takes one of
// these two shapes.

import fs from "node:fs"
import path from "node:path"

// The variable that gives the servers' paths.
export const VARIABLE = "EVERCHAT_MARIADB"

// The longest socket path, in bytes.
export const SOCKET_MAX = 107

// The most time that a start waits for the first answer of the server, and
// that a stop waits for its end, in ms: a bound against a hang, no
// measure of speed.
export const WAIT_MAX = 120_000

// The servers' paths that `env` gives: none when the variable is not set,
// or holds only spaces.
export const serverPaths = (env: Record<string, string | undefined> = process.env): ReadonlyArray<string> =>
  (env[VARIABLE] ?? "").split(/\s+/).filter((one) => one !== "")

// The name of the directory that `start` makes for a server under `under`
// is this, with six characters after it (`fs.mkdtempSync`).
const PREFIX = "mariadb-"
const SOCKET = "s.sock"

// The socket's path that `start` would give under `under`, with the six
// characters as `X`.
export const socketOf = (under: string): string => path.join(path.resolve(under), PREFIX + "XXXXXX", SOCKET)

export interface Server {
  // The server's Nix output path, as given.
  readonly path: string
  // The directory that holds its data, its socket and its logs.
  readonly dir: string
  readonly socket: string
  readonly pid: number
  // What `select version()` gives, such as `10.11.18-MariaDB`.
  readonly version: string
  // Runs `sql` as root, and gives what the client prints: tab-separated
  // rows with no column names. It fails with the client's error.
  readonly query: (sql: string) => Promise<string>
  // SIGTERM, then the wait until the process is gone. Again: nothing.
  readonly stop: () => Promise<void>
}

// Whether the process `pid` runs: a pid that is gone, or a zombie, does not.
export const alive = (pid: number): boolean => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    // The state comes after the name, which ends at the last ")".
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z"
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Runs the client's line (`guarded`) to its end: its exit code and what it
// printed.
const run = async (command: ReadonlyArray<string>) => {
  const child = Bun.spawn(guarded(command), { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { out, err, code }
}

const tail = (file: string) => {
  try {
    return fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-10).join("\n")
  } catch {
    return "(no log)"
  }
}

// The installer's watcher, run as `sh -c WATCH sh <out> <err> <command...>`
// with the caller's pipe as its input. It ignores the signals of a
// terminal and SIGPIPE (a write to a caller that is gone fails, and the
// script goes on to its last `wait`), starts the command in a session of
// its own (`setsid` runs in the background job's own place, so its pid
// leads the group once it has run), with its output in the files `out` and
// `err`. A subshell, made before the first write to the caller, waits for
// the end of the caller's pipe, then kills the leader by its pid, then its
// group. The order holds at each step of the job (lead, ec-saumkk, B9): a
// job that has not made its group yet has no child, and the kill of its pid
// ends it all (the group's kill finds none); one that has made it is dead
// before the group's kill, so what it forked is in that group, and it forks
// no more. The other order leaves a child forked between the two. Then the
// watcher prints that pid, waits for the command (it returns when the
// command ended or was killed), prints its exit code, and waits for the
// subshell.
const WATCH = [
  "trap '' HUP INT TERM PIPE",
  "exec 3<&0 0</dev/null",
  "out=$1 err=$2",
  "shift 2",
  'setsid "$@" 3<&- >"$out" 2>"$err" &',
  "leader=$!",
  '(read -r _ <&3; kill -s KILL "$leader" 2>/dev/null; kill -s KILL -- "-$leader" 2>/dev/null) &',
  "exec 3<&-",
  'echo "$leader"',
  'wait "$leader"',
  'echo "$?"',
  "wait"
].join("\n")

// The line after `setpriv` asked for its signal, run as
// `sh -c CHECK sh <caller> <command...>`: it runs the command in its own
// place when its parent is still the caller, and ends with code 1, with
// none started, when it is not (lead, ec-saumkk, B11). `sh` reads its
// parent at its start, after the request; a caller that dies after it is
// the kernel's signal.
const CHECK = '[ "$PPID" = "$1" ] || exit 1; shift; exec "$@"'

// The line of the server and of the client (B11, B15): the request for
// SIGKILL at the caller's death, then the look at the parent, then
// `command`, each in the place of the one before, so the child's pid is
// the command's.
const guarded = (command: ReadonlyArray<string>): Array<string> => [
  "setpriv", "--pdeathsig", "KILL", "--",
  "sh", "-c", CHECK, "sh", String(process.pid),
  ...command
]

// Whether the process group `group` has no process left.
const groupGone = (group: number): boolean => {
  try {
    process.kill(-group, 0)
    return false
  } catch {
    return true
  }
}

// Runs `command` under the watcher: its exit code (null when the watcher
// gave none), and what it printed. The group is gone, or `WAIT_MAX` passed,
// when it returns.
const install = async (command: ReadonlyArray<string>, dir: string, tmp: string) => {
  const out = path.join(dir, "install.out")
  const err = path.join(dir, "install.err")
  const watcher = Bun.spawn(["sh", "-c", WATCH, "sh", out, err, ...command], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, TMPDIR: tmp }
  })
  // Two lines: the group's leader, then the exit code.
  const reader = watcher.stdout.getReader()
  const decoder = new TextDecoder()
  let text = ""
  while (text.split("\n").length < 3) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  const [leader, code] = text.split("\n").map((line) => (/^[0-9]+$/.test(line) ? Number(line) : null))
  // The end of the caller's pipe: the watcher kills the group.
  await watcher.stdin.end()
  await watcher.exited
  if (leader !== null && leader !== undefined) {
    for (const until = Date.now() + WAIT_MAX; !groupGone(leader) && Date.now() < until;) await sleep(20)
  }
  const read = (file: string) => {
    try {
      return fs.readFileSync(file, "utf8")
    } catch {
      return ""
    }
  }
  return { code: code ?? null, out: read(out), err: read(err) }
}

// Starts a server of `server` (a Nix output path of MariaDB's server) in a
// new directory under `under`. It fails, and starts nothing, for a socket's
// path over SOCKET_MAX bytes, and for a path that holds no `mariadbd`.
export const start = async (server: string, under: string): Promise<Server> => {
  const planned = socketOf(under)
  if (Buffer.byteLength(planned) > SOCKET_MAX) {
    throw new Error(`The socket's path ${planned} is ${Buffer.byteLength(planned)} bytes, over the ${SOCKET_MAX} that a socket's path may have: give a shorter directory than ${under}.`)
  }
  const bin = (name: string) => path.join(server, "bin", name)
  for (const name of ["mariadbd", "mariadb-install-db", "mariadb"]) {
    if (!fs.existsSync(bin(name))) {
      throw new Error(`${server} is not a MariaDB server: it has no bin/${name}.`)
    }
  }
  const dir = fs.mkdtempSync(path.join(path.resolve(under), PREFIX))
  const data = path.join(dir, "data")
  const socket = path.join(dir, SOCKET)
  const tmp = path.join(dir, "tmp")
  fs.mkdirSync(tmp)
  const installed = await install([
    "setpriv", "--pdeathsig", "KILL", "--",
    bin("mariadb-install-db"), "--no-defaults", `--basedir=${server}`, `--datadir=${data}`,
    "--auth-root-authentication-method=normal", "--skip-test-db", `--tmpdir=${tmp}`
  ], dir, tmp)
  if (installed.code !== 0) {
    throw new Error(`mariadb-install-db of ${server} failed with code ${installed.code}:\n${(installed.err || installed.out).trimEnd()}`)
  }
  const log = path.join(dir, "error.log")
  const child = Bun.spawn(guarded([
    bin("mariadbd"), "--no-defaults", `--basedir=${server}`, `--datadir=${data}`, `--socket=${socket}`,
    "--skip-networking", `--pid-file=${path.join(dir, "mariadbd.pid")}`, `--log-error=${log}`, `--tmpdir=${tmp}`
  ]), { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  const client = (sql: string) => run([bin("mariadb"), "--no-defaults", "--user=root", `--socket=${socket}`, "--batch", "--skip-column-names", `--execute=${sql}`])
  let stopped: Promise<void> | null = null
  const stop = () => {
    stopped ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM")
      }
      const ended = await Promise.race([child.exited.then(() => true), sleep(WAIT_MAX).then(() => false)])
      if (!ended) {
        child.kill("SIGKILL")
        await child.exited
        throw new Error(`The server ${child.pid} of ${server} did not end in ${WAIT_MAX} ms after SIGTERM: it was killed.`)
      }
    })()
    return stopped
  }
  // The first answer, while the server runs.
  const since = Date.now()
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`The server of ${server} ended at its start (${child.exitCode ?? child.signalCode}):\n${tail(log)}`)
    }
    const first = await client("select version()")
    if (first.code === 0) {
      const query = async (sql: string) => {
        const done = await client(sql)
        if (done.code !== 0) {
          throw new Error(`The statement failed on ${server}: ${done.err.trimEnd()}`)
        }
        return done.out
      }
      return { path: server, dir, socket, pid: child.pid, version: first.out.trim(), query, stop }
    }
    if (Date.now() - since > WAIT_MAX) {
      await stop().catch(() => undefined)
      throw new Error(`The server of ${server} gave no answer in ${WAIT_MAX} ms:\n${first.err.trimEnd()}\n${tail(log)}`)
    }
    await sleep(50)
  }
}
