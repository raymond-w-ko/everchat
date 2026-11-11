// Shell
// =====
// The one way in which a program can start a process: the function `shell`
// runs a command with the person's shell. Ported from the old code
// (ref/src/machine.ts: Machine.shell, group, alive, kill, end).
//
// How a command runs
//
// - Each command is a new shell, a direct child of EverChat, in its own
//   process group. Its stdin is closed. Its stdout and stderr are one
//   stream.
// - The call waits until the command and everything that holds its output
//   end.
// - The result is the output, then one last line that says how it ended:
//   `(exit 0 in 0.4 s)`. A command that fails is not an error of the
//   function: the program reads the last line.
// - A stop (the person's, or the end of the program that called it) kills
//   the process group.
//
// Three limits
//
// - The time limit: a command is stopped after SECONDS, or after the
//   seconds that the program gave. Without it, a command that waits for
//   ever would hold its turn for ever when no person watches.
// - The hard limit: past HARD bytes of output, the output ends there and
//   the command is stopped (docs/schema.html, "The output limit").
// - The output limit does not apply here: the program gets the whole
//   output.
//
// No process is left behind
//
// - Each process that a command starts carries this launch's run tag in
//   its environment (the variable in TAG). A child gets it from its
//   parent, also when it leaves the process group.
// - When the program ends, it kills every process group that it started,
//   and then every process that still carries its run tag.
// - When the program starts, it kills every process that carries the run
//   tag of a launch that ended: a crash leaves such processes behind
//   (docs/schema.html, section 8, step 2).
//
// The command's environment is EverChat's own, without the inference
// gateway's address and key: a command has no use for them.
//
// This module uses `Bun.spawn` and not Effect's process modules. The hooks
// need each command's shell to be a direct child with a known process
// group, and the limits need each chunk of output as it comes.

import { Context, Effect, Layer } from "effect"
import * as fs from "node:fs"
import { HARD } from "./limit.ts"
import { Store, type StoreError } from "./store.ts"

// This module's diagnostics name it as their source (diagnostics.ts).
const diagnostic = Effect.annotateLogs("source", "shell")

// The environment variable that carries a launch's run tag.
export const TAG = "EVERCHAT_RUN"

// The time limit of a command, in seconds, when the program gives none.
export const SECONDS = 600

// How a process's environment carries a run tag.
const CARRIES = new RegExp("(?:^|[\\0 ])" + TAG + "=([^\\0 ]+)")

// Variables that a command does not get.
const SECRET = /^EVERCHAT_GATEWAY_/

export interface Options {
  readonly cwd?: string | undefined // the work directory; the program's own when not given
  readonly shell?: string | undefined // the shell; $SHELL when not given
  readonly hard?: number | undefined // the hard limit in bytes; a test gives a small one
}

export interface Command {
  readonly seconds?: number | undefined
  // Called once, with the command's process group, when it has started.
  readonly started?: ((pgid: number) => Effect.Effect<void>) | undefined
}

// Whether a process (pid) or a process group (-pid) exists.
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return (cause as { code?: string }).code === "EPERM"
  }
}

const kill = (pid: number): void => {
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // It is gone already.
  }
}

// Whether a shell's process group may still hold a job: the shell runs, or
// it is gone but its id names no live process and its group still has one.
const holds = (proc: Bun.Subprocess): boolean => {
  const ended = proc.exitCode !== null || proc.signalCode !== null
  return !ended || (!alive(proc.pid) && alive(-proc.pid))
}

// The processes of this user that carry one of the run tags. Linux gives
// each process's environment as a file. Elsewhere, `ps` lists it.
const tagged = (tags: ReadonlySet<string>): Array<number> => {
  const out: Array<number> = []
  const has = (environment: string) => {
    const found = CARRIES.exec(environment)
    return found !== null && found[1] !== undefined && tags.has(found[1])
  }
  if (tags.size === 0) {
    return out
  }
  if (process.platform === "linux") {
    for (const name of fs.readdirSync("/proc")) {
      const pid = Number(name)
      if (!Number.isInteger(pid) || pid === process.pid) {
        continue
      }
      try {
        if (has(fs.readFileSync("/proc/" + name + "/environ", "utf8"))) {
          out.push(pid)
        }
      } catch {
        // Another user's process, or one that has ended.
      }
    }
    return out
  }
  const uid = String(process.getuid?.() ?? "")
  const listed = Bun.spawnSync(["ps", "-wwE", "-U", uid, "-o", "pid=,command="]).stdout.toString()
  for (const line of listed.split("\n")) {
    const pid = Number(line.trim().split(" ")[0])
    if (Number.isInteger(pid) && pid !== process.pid && has(line)) {
      out.push(pid)
    }
  }
  return out
}

