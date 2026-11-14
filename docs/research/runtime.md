# Runtimes and isolation units for many agents

The question: in which unit can EverChat hold many agents, most of them idle,
on few processes? For each unit: how strong the isolation is, what an idle
agent costs, and how much of today's code must change. It decides nothing.
The operator's "agent for each person or tenant" is one chat (one log, one
database; GLOSSARY.md's "agent" is a helper that a chat starts), so this
document says **tenant chat** (see "Words"). Other documents of this batch:
`docs/research/store.md` (the store, tenancy, database credentials),
`docs/research/agents.md` (routing, load and unload, events),
`docs/research/functions.md` (functions, their secrets, limits of code mode).

## Today

What binds the program to Bun and to one process:

| What | Where | What it binds |
| --- | --- | --- |
| The SQLite driver for Bun (`@effect/sql-sqlite-bun`, on `bun:sqlite`) | src/database.ts:21, src/database.ts:60 | Bun, and a file on a local disk (`store.md` covers the rest). |
| A read-only connection for a second process (the inspector) | src/database.ts:55 | A file that two processes of one host can open. |
| Effect's services for Bun: `Stdio`, `FileSystem`, `Path` | src/main.ts:79, src/main.ts:297 | Bun (`@effect/platform-bun`). A Node version exists. |
| The inspector's HTTP server for Bun | src/inspector.ts:32 | Bun. |
| `Bun.CryptoHasher` for hashes | src/store.ts:1072, src/cache.ts:171 | Bun. Web Crypto can do the same. |
| `Bun.spawn` for each command of the `shell` function, in its own process group | src/shell.ts:255 | Bun, an OS with processes, the person's shell. |
| `ps` and `/proc` to find and kill shells that a crash left behind | src/shell.ts:117, src/shell.ts:133, src/shell.ts:149 | A Unix host. |
| The shell's environment is EverChat's own, less the secrets | src/shell.ts:170 | One environment for the process. |
| `read`, `write` and `edit` use `node:fs` on paths from the work directory | src/files.ts:17, src/files.ts:40 | A file system on the host. |
| The sandbox starts one worker thread for each program, with QuickJS as WebAssembly | src/sandbox.ts:45, src/sandbox.ts:181 | `node:worker_threads`: `node_modules/@earendil-works/pi-codemode/dist/runtime/host.js:1`. |
| A memory limit of 512 MiB for each program's engine, and a compute limit of 60 s | src/sandbox.ts:56, src/sandbox.ts:60 | Nothing. The memory limit is the engine's. The compute limit is EverChat's timer on the host: off while any function works, whole again after it (src/sandbox.ts:171, src/sandbox.ts:190); no deadline (src/sandbox.ts:182). |
| The QuickJS file is imported as a file, so that the build puts it into the executable | src/sandbox.ts:47 | `bun build --compile`. |
| The worker thread's program is a second entrypoint of the build | src/worker.ts:14, src/sandbox.ts:67 | `bun build --compile src/main.ts src/worker.ts` (`justfile`, `build`). |
| One launch: one home, one database file, one work directory, one pick | src/main.ts:136, src/main.ts:203 | One chat for each process. The layer takes its home and file as arguments. |
| A launch is the process: `pid`, `host`, `cwd` | src/main.ts:137, src/main.ts:202 | One process for each chat. |
| Signals end the process; a second signal exits at once | src/main.ts:266, src/main.ts:275 | One chat for each process. |
| "Another launch is live" is a check of a pid on this host; a launch with the same pid is taken as a crash | src/store.ts:314, src/store.ts:922 | Two chats on one file in one process would both take it. |
| The gateway's key comes from the environment or the person's home, and leaves the environment | src/gateway.ts:89, src/gateway.ts:91 | One key for each process. |

Measured on this machine (Bun 1.4.4, Linux x86_64, 30 cores), each with a
small script in `/tmp`, not in the repository. No row is a loaded, live chat
(its view, its turns, its programs):

