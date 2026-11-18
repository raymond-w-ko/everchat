// Tests of the private MariaDB of the checks (mariadb.ts): for each server
// path that `EVERCHAT_MARIADB` gives (`just test-mariadb` gives 10.11 and
// 11.8), a start, its version, no network, the socket in the directory
// given, two servers at one time, the stop, and the server's end when the
// process that started it is killed, also while the installer runs, and
// before what would end its processes is ready (the installer's leader
// before its group, its watcher before its first step, the server's line
// and the client's before their signal: stand-ins on the caller's `PATH`
// hold each); the client's end with its caller; the places that the
// server writes; a failed installer. With the variable not
// there (the unit tier, the scoped check), the cases that need a server
// skip, and their name says so; set with no path in it, one case fails.

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { alive, type Server, SOCKET_MAX, serverPaths, socketOf, start, VARIABLE, WAIT_MAX } from "./mariadb.ts"

// What the environment gives for the cases with a server (lead, ec-ndpgjk,
// B7): the variable not there (they skip), there with no path in it, empty
// or only white space (a case fails: nothing skips in silence), or the
// paths that it names (they run).
type Given =
  | { readonly kind: "unset" }
  | { readonly kind: "empty"; readonly value: string }
  | { readonly kind: "paths"; readonly paths: ReadonlyArray<string> }
const givenBy = (env: Record<string, string | undefined>): Given => {
  const value = env[VARIABLE]
  if (value === undefined) return { kind: "unset" }
  const paths = serverPaths(env)
  return paths.length === 0 ? { kind: "empty", value } : { kind: "paths", paths }
}

const GIVEN = givenBy(process.env)
const PATHS = GIVEN.kind === "paths" ? GIVEN.paths : []

// The hang limit of a case that starts servers: each start makes a data
// directory (about 5 s each on a loaded machine). No measure of speed.
const SLOW = 4 * WAIT_MAX

// A new directory for one case's servers, under the run's temporary root.
const place = () => fs.mkdtempSync(path.join(os.tmpdir(), "db-"))

// The version that a server's Nix output path names: `...-mariadb-server-10.11.18`.
const versionOf = (server: string) => /-mariadb-server-([0-9.]+)$/.exec(server)?.[1] ?? "(no version in the path)"

// Waits until the process `pid` is gone, at most `bound` ms; whether it is.
const gone = async (pid: number, bound: number) => {
  for (const until = Date.now() + bound; alive(pid) && Date.now() < until;) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return !alive(pid)
}

// The live processes whose command line or working directory names `dir`.
const namedBy = (dir: string): Array<{ readonly pid: number; readonly command: string }> => {
  const found: Array<{ readonly pid: number; readonly command: string }> = []
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(entry) || Number(entry) === process.pid) continue
    let command = ""
    let cwd = ""
    try {
      command = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").join(" ").trim()
    } catch {
      continue
    }
    try {
      cwd = fs.readlinkSync(`/proc/${entry}/cwd`)
    } catch {
      // Gone, or not ours to read.
    }
    if ((command.includes(dir) || cwd === dir || cwd.startsWith(dir + "/")) && alive(Number(entry))) {
      found.push({ pid: Number(entry), command })
    }
  }
  return found
}

// Waits until no live process names `dir`, at most `bound` ms; those left.
const allGone = async (dir: string, bound: number) => {
  for (const until = Date.now() + bound; namedBy(dir).length > 0 && Date.now() < until;) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return namedBy(dir).map((one) => one.command)
}

// The bootstrap `mariadbd` of an installation under `dir`, once it runs:
// polled every 5 ms, at most `bound` ms; undefined when none came.
const bootstrapUnder = async (dir: string, bound: number) => {
  for (const until = Date.now() + bound; Date.now() < until;) {
    const found = namedBy(dir).find((one) => one.command.includes("--bootstrap") && /\/mariadbd /.test(one.command))
    if (found !== undefined) return found
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return undefined
}

// The state letter of the process `pid` (`T` when stopped), or "" when gone.
const stateOf = (pid: number) => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3)
  } catch {
    return ""
  }
}

