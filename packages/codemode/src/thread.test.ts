// The four run cases (tests/cases.ts) on the thread engine (thread.ts): a
// QuickJS engine in a worker thread of its own for each program.

import { cases } from "../tests/cases.ts"
import { threadLayer } from "./thread.ts"

cases("thread", (limits) => threadLayer({ memory: limits.memory, compute: limits.compute }))