| Measurement | Result |
| --- | --- |
| RSS of a bare Bun process, after a full GC | 18.6 MB |
| RSS of a Bun process that imported `src/main.ts` and all its modules; the import's time | 71.4 MB; 179 ms |
| RSS added by each of 100,000 idle Effect fibers, each one waiting on its own queue | about 2 KB |
| RSS added by each of 1,000 open, idle SQLite connections (WAL, one small table, one file each) | about 199 KB |
| RSS added by each of 20 idle Bun worker threads that imported `src/main.ts`; their start time | about 3 MB (main thread's RSS after GC; not proved for a live chat); 270 ms |
| One code mode run of `return 1 + 1` (a new worker thread and a new QuickJS engine) | 29 ms median, 60 ms for the first |
| Code mode from inside a Bun worker thread (a nested worker thread) | It runs, with the right result. |
| A program `for (;;) {}` in code mode, against a 10 ms timer on the main thread | Worst gap 18 ms in 3 s: the loop does not hold the main thread. |
| `process.env` in a Bun worker thread | A copy: a change there does not reach the main thread. |

## Facts

Engines and Bun

- Bun runs on JavaScriptCore, not on V8: no "V8 isolate"; its nearest unit is a worker thread. https://bun.com/docs
- Bun's `Worker` "is still experimental (particularly for terminating workers)"; it is "a new JavaScript
  instance running on a separate thread while sharing I/O resources". https://bun.com/docs/runtime/workers
- Bun's `Worker` "ignores the `resourceLimits`" option: no memory limit for a worker thread. https://bun.com/docs/runtime/nodejs-compat
- "The `node:vm` module is not a security mechanism." https://nodejs.org/api/vm.html
- Node's `worker_threads` take `resourceLimits`, but "the process may still abort" on a global out-of-memory. https://nodejs.org/api/worker_threads.html
- `isolated-vm` gives V8's `Isolate` to Node; it "is currently in maintenance mode", and its `memoryLimit` is
  "more of a guideline" ("2-3 times this limit"). A native addon for Node: not on Bun (not proved by a run). https://github.com/laverdet/isolated-vm
- Deno: a subprocess "runs as a separate program with its own permissions", so `--allow-run` is "equivalent to `--allow-all`". https://docs.deno.com/runtime/fundamentals/security/
  Permissions for a Web Worker are "an unstable Deno feature". https://docs.deno.com/runtime/reference/web_platform_apis/

Cloudflare

- `workerd` can "self-host applications designed for Cloudflare Workers", but "workerd is not a hardened
  sandbox": malicious code must run "inside an appropriate secure sandbox, such as a virtual machine". https://github.com/cloudflare/workerd
- "A single instance of the runtime can run hundreds or thousands of isolates"; an isolate starts "around a
  hundred times faster than a Node process". https://developers.cloudflare.com/workers/reference/how-workers-works/
- Workers: 128 MB for each isolate (heap and WebAssembly), "per-isolate, not per-invocation"; an isolate over it
  is replaced after its requests in flight end; 30 s of CPU for each request by default, 5 min at most. https://developers.cloudflare.com/workers/platform/limits/
- `node:child_process` and `node:worker_threads` are stubs that do "not provide a working implementation". https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- "Threading is not possible in Workers"; `WebAssembly.instantiate()` "only supports pre-compiled modules". https://developers.cloudflare.com/workers/runtime-apis/webassembly/
- `connect()` opens TCP sockets (MySQL and PostgreSQL are named), not to "private network IPs". https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
  Hyperdrive pools connections to "any Postgres or MySQL database"; MariaDB is not named. https://developers.cloudflare.com/hyperdrive/
- An idle Durable Object hibernates "after 10 seconds", or is evicted "after 70-140 seconds"; "the in-memory
  state is discarded", and the constructor runs again. An outbound `fetch()` holds it "for up to 15 minutes". https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
- Duration is billed "for the 128 MB of memory your Durable Object is allocated, regardless of actual usage";
  objects "eligible for hibernation are not billed for duration". Objects of one class "may run in the same
  isolate on the same physical machine and share the 128 MB of memory", each still billed for 128 MB
  (footnote 5). So an object is a unit of storage and of billing, not of heap. https://developers.cloudflare.com/durable-objects/platform/pricing/
- Each Durable Object has its own SQLite database (10 GB on Workers Paid); objects are "unlimited". https://developers.cloudflare.com/durable-objects/platform/limits/
- `sql.exec` is synchronous and "cannot execute transaction-related statements"; `transactionSync` takes a
  synchronous callback; the storage "is private to its unique instance". https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- "Each Durable Object is able to schedule a single alarm at a time"; an alarm wakes an evicted object. https://developers.cloudflare.com/durable-objects/api/alarms/
- Dynamic Workers run "arbitrary code specified at runtime" (`env.LOADER.get`). `globalOutbound: null` makes
  each `fetch()` and `connect()` throw; a gateway can add a tenant's credentials so that "the secret stays
  hidden". https://developers.cloudflare.com/dynamic-workers/usage/egress-control/
  Custom limits: `cpuMs` and `subRequests`. https://developers.cloudflare.com/dynamic-workers/usage/limits/
  At most 10 distinct Dynamic Workers with requests in flight for one Durable Object (its requests share one
  I/O context), 4 for one plain request; no memory limit or start time (not proved). https://developers.cloudflare.com/dynamic-workers/platform/limits/
  Price (Workers Paid only): 1,000 unique Dynamic Workers a month, then $0.002 for each a day; 10 million
  requests, then $0.30 a million; 30 million CPU ms, then $0.02 a million, startup included. https://developers.cloudflare.com/dynamic-workers/pricing/
- Durable Object Facets: a supervisor object loads a Durable Object class from a Dynamic Worker; each facet
  name "gets its own SQLite database", and the facet "cannot read the supervisor's database". The page
  speaks of storage only, not of isolates or CPU. https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/
- One Durable Object controls one Cloudflare Container. https://developers.cloudflare.com/containers/
- `@effect/platform-cloudflare` 4.1.4 (experimental) and `@effect/sql-sqlite-do` 4.1.4 (unstable; transactions
  through `storage.transaction()`) exist, for `effect` `^4.1.4` (read from the npm tarballs). https://www.npmjs.com/package/@effect/sql-sqlite-do https://www.npmjs.com/package/@effect/platform-cloudflare
- `pi-codemode` 1.5.2 has a sandbox for Cloudflare: the engine in a Durable Object of a separate Worker, 32 MiB
  by default. A program that computed 10 s delayed the agent's object by 10 s in the same object or in a
  Dynamic Worker that it loaded, by about 50 ms in a separate Worker (its `README.md`, lines 126-230). https://github.com/earendil-works/pi/tree/main/packages/codemode

"Nitro" and microVMs

- Nitro (UnJS) builds one server program for many hosts ("presets"): Node by default, Cloudflare too. No VM,
  no isolate. https://nitro.build/deploy https://nitro.build/deploy/providers/cloudflare
- AWS Nitro Enclaves are "highly-constrained virtual machines" with "no persistent storage, interactive
  access, or external networking", only a local socket (vsock) to the parent; "up to four individual enclaves
  per parent instance"; the enclave "must run a Linux operating system". https://docs.aws.amazon.com/enclaves/latest/user/nitro-enclave.html
  AWS's sample builds an enclave image from an Alpine Dockerfile with `CMD ./vsock-sample server --port 5005`
  (`nitro-cli build-enclave`): the guest runs the image's programs. https://docs.aws.amazon.com/enclaves/latest/user/developing-applications-linux.html
- Firecracker runs AWS Lambda and Fargate. Its specification promises, on an M5D.metal (hyperthreading
  disabled) or M6G.metal instance "given host system resources are available", and for a microVM of 1 vCPU
  and 128 MiB with the Firecracker-tuned kernel: VMM threads' memory overhead `<= 5 MiB` (it "is dependent
  on the workload", for example "multiple vsock connections might generate a memory overhead > 5MiB", and
  it excludes the MMDS data store), and `<= 125 ms` from the InstanceStart call to `/sbin/init`, "using a
  VM with the serial console disabled and a minimal kernel and root file system". These are its test
  configuration's figures, not general bounds; a loaded EverChat chat's footprint and ready time are not
  measured. https://github.com/firecracker-microvm/firecracker https://github.com/firecracker-microvm/firecracker/blob/main/SPECIFICATION.md