// The state of `pid` once a SIGSTOP sent to it has taken hold (a process in
// a wait of the disk takes it later), at most `bound` ms.
const stoppedState = async (pid: number, bound: number) => {
  for (const until = Date.now() + bound; !["T", ""].includes(stateOf(pid)) && Date.now() < until;) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return stateOf(pid)
}

// A child process that runs `starts` (`start` of each server under its
// directory) and then waits; the test kills it. `bin`, when given, comes
// first on its `PATH`.
const caller = (starts: ReadonlyArray<readonly [string, string]>, bin?: string) => {
  const code = [
    `import { start } from ${JSON.stringify(path.join(import.meta.dir, "mariadb.ts"))}`,
    `await Promise.all(${JSON.stringify(starts)}.map(([server, under]) => start(server, under)))`,
    `await new Promise(() => {})`
  ].join("\n")
  const env = bin === undefined ? { ...process.env } : { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }
  return Bun.spawn(["bun", "--eval", code], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env })
}

// The state, the parent and the process group of `pid`; undefined when gone.
const statOf = (pid: number) => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    const [state, ppid, pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    return { state: state!, ppid: Number(ppid), pgrp: Number(pgrp) }
  } catch {
    return undefined
  }
}

// Stand-ins of the programs that the helper finds by `PATH` (lead,
// ec-saumkk, B13), in `<root>/bin`. Each that `holds` names holds the
// process that runs it when its arguments hold the text given ("" for
// each): it writes its pid to `<root>/<name>.pid`, stops itself
// (SIGSTOP), and when it continues runs the real program in its place,
// with the same arguments. The others run the real program at once. The
// directory, to come first on the caller's `PATH`.
const standIns = (root: string, holds: Partial<Record<"sh" | "setsid" | "setpriv", string>>) => {
  const bin = path.join(root, "bin")
  fs.mkdirSync(bin)
  for (const [name, text] of Object.entries(holds)) {
    const real = Bun.which(name)
    if (real === null) throw new Error(`no ${name} on the PATH`)
    fs.writeFileSync(path.join(bin, name), [
      "#!/bin/sh",
      `case " $* " in *'${text!.replaceAll("'", "'\\''")}'*) echo "$$" > '${path.join(root, name + ".pid")}'; kill -s STOP "$$";; esac`,
      `exec '${real}' "$@"`,
      ""
    ].join("\n"), { mode: 0o755 })
  }
  return bin
}