// Kills every process that carries one of the run tags. It gives their
// number.
export const sweep = (tags: ReadonlySet<string>): Effect.Effect<number> =>
  Effect.sync(() => {
    try {
      const pids = tagged(tags)
      pids.forEach(kill)
      return pids.length
    } catch {
      return 0
    }
  })

export class Shell extends Context.Service<Shell, {
  // Runs a command, and gives its output and how it ended, as one text.
  run(command: string, options?: Command): Effect.Effect<string>
}>()("everchat/shell/Shell") {
  static readonly layer = (options: Options = {}): Layer.Layer<Shell, StoreError, Store> =>
    Layer.effect(
      Shell,
      Effect.gen(function*() {
        const store = yield* Store
        const tag = store.launch.runTag
        const cwd = options.cwd ?? process.cwd()
        const shell = options.shell ?? process.env.SHELL ?? "/bin/sh"
        const hard = options.hard ?? HARD
        const env: Record<string, string> = { [TAG]: tag }
        for (const [name, value] of Object.entries(process.env)) {
          if (value !== undefined && name !== TAG && !SECRET.test(name)) {
            env[name] = value
          }
        }

        // The shells that this launch started. A shell stays here until its
        // process group is empty, so that the end of the program also kills
        // a background job whose shell has ended.
        const shells = new Set<Bun.Subprocess>()

        // What a crash left behind.
        const left = yield* sweep(new Set((yield* store.endedRunTags).filter((old) => old !== tag)))
        if (left > 0) {
          yield* diagnostic(Effect.logWarning(`stopped ${left} processes that an earlier launch left behind`))
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function*() {
            for (const proc of shells) {
              if (holds(proc)) kill(-proc.pid)
            }
            shells.clear()
            yield* sweep(new Set([tag]))
          })
        )

        // Reads the command's output to its end, with the two limits.
        const drain = async (proc: Bun.Subprocess<"ignore", "pipe", "ignore">, seconds: number, signal: AbortSignal) => {
          const start = performance.now()
          const reader = proc.stdout.getReader()
          const decoder = new TextDecoder("utf-8")
          let [text, size] = ["", 0]
          let why: "time" | "hard" | "stop" | null = null
          const stop = (reason: "time" | "hard" | "stop") => {
            why ??= reason
            kill(-proc.pid)
            reader.cancel().catch(() => {})
          }
          const onAbort = () => stop("stop")
          signal.addEventListener("abort", onAbort, { once: true })
          const timer = setTimeout(() => stop("time"), seconds * 1000)
          try {
            for (let got = await reader.read(); !got.done; got = await reader.read()) {
              const room = hard - size
              const chunk = got.value.length > room ? got.value.subarray(0, room) : got.value
              size += chunk.length
              text += decoder.decode(chunk, { stream: true })
              if (got.value.length > room) {
                stop("hard")
                break
              }
            }
          } catch {
            // The stream was cancelled.
          }
          text += decoder.decode()
          clearTimeout(timer)
          signal.removeEventListener("abort", onAbort)
          const code = await proc.exited
          const time = ((performance.now() - start) / 1000).toFixed(1) + " s"
          const ended = why === "time"
            ? "stopped after " + seconds + " s, the time limit: give more seconds as the second argument"
            : why === "hard"
            ? "stopped: the output passed " + hard + " bytes, the most that a call may give"
            : why === "stop"
            ? "stopped in " + time
            : proc.signalCode !== null
            ? "killed by " + proc.signalCode + " in " + time
            : "exit " + code + " in " + time
          const body = text.replace(/\n$/, "")
          return (body === "" ? "" : body + "\n") + "(" + ended + ")"
        }

        const run = Effect.fn("Shell.run")(function*(command: string, given: Command = {}) {
          const seconds = given.seconds !== undefined && given.seconds > 0 ? given.seconds : SECONDS
          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function*() {
              for (const old of shells) {
                if (!holds(old)) shells.delete(old)
              }
              // sh joins stderr to stdout, then becomes the person's shell
              // (the same process, so the same group). A shell that is not
              // POSIX (fish) never sees the `exec 2>&1`, which it would
              // read as a bare exec.
              const proc = Bun.spawn(["/bin/sh", "-c", "exec 2>&1; exec \"$0\" -c \"$1\"", shell, command], {
                cwd,
                env,
                stdin: "ignore",
                stdout: "pipe",
                stderr: "ignore",
                detached: true
              })
              shells.add(proc)
              if (given.started !== undefined) {
                yield* given.started(proc.pid)
              }
              // A stop aborts the signal, and that kills the process group.
              return yield* restore(Effect.promise((signal) => drain(proc, seconds, signal)))
            })
          )
        })

        return Shell.of({ run })
      })
    )
}