- From v1.18, Firecracker can use `/dev/nitro_enclaves` in place of `/dev/kvm` (a Nitro Sandbox): the parent
  "runs no hypervisor of its own", on enclave-enabled x86_64 or Graviton instances, and sandboxes "do not run
  on bare-metal instances". A parent has 4 slots at first; each 128 MiB of donated memory adds 8 (160 at most
  on the 32-vCPU example). It has block, network and vsock devices, and "is not the same thing as an AWS
  Nitro Enclave". Boot time and overhead: not given (not proved). https://github.com/firecracker-microvm/firecracker/blob/main/docs/nitro-sandboxes/README.md
  https://github.com/firecracker-microvm/firecracker/blob/main/docs/nitro-sandboxes/getting-started.md
- AWS Lambda MicroVMs (Firecracker) are for "AI code execution sandboxes" and can be "suspended when idle,
  preserving memory and disk state"; the price of a suspended one: not proved. https://docs.aws.amazon.com/lambda/latest/dg/microvms.html
- A Lambda function runs at most 900 s and keeps no state; a MicroVM runs at most 8 hours (not adjustable);
  `RunMicrovm` is 5 a second by default. https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html
- The smallest Fargate task is 0.25 vCPU and 512 MiB. https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html
  At $0.000011244 a vCPU-second and $0.000001235 a GB-second (Linux x86, US East), about $9 a month if it
  runs all the time. https://aws.amazon.com/fargate/pricing/