// A stand-in of a server's path whose installer only leaves a mark
// (`<root>/installed`) when it runs: the path and the mark.
const markServer = (root: string) => {
  const server = path.join(root, "server")
  fs.mkdirSync(path.join(server, "bin"), { recursive: true })
  for (const name of ["mariadbd", "mariadb"]) fs.writeFileSync(path.join(server, "bin", name), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
  const mark = path.join(root, "installed")
  fs.writeFileSync(path.join(server, "bin", "mariadb-install-db"), `#!/bin/sh\n: > '${mark}'\n`, { mode: 0o755 })
  return { server, mark }
}

// A stand-in of a server's path that starts (lead, ec-58rjh9, B18): its
// installer ends with 0; its `mariadbd` writes its pid to
// `<root>/mariadbd.pid` and stays until it is killed, naming the case's
// directory; its `mariadb` writes
// its pid to `<root>/mariadb.pid` (the mark that a client ran) and stops
// itself (SIGSTOP), then ends with 1 if it continues. The path.
const heldClientServer = (root: string) => {
  const server = path.join(root, "server")
  fs.mkdirSync(path.join(server, "bin"), { recursive: true })
  const write = (name: string, lines: ReadonlyArray<string>) => fs.writeFileSync(path.join(server, "bin", name), ["#!/bin/sh", ...lines, ""].join("\n"), { mode: 0o755 })
  write("mariadb-install-db", ["exit 0"])
  // `tail -f` of a file of the case: it names the case's directory, and
  // starts no process of its own.
  write("mariadbd", [`echo "$$" > '${path.join(root, "mariadbd.pid")}'`, `exec tail -f '${path.join(root, "mariadbd.pid")}'`])
  write("mariadb", [`echo "$$" > '${path.join(root, "mariadb.pid")}'`, 'kill -s STOP "$$"', "exit 1"])
  return server
}

// The pid that a stand-in wrote to `file`, once it has: polled every 5 ms,
// at most `bound` ms; it throws at the bound.
const pidIn = async (file: string, bound: number) => {
  for (const until = Date.now() + bound; Date.now() < until;) {
    let text = ""
    try {
      text = fs.readFileSync(file, "utf8")
    } catch {
      // Not there yet.
    }
    if (/^[0-9]+\n$/.test(text)) return Number(text.trim())
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`no stand-in wrote its pid to ${file} in ${bound} ms`)
}

// Which of HUP, INT, PIPE and TERM the process `pid` ignores (its
// `SigIgn`); undefined when gone.
const ignores = (pid: number) => {
  try {
    const mask = BigInt("0x" + /^SigIgn:\s+([0-9a-f]+)$/m.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"))![1]!)
    return ([["HUP", 1], ["INT", 2], ["PIPE", 13], ["TERM", 15]] as const).filter(([, n]) => (mask >> BigInt(n - 1)) & 1n).map(([name]) => name)
  } catch {
    return undefined
  }
}

// The pid that a stand-in wrote to `file`, when it wrote one in full.
const pidWritten = (file: string) => {
  try {
    const text = fs.readFileSync(file, "utf8")
    return /^[0-9]+\n$/.test(text) ? Number(text.trim()) : undefined
  } catch {
    return undefined
  }
}

// Sends SIGKILL to each of `pids` that still names `dir` (a pid that the
// system gave again to another process is left alone), and to each other
// live process that names it: the end of a case that holds processes
// stopped.
const killAll = (pids: ReadonlyArray<number>, dir: string) => {
  const named = namedBy(dir).map((one) => one.pid)
  for (const pid of new Set([...pids.filter((one) => named.includes(one)), ...named])) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // Gone.
    }
  }
}

// Holds (SIGSTOP) the bootstrap of each directory of `unders` while the
// child that called `start` for them is killed (SIGKILL), and gives what
// was held and what of each directory is left after a bounded wait. Each
// process left is killed at the end.
const killedWhileInstalling = async (starts: ReadonlyArray<readonly [string, string]>) => {
  const child = caller(starts)
  const held: Array<{ readonly pid: number; readonly state: string } | null> = []
  try {
    for (const [, under] of starts) {
      const boot = await bootstrapUnder(under, WAIT_MAX)
      if (boot === undefined) {
        held.push(null)
        continue
      }
      try {
        process.kill(boot.pid, "SIGSTOP")
      } catch {
        // Gone at once: its state says so.
      }
      held.push({ pid: boot.pid, state: await stoppedState(boot.pid, 5_000) })
    }
    child.kill("SIGKILL")
    await child.exited
    const left = []
    for (const [, under] of starts) left.push(await allGone(under, 30_000))
    return { held, left }
  } finally {
    child.kill("SIGKILL")
    for (const [, under] of starts) {
      for (const one of namedBy(under)) {
        try {
          process.kill(one.pid, "SIGKILL")
        } catch {
          // Gone.
        }
      }
    }
  }
}

// Runs `body` with the servers that `starts` gives, and stops each at its end.
const using = async (starts: ReadonlyArray<() => Promise<Server>>, body: (servers: ReadonlyArray<Server>) => Promise<void>) => {
  const servers: Array<Server> = []
  try {
    for (const one of starts) servers.push(await one())
    await body(servers)
  } finally {
    await Promise.all(servers.map((one) => one.stop()))
  }
}