## Options

One row for each unit. "Change": how much of today's code must change.

| Unit | Isolation (memory, CPU, secrets) | Idle tenant chat | Start or wake | Effect 4 | Database server | Code mode | Shell and files | In the company's AWS | Change |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| (a) Fibers in one Bun process | None between chats: one heap, one event loop, one OS user. | About 2 KB a fiber, about 199 KB an open SQLite file (measured), plus the chat's state (not measured). | A new layer: milliseconds (not measured). | Yes, today. | Yes (`store.md`). | Yes, as today. | Yes, but all chats share one OS user and its files. | Yes. | Small: a registry of chats, the launch rule (src/store.ts:922), signals. |
| (b) A Bun worker thread for each chat | Its own heap. The same process, OS user and files. No memory limit. A crash ends all. | About 3 MB (measured; not proved for a live chat). | About 270 ms (measured). | Yes. | Yes. | Yes: a nested worker thread works (measured). | Yes, the same OS user. | Yes. | Medium. Bun calls `Worker` experimental. |
| (c) Many Bun processes | An OS process: its own memory; can run as its own OS user, with cgroup limits. | About 71 MB while it runs (measured); 0 when stopped. | About 0.2 s to load the modules (measured), plus the store. | Yes. | Yes. | Yes. | Yes, and each OS user sees only its files. | Yes (EC2, ECS). | Smallest: today's unit, plus a supervisor (`agents.md`). |
| (d) Node with `isolated-vm`, `node:vm` or `worker_threads` | `isolated-vm`: a V8 isolate, a soft memory limit. `node:vm`: none. `worker_threads`: a heap limit. | Not measured. | Not measured. | Yes (`@effect/platform-node`). | Yes. | Yes (`CodemodeSandbox` supports Node). | Outside an isolate only: no Node API in one. | Yes. | Large: a port from Bun (driver, `Bun.spawn`, the build, `bun:test`). |
| (e) Deno | Permissions for each process; for each Web Worker only as an unstable feature. A subprocess escapes them. | Not measured. | Not measured. | Not proved. | Not proved. | Not proved. | Yes, but `--allow-run` is `--allow-all`. | Yes. | Large: a port from Bun. |
| (f) `workerd`, hosted by oneself | V8 isolates, many in one process. Not a hardened sandbox: it needs a VM around it. | Not measured. | About 100 times faster than a Node process (Cloudflare's claim). | Yes (`@effect/platform-cloudflare`). | `connect()` (on one's own host: not proved). | Only on the caller's thread (no threads). | No processes; files not proved. | Yes, inside a VM. | Very large: new shell, files, store, sandbox. |
| (g) Cloudflare Workers, a Durable Object for each chat | Private SQLite for each object. Not a heap for each object: objects of one class may share an isolate, its globals and its 128 MB. | No duration cost while it hibernates; stored data is billed. | The constructor runs again (time not proved). | Yes (`@effect/platform-cloudflare`, `@effect/sql-sqlite-do`). | Hyperdrive, or `connect()` but not to private IPs. | Yes, in a separate Worker (`pi-codemode`). | No; a Cloudflare Container for each object can give them. | No: it runs on Cloudflare. | Very large: a synchronous SQL API, no shell, a remote sandbox. |
| (h) Dynamic Workers (the Worker Loader), with Facets | Code loaded at run time; network blocked or through a gateway. A facet: its own SQLite under a supervisor object (storage only). | $0.002 a day for each unique Worker past 1,000 a month. | "Milliseconds" (no number). | Not proved. | Through the gateway. | Inline code mode still blocks the object that runs it. | No. | No. | Very large; a supervisor has at most 10 Dynamic Workers in flight. |
| (i) "nitro vm" | UnJS Nitro: none. Nitro Enclaves: a Linux VM, no persistent storage, network only through a vsock proxy, at most 4 for each instance. | Enclaves: 4 for each instance. | Not measured. | Nitro: yes. | Enclaves: through a vsock proxy. | Enclaves: not proved. | Enclaves: a command from the image can run; files lost at the end. | Enclaves: yes. | Nitro: a port of the build. Enclaves: an enclave image, a vsock proxy, storage outside. |
| (j) A container or a microVM for each chat | A container: its own namespaces and cgroups on the host's kernel. A microVM: its own kernel, the strongest here. | Fargate: at least about $9 a month if always on; Lambda MicroVMs keep memory while suspended (price not proved). | Firecracker's specification: <= 125 ms to `/sbin/init` for a minimal guest on its `.metal` test instances (a loaded chat ready: not measured; as a Nitro Sandbox: not proved); a container: seconds (not measured). | Yes. | Yes. | Yes. | Yes, each chat its own machine. | Yes. | Small for the program; large for the operations. |

What each unit adds over fibers in one process (question 4):

| Need | What code mode gives already | (b) worker thread | (c) process | (f), (g) isolate | (j) microVM |
| --- | --- | --- | --- | --- | --- |
| Security between tenants | The model's program has no files, no network, no timers, and no view of the host's heap (src/sandbox.ts:3). But each function runs on EverChat's side, and `shell` runs any command as the OS user (src/shell.ts:255): one chat's command can read all chats' files and databases. All tenants' secrets are in one heap. | A separate heap: a bug cannot mix two chats' objects. No help against the shell. | An OS user for each tenant: the shell sees only its files. | No shell, so no such hole; secrets in an isolate's heap, which objects of one class may share. | A microVM: a kernel for each chat, so a shell escape stays inside; a container shares the host's kernel. |
| A fault in one tenant chat | A program's error or loop ends that program only. A crash of Bun (native fault, out of memory) ends all chats of the process. | The same: one process. | One process, one tenant. | An isolate over 128 MB is replaced: every object in it loses its memory, not one only. | One machine. |
| Fair CPU | Each program has its own thread. The compute limit (src/sandbox.ts:171) stops only 60 s of computing with no function at work: a function not awaited (`shell("sleep 600")`) or a wait for a person turns it off, so a program can spin with no end. It is not a CPU budget or a quota. EverChat's own work runs on the one main thread. | Threads compete for cores, with no quota. | cgroups give each process a CPU quota. | CPU limit for each request. | vCPUs for each machine. |
| Memory | At most 512 MiB for each program's engine (src/sandbox.ts:56): K programs at once can take K × 512 MiB of one process. | No limit for each thread in Bun. | cgroups. | 128 MB for each isolate, shared by its objects. | Memory for each machine. |