test("serverPaths reads the paths of EVERCHAT_MARIADB, separated by spaces; none when it is not set or holds only spaces", () => {
  expect(VARIABLE).toBe("EVERCHAT_MARIADB")
  expect(serverPaths({})).toEqual([])
  expect(serverPaths({ EVERCHAT_MARIADB: "" })).toEqual([])
  expect(serverPaths({ EVERCHAT_MARIADB: "  \t " })).toEqual([])
  expect(serverPaths({ EVERCHAT_MARIADB: "/nix/store/a-mariadb-server-10.11.18 /nix/store/b-mariadb-server-11.8.9" })).toEqual([
    "/nix/store/a-mariadb-server-10.11.18",
    "/nix/store/b-mariadb-server-11.8.9"
  ])
  expect(serverPaths({ EVERCHAT_MARIADB: " /x  /y " })).toEqual(["/x", "/y"])
})

test("the cases with a server: skipped when EVERCHAT_MARIADB is not there; a failing case when it is set and names no server (empty, or only white space); run on each path that it names", () => {
  expect(givenBy({})).toEqual({ kind: "unset" })
  expect(givenBy({ OTHER: "/x" })).toEqual({ kind: "unset" })
  expect(givenBy({ EVERCHAT_MARIADB: undefined })).toEqual({ kind: "unset" })
  expect(givenBy({ EVERCHAT_MARIADB: "" })).toEqual({ kind: "empty", value: "" })
  expect(givenBy({ EVERCHAT_MARIADB: "  \t " })).toEqual({ kind: "empty", value: "  \t " })
  expect(givenBy({ EVERCHAT_MARIADB: " /x  /y " })).toEqual({ kind: "paths", paths: ["/x", "/y"] })
})

test("an installer that fails after it started a process: start throws the installer's code and text, and that process is gone when it has thrown", async () => {
  // A stand-in of a server's path: its installer leaves a process behind
  // in the background, writes its pid, and fails.
  const standIn = fs.mkdtempSync(path.join(os.tmpdir(), "stand-in-"))
  fs.mkdirSync(path.join(standIn, "bin"))
  for (const name of ["mariadbd", "mariadb"]) fs.writeFileSync(path.join(standIn, "bin", name), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
  const left = path.join(standIn, "left.pid")
  fs.writeFileSync(path.join(standIn, "bin", "mariadb-install-db"), [
    "#!/bin/sh",
    // Its own output: the process holds none of the installer's.
    "sleep 1000 >/dev/null 2>&1 </dev/null &",
    `echo "$!" > ${JSON.stringify(left)}`,
    "echo \"the stand-in's installer failed\" >&2",
    "exit 3",
    ""
  ].join("\n"), { mode: 0o755 })
  let pid = 0
  try {
    await expect(start(standIn, place())).rejects.toThrow(`mariadb-install-db of ${standIn} failed with code 3:\nthe stand-in's installer failed`)
    pid = Number(fs.readFileSync(left, "utf8").trim())
    expect(pid).toBeGreaterThan(0)
    expect(alive(pid)).toBe(false)
  } finally {
    if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL")
  }
})

test("a child process killed with SIGKILL while its installer's leader is held before it has made its group: the leader and the watcher, which ignores HUP, INT, PIPE and TERM, are gone, and the installer never ran", async () => {
  // Window 1 (lead, ec-saumkk, B9): no server runs; the stand-in path's
  // installer leaves a mark when it runs.
  const root = place()
  const bin = standIns(root, { setsid: "" })
  const { server, mark } = markServer(root)
  const child = caller([[server, root]], bin)
  const pids: Array<number> = []
  try {
    const leader = await pidIn(path.join(root, "setsid.pid"), WAIT_MAX)
    pids.push(leader)
    const held = { state: await stoppedState(leader, 5_000), leads: statOf(leader)?.pgrp === leader }
    const watcher = statOf(leader)?.ppid ?? 0
    pids.push(watcher)
    // The watcher ran its first line before it forked the leader: it
    // ignores the signals of a terminal and SIGPIPE (B10), so its writes to
    // a dead caller do not end it.
    const ignored = ignores(watcher)
    child.kill("SIGKILL")
    await child.exited
    const ended = { leader: await gone(leader, 30_000), watcher: await gone(watcher, 30_000) }
    const left = await allGone(root, 30_000)
    // Held stopped, and not yet the leader of a group, before the kill.
    expect(held).toEqual({ state: "T", leads: false })
    expect(watcher).toBeGreaterThan(1)
    expect(ignored).toEqual(["HUP", "INT", "PIPE", "TERM"])
    expect({ ended, left, installed: fs.existsSync(mark) }).toEqual({ ended: { leader: true, watcher: true }, left: [], installed: false })
  } finally {
    child.kill("SIGKILL")
    killAll(pids, root)
  }
}, SLOW)

test("a child process killed with SIGKILL while its installer's watcher is held before its first step: at the end of the caller's pipe nothing of the start is left", async () => {
  // Window 2 (lead, ec-saumkk, B10): no server runs; the stand-in path's
  // installer leaves a mark when it runs. The leader is held too, when it
  // comes that far.
  const root = place()
  const bin = standIns(root, { sh: "setsid", setsid: "" })
  const { server, mark } = markServer(root)
  const child = caller([[server, root]], bin)
  const pids: Array<number> = []
  try {
    const watcher = await pidIn(path.join(root, "sh.pid"), WAIT_MAX)
    pids.push(watcher)
    const held = await stoppedState(watcher, 5_000)
    child.kill("SIGKILL")
    await child.exited
    process.kill(watcher, "SIGCONT")
    const ended = await gone(watcher, 30_000)
    const left = await allGone(root, 30_000)
    // The leader's stand-in, where it wrote its pid before the kill.
    const leader = pidWritten(path.join(root, "setsid.pid"))
    if (leader !== undefined) pids.push(leader)
    expect(held).toBe("T")
    expect({ ended, left, leader: leader !== undefined && alive(leader), installed: fs.existsSync(mark) }).toEqual({ ended: true, left: [], leader: false, installed: false })
  } finally {
    child.kill("SIGKILL")
    killAll(pids, root)
  }
}, SLOW)

test("a child process killed with SIGKILL while its start's client waits for the first answer, held stopped after its line asked for its signal: with no SIGCONT, the client and the server are gone", async () => {
  // The client's line (lead, ec-58rjh9, B15, B18): a stand-in server path;
  // its client holds itself stopped.
  const root = place()
  const server = heldClientServer(root)
  const child = caller([[server, root]])
  const pids: Array<number> = []
  try {
    const client = await pidIn(path.join(root, "mariadb.pid"), WAIT_MAX)
    pids.push(client)
    const held = { state: await stoppedState(client, 5_000), parent: statOf(client)?.ppid === child.pid }
    const daemon = await pidIn(path.join(root, "mariadbd.pid"), WAIT_MAX)
    pids.push(daemon)
    child.kill("SIGKILL")
    await child.exited
    const ended = { client: await gone(client, 30_000), daemon: await gone(daemon, 30_000) }
    const left = await allGone(root, 30_000)
    // Held stopped, a child of the caller, before the kill.
    expect(held).toEqual({ state: "T", parent: true })
    expect({ ended, left }).toEqual({ ended: { client: true, daemon: true }, left: [] })
  } finally {
    child.kill("SIGKILL")
    killAll(pids, root)
  }
}, SLOW)

test("a child process killed with SIGKILL while its start's client line is held before setpriv asked for its signal: the line ends when it continues, and no client ran", async () => {
  // The client's line (lead, ec-58rjh9, B15, B17, B18): a stand-in server
  // path; the stand-in setpriv holds only the client's line.
  const root = place()
  const server = heldClientServer(root)
  const bin = standIns(root, { setpriv: "--execute=" })
  const child = caller([[server, root]], bin)
  const pids: Array<number> = []
  try {
    const line = await pidIn(path.join(root, "setpriv.pid"), WAIT_MAX)
    pids.push(line)
    const held = { state: await stoppedState(line, 5_000), parent: statOf(line)?.ppid === child.pid }
    child.kill("SIGKILL")
    await child.exited
    process.kill(line, "SIGCONT")
    const ended = await gone(line, 30_000)
    const left = await allGone(root, 30_000)
    const ran = pidWritten(path.join(root, "mariadb.pid"))
    if (ran !== undefined) pids.push(ran)
    expect(held).toEqual({ state: "T", parent: true })
    expect({ ended, left, ran: ran !== undefined }).toEqual({ ended: true, left: [], ran: false })
  } finally {
    child.kill("SIGKILL")
    killAll(pids, root)
  }
}, SLOW)

test("a path that holds no mariadbd fails with an error that names it and the missing program, and makes nothing", async () => {
  const under = place()
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-server-"))
  await expect(start(empty, under)).rejects.toThrow(`${empty} is not a MariaDB server: it has no bin/mariadbd.`)
  expect(fs.readdirSync(under)).toEqual([])
})

// A directory whose socket's path is SOCKET_MAX + 1 bytes long.
const tooLong = () => {
  const base = place()
  // The name adds its own bytes and one "/".
  const over = SOCKET_MAX + 1 - Buffer.byteLength(socketOf(base)) - 1
  const under = path.join(base, "d".repeat(over))
  fs.mkdirSync(under)
  expect(Buffer.byteLength(socketOf(under))).toBe(SOCKET_MAX + 1)
  return under
}

test("a socket's path over 107 bytes is refused before a start, with an error that names the limit; one of 107 bytes is not refused for its length", async () => {
  expect(SOCKET_MAX).toBe(107)
  const under = tooLong()
  // A path with no server: the length is refused first.
  await expect(start("/nonexistent/mariadb-server", under)).rejects.toThrow(`is ${SOCKET_MAX + 1} bytes, over the ${SOCKET_MAX} that a socket's path may have`)
  expect(fs.readdirSync(under)).toEqual([])
  const fits = path.join(path.dirname(under), "e".repeat(path.basename(under).length - 1))
  fs.mkdirSync(fits)
  expect(Buffer.byteLength(socketOf(fits))).toBe(SOCKET_MAX)
  await expect(start("/nonexistent/mariadb-server", fits)).rejects.toThrow("/nonexistent/mariadb-server is not a MariaDB server")
})

if (GIVEN.kind === "unset") {
  const why = `the cases with a server: skipped, ${VARIABLE} is not set (just test-mariadb sets it)`
  // `bun test` prints no skipped case's name: the output says it too.
  console.log("tools/mariadb.test.ts: " + why)
  test.skip(why, () => {})
}

if (GIVEN.kind === "empty") {
  const value = GIVEN.value
  test(`the cases with a server: ${VARIABLE} is set and names no server`, () => {
    throw new Error(`${VARIABLE} is set and names no server (${JSON.stringify(value)}): give the servers' paths, separated by spaces, or leave it unset to skip the cases with a server`)
  })
}

for (const server of PATHS) {
  describe(`MariaDB ${versionOf(server)} (${server})`, () => {
    test("the server starts, and select version() gives the path's version", async () => {
      await using([() => start(server, place())], async ([one]) => {
        expect(one!.version.startsWith(versionOf(server) + "-")).toBe(true)
        expect((await one!.query("select version()")).trim()).toBe(one!.version)
        expect((await one!.query("select 1 + 1")).trim()).toBe("2")
      })
    }, SLOW)

    test("no network: @@skip_networking is 1 and @@port is 0", async () => {
      await using([() => start(server, place())], async ([one]) => {
        expect((await one!.query("select @@skip_networking, @@port")).trim()).toBe("1\t0")
      })
    }, SLOW)

    test("the socket, the data and the logs are inside the directory given; the server says that socket", async () => {
      const under = place()
      await using([() => start(server, under)], async ([one]) => {
        expect(path.dirname(one!.dir)).toBe(under)
        expect(path.dirname(one!.socket)).toBe(one!.dir)
        expect(fs.statSync(one!.socket).isSocket()).toBe(true)
        expect((await one!.query("select @@socket")).trim()).toBe(one!.socket)
        expect((await one!.query("select @@datadir")).trim()).toBe(path.join(one!.dir, "data") + "/")
      })
    }, SLOW)

    test("each place that the server writes is inside its directory: its variables of places, and each file that it has open for writing while a client holds a temporary table of MyISAM", async () => {
      await using([() => start(server, place())], async ([one]) => {
        const inside = (where: string) => where === one!.dir || where.startsWith(one!.dir + "/")
        const names = ["datadir", "tmpdir", "innodb_tmpdir", "slave_load_tmpdir", "socket", "pid_file", "log_error"]
        const values = (await one!.query(`select ${names.map((name) => "@@" + name).join(", ")}`)).replace(/\n$/, "").split("\t")
        const places = names.map((name, k) => [name, values[k]!] as const).filter(([, value]) => value !== "" && value !== "NULL")
        expect(places.map(([name]) => name)).toEqual(expect.arrayContaining(["datadir", "tmpdir", "socket", "pid_file", "log_error"]))
        expect(places.filter(([, value]) => !inside(value))).toEqual([])
        // A client that holds a temporary table until its input ends.
        const client = Bun.spawn([path.join(server, "bin", "mariadb"), "--no-defaults", "--user=root", `--socket=${one!.socket}`, "--batch", "--skip-column-names", "--unbuffered"], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe"
        })
        try {
          client.stdin.write("create database held; create temporary table held.t (v int) engine=MyISAM; insert into held.t values (1); select 'ready';\n")
          await client.stdin.flush()
          const reader = client.stdout.getReader()
          let text = ""
          while (!text.includes("ready")) {
            const { value, done } = await reader.read()
            if (done) break
            text += new TextDecoder().decode(value)
          }
          expect(text.trim()).toBe("ready")
          // Each descriptor open for writing: a path inside the directory,
          // or no stored file: no path (a pipe, a socket, an anonymous
          // inode), a device, or a file of the kernel's interfaces (`/sys`,
          // `/proc`: the server's watch of memory pressure writes its
          // trigger into its cgroup's `memory.pressure`).
          const fds = fs.readdirSync(`/proc/${one!.pid}/fd`)
          const writes: Array<string> = []
          for (const fd of fds) {
            let target = ""
            let flags = 0
            try {
              target = fs.readlinkSync(`/proc/${one!.pid}/fd/${fd}`)
              flags = parseInt(/^flags:\s+([0-7]+)/m.exec(fs.readFileSync(`/proc/${one!.pid}/fdinfo/${fd}`, "utf8"))![1]!, 8)
            } catch {
              continue
            }
            if ((flags & 3) !== 0) writes.push(target.replace(/ \(deleted\)$/, ""))
          }
          const files = writes.filter((target) => target.startsWith("/") && !/^\/(dev|sys|proc)\//.test(target))
          expect(files.filter((target) => !inside(target))).toEqual([])
          // The held table's files are among them, in the server's `tmp`.
          expect(files.filter((target) => target.startsWith(path.join(one!.dir, "tmp", "#sql")))).not.toEqual([])
        } finally {
          await client.stdin.end()
          await client.exited
        }
      })
    }, SLOW)

    test("a child process killed with SIGKILL while its start's installer runs, with the bootstrap mariadbd held stopped, leaves no process of that installation", async () => {
      const under = place()
      const { held, left } = await killedWhileInstalling([[server, under]])
      // A live bootstrap was held before the kill: else the case shows nothing.
      expect(held).toEqual([{ pid: expect.any(Number), state: "T" }])
      expect(left).toEqual([[]])
    }, SLOW)

    test("a child process killed with SIGKILL while its server's line is held before setpriv asked for its signal: the line ends, and no mariadbd of that directory ran", async () => {
      // Window 3 (lead, ec-saumkk, B11): the installer runs to its end; the
      // stand-in holds only the server's line.
      const root = place()
      const bin = standIns(root, { setpriv: "--skip-networking" })
      const child = caller([[server, root]], bin)
      const pids: Array<number> = []
      try {
        const line = await pidIn(path.join(root, "setpriv.pid"), WAIT_MAX)
        pids.push(line)
        const held = await stoppedState(line, 5_000)
        child.kill("SIGKILL")
        await child.exited
        process.kill(line, "SIGCONT")
        const ended = await gone(line, 30_000)
        const left = await allGone(root, 30_000)
        const dirs = fs.readdirSync(root).filter((name) => name.startsWith("mariadb-"))
        const ran = dirs.filter((name) => fs.existsSync(path.join(root, name, "mariadbd.pid")))
        expect(held).toBe("T")
        expect({ ended, left, dirs: dirs.length, ran }).toEqual({ ended: true, left: [], dirs: 1, ran: [] })
      } finally {
        child.kill("SIGKILL")
        killAll(pids, root)
      }
    }, SLOW)

    test("the stop leaves no process, and a second stop is no error", async () => {
      const one = await start(server, place())
      expect(alive(one.pid)).toBe(true)
      await one.stop()
      expect(alive(one.pid)).toBe(false)
      expect(fs.existsSync(one.socket)).toBe(false)
      await one.stop()
      expect(alive(one.pid)).toBe(false)
    }, SLOW)

    test("a child process that starts a server and is then killed with SIGKILL leaves no mariadbd", async () => {
      const under = place()
      const code = [
        `import { start } from ${JSON.stringify(path.join(import.meta.dir, "mariadb.ts"))}`,
        `const one = await start(${JSON.stringify(server)}, ${JSON.stringify(under)})`,
        `console.log(JSON.stringify({ pid: one.pid, version: one.version }))`,
        `await new Promise(() => {})`
      ].join("\n")
      const child = Bun.spawn(["bun", "--eval", code], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
      let pid = 0
      try {
        // The child's first line, once its server answers.
        const reader = child.stdout.getReader()
        let text = ""
        while (!text.includes("\n")) {
          const { value, done } = await reader.read()
          if (done) break
          text += new TextDecoder().decode(value)
        }
        if (!text.includes("\n")) {
          throw new Error(`the child ended before its server answered: ${await new Response(child.stderr).text()}`)
        }
        const started = JSON.parse(text.slice(0, text.indexOf("\n"))) as { pid: number; version: string }
        pid = started.pid
        expect(started.version.startsWith(versionOf(server) + "-")).toBe(true)
        expect(alive(pid)).toBe(true)
        child.kill("SIGKILL")
        await child.exited
        expect(await gone(pid, 30_000)).toBe(true)
      } finally {
        child.kill("SIGKILL")
        if (pid !== 0 && alive(pid)) process.kill(pid, "SIGKILL")
      }
    }, SLOW)
  })
}

if (PATHS.length > 0) {
  test("two servers run at one time in two directories: the two versions given (the one path two times when one is given)", async () => {
    const [a, b] = PATHS.length >= 2 ? [PATHS[0]!, PATHS[1]!] : [PATHS[0]!, PATHS[0]!]
    const first = place()
    const second = place()
    await using([() => start(a, first), () => start(b, second)], async ([one, two]) => {
      expect(alive(one!.pid) && alive(two!.pid)).toBe(true)
      expect(one!.socket).not.toBe(two!.socket)
      expect([path.dirname(one!.dir), path.dirname(two!.dir)]).toEqual([first, second])
      const versions = await Promise.all([one!.query("select version()"), two!.query("select version()")])
      expect(versions.map((one) => one.trim().split("-")[0])).toEqual([versionOf(a), versionOf(b)])
      // Each has its own data: a schema made on one is not on the other.
      await one!.query("create database only_here")
      expect((await one!.query("show databases like 'only_here'")).trim()).toBe("only_here")
      expect((await two!.query("show databases like 'only_here'")).trim()).toBe("")
    })
  }, SLOW)

  test("two starts at one time in one child (the two versions given), the child killed with SIGKILL while both installers run: no process of either installation is left", async () => {
    const [a, b] = PATHS.length >= 2 ? [PATHS[0]!, PATHS[1]!] : [PATHS[0]!, PATHS[0]!]
    const { held, left } = await killedWhileInstalling([[a, place()], [b, place()]])
    expect(held).toEqual([{ pid: expect.any(Number), state: "T" }, { pid: expect.any(Number), state: "T" }])
    expect(left).toEqual([[], []])
  }, SLOW)
}