## What fits, what does not

Local use (the chief of staff): one Bun process for one chat fits and stays; the
factory needs one process in a PTY (AGENTS.md, "How EverChat will be used").

Company use, M tenant chats on N processes in the company's AWS:

- A chat's state is in its database, and a chat restarts from it (AGENTS.md,
  "All state in one SQLite file"). So an idle chat needs no memory: unload
  it, and load it at the next message. "M much larger than N" then means "M
  much larger than the chats that work at once", in each unit. Load and
  unload are in `agents.md`.
- **The shell is the hole, whatever the unit.** Code mode closes the model's
  program; the `shell` function opens it again, because a command runs as
  EverChat's OS user. With fibers, threads or isolates in one process, a
  tenant chat with the shell can read the other chats' files. So either the
  company use has no shell, or the shell (and `read`, `write`, `edit`) runs
  in a box for each tenant: an OS user with cgroups, a container, or a
  microVM. How the functions reach that box is in `functions.md`.
- **Fibers in one process (a)** cost the least for a loaded chat (kilobytes,
  measured) and change the least code. They give no isolation between chats.
  That is enough for the chats of one tenant, with no shell in the process.
- **Bun worker threads (b)** add a heap for each chat, but no memory limit
  and no protection from a crash, for about 0.3 s a start. They give less
  than processes for almost the same price. I would not take them.
- **Many processes (c)** give OS isolation, cgroup limits and today's code.
  At about 71 MB a loaded process, they need the unload of idle chats.
- **Node, Deno and `workerd` (d, e, f)** each need a port from Bun and give
  less than processes: a V8 isolate cannot run Node APIs, so it could hold
  only the model's program, which QuickJS holds already; `isolated-vm` is in
  maintenance mode; Deno's permissions for each worker are unstable and a
  subprocess escapes them; `workerd` needs a VM around it and has no shell.
- **Cloudflare with Durable Objects (g)** fits the shape best: an object for
  each chat, its own SQLite, no duration cost while it hibernates, alarms,
  and Effect packages for it. It fails three needs: it is not in the
  company's AWS, it has no shell or files, and it is a large rewrite (a
  synchronous SQL API, a remote sandbox, 128 MB for each isolate). An object
  keeps its storage apart, not its heap: it is no isolation between tenants.
  Keep it as a second path if the operator accepts Cloudflare.
- **Dynamic Workers with Facets (h)** could hold chats under one supervisor
  object, each with its own SQLite. But a supervisor has at most 10 in
  flight, the port is as large as (g), inline code mode still blocks, and it
  fails the AWS need.
- **A container or a microVM for each chat (j)** is the strongest and costs
  the most while it runs. Lambda MicroVMs that suspend when idle are the
  nearest managed form, but each lives at most 8 hours and they start at 5 a
  second. A microVM for each tenant, as the box of the shell, fits better.

"nitro vm": I read it as AWS Nitro, because the operator listed it with
isolation units and the deployment is in AWS. Nitro Enclaves cannot hold
many chats (four for each instance, no direct network, no lasting files),
though a command can run in one. The reading that fits best is a microVM on
AWS: Firecracker as a Nitro Sandbox (on ordinary enclave-enabled instances,
no `.metal` and no KVM; its speed is not proved), Firecracker on KVM, or
Lambda MicroVMs. UnJS Nitro is a build tool with no VM, and fits the
sentence least. Question 4 asks the operator.

What I would try first: a hybrid of (c) and (a). Keep Bun and one code path.
Run one process for each tenant (or each group of tenants that trust each
other), as its own OS user in a container with cgroup limits. In it, run that
tenant's loaded chats as fibers, and unload the idle ones. Give the shell
only when the operator asks for it, and then in that tenant's box. Then
measure a real idle chat and a real wake. Reasons: it changes the least
code, each step has a measured cost, it stays in the company's AWS, and it
keeps the later paths (microVMs, a remote shell) open.

## Limits

- Bun has no V8 isolates and no memory limit for a worker thread. In one Bun
  process, the only limit for each chat is the engine's limit for each
  program (src/sandbox.ts:56).
- Two chats on one database file in one process would both own it: the
  launch rule takes a launch with the same pid as a crash
  (src/store.ts:922). Many chats in one process need a new rule for
  ownership (`agents.md`).
- The `shell` function cannot run in `workerd` or Cloudflare Workers: each
  isolate unit needs a separate machine for the shell. A Nitro Enclave can
  run its image's commands, but every outside connection needs a vsock
  proxy, and its files end with it.
- The compute limit does not bound a program: a function not awaited, or a
  wait for a person, turns it off (src/sandbox.ts:190). Only a deadline, a
  CPU budget or a cgroup quota bounds it (`functions.md`).
- On Cloudflare: 128 MB for each isolate (today one program may take
  512 MiB); 30 s of CPU for each request by default, 5 min at most; one alarm
  for each object; an outbound request holds the object at most 15 min (a
  request to a model that streams longer: not proved).
- Lambda functions end after 900 s and keep no state; a turn can run longer.
  Lambda MicroVMs end after 8 hours.
- Firecracker of one's own needs KVM (a `.metal` instance; a smaller one:
  not proved), or, from v1.18, the Nitro Sandbox backend on an
  enclave-enabled instance that is not `.metal`, with 4 sandboxes at first
  and more for donated memory. The 125 ms and 5 MiB are the specification's
  figures for its minimal guest (1 vCPU, 128 MiB) on `.metal` test instances,
  not bounds for a chat's microVM, whose footprint and ready time are not
  measured; they do not transfer to a Nitro Sandbox.

## Questions for the operator

1. Must the company deployment run only in the company's own AWS account?
   Recommended: yes. That rules out Cloudflare Workers and Durable Objects.
2. Does a tenant chat get the `shell` function and the file functions, and on
   which machine? Recommended: not in the first version; later in a box for
   each tenant (an OS user in a container, or a microVM), never in the
   shared process.
3. What is a tenant, and whom must it be kept from: persons of one company,
   or separate companies? Recommended: persons of one company first, one
   process for each tenant; separate companies only with a container or a
   microVM for each.
4. Which "nitro vm" did you mean: AWS Nitro (Enclaves, or a microVM on Nitro
   such as Firecracker or Lambda MicroVMs), or UnJS Nitro? Recommended: read
   it as a Firecracker microVM, for the box of the shell, and measure it as a
   Nitro Sandbox first (no `.metal` instance needed).
5. Does the company use stay on Bun, with the same code as the local use?
   Recommended: yes. A port (Node, Deno, `workerd`) gives less than processes.
6. What may an idle tenant chat cost, and how long may a wake take?
   Recommended: no memory while idle (unloaded), and a wake under 1 s.
7. May a crash of one process end the loaded chats of one tenant together?
   Recommended: yes, because each chat restarts from its database.

## Words

| Term | Meaning |
| --- | --- |
| tenant | The person or group whose tenant chats share one box and its secrets, and are kept from others. |
| tenant chat | One chat (one log, one database) for one person or tenant in a company deployment: the operator's "agent". Not an agent in the glossary's sense. |
| idle chat | A tenant chat with no turn that runs. All its state is in its database. |
| isolation unit | What holds one or more chats and keeps them apart: a fiber, a thread, a process, an isolate, a container, a microVM. |
| fiber | Effect's light thread: many run on one JavaScript thread, and none is preempted while it computes. |
| isolate | One instance of the V8 engine with its own heap; one process can hold many (Cloudflare, `isolated-vm`). |
| microVM | A small virtual machine with its own kernel (Firecracker); a minimal one boots in a fraction of a second. |
| box | The machine or OS account where one tenant's shell commands and files run. |
