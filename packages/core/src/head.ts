// Head
// ====
// The part of a request before the messages: the system prompt and the tool
// list. Turns, compactions and subagents all send the same head, so that
// they share one cache prefix (packages/core/AGENTS.md, "One system prompt
// for every kind of request").
//
// The system prompt (prompt.ts) is the old one (ref/src/prompt.txt), with a
// section for a subagent task (the old `SUB` text in ref/src/tools.ts), the
// kind `asst`, and code mode in place of the list of tools. It names each
// kind of request and holds its rules. The block after the view says which
// kind a request is.
//
// The one tool is `run`: code mode. Its description says how a program
// gives its result, and lists the functions that a program can call, as
// TypeScript declarations. The caller gives the declarations: the list of
// its functions (functions.ts), in their order. A compaction has the tool
// in its head and does not use it: the prompt says so.
//
// A declaration has a hand-written signature (the program's own functions:
// the program calls them with a list of arguments) or JSON schemas (a
// function from outside: the program calls it with one object). The core
// checks a list where it is built (functions.ts, `refusals`).
//
// The head is text that the program owns, so it is part of the executable.
// The person sets two fields of it, and nothing more (packages/core/AGENTS.md,
// "One system prompt for every kind of request"): a name, which replaces
// "EverChat" in the fixed text (prompt.ts, `named`), and the person's own
// rules (a file that the config names), which go at its end. The fixed text
// cannot be replaced. With neither, the head has the bytes of a head with
// no field.

import { renderDeclarations } from "./codemode/declarations.ts"
import type { CodemodeJsonSchema, CodemodeTool } from "./codemode/types.ts"
import { NAME, named } from "./prompt.ts"
import type { Head } from "./request.ts"

// The name's members, for a host that checks a name before it gives one
// (the config file of packages/local): the package exports this module,
// and not prompt.ts.
export { NAME, NAME_MAX, nameFault } from "./prompt.ts"

// The name of the one tool.
export const TOOL = "run"

// A JSON Schema, as the renderer takes it.
export type JsonSchema = CodemodeJsonSchema

// A function as the head shows it (functions.ts). It has a `signature` or an
// `inputSchema`, not both and not neither (functions.ts, `refusals`).
export interface Declaration {
  readonly name: string
  readonly description: string
  // The parameter list and the return type, in TypeScript: the program
  // gives the function a list of arguments.
  readonly signature?: string
  // The schema of the one argument, an object, and the schema of the
  // result (`unknown` when there is none): shown as
  // `(args: <input>): Promise<<output>>`.
  readonly inputSchema?: JsonSchema
  readonly outputSchema?: JsonSchema
}

// A declaration as the sandbox's global: with a signature its arguments come
// as a list (`spread`), with schemas as the one object.
export const globalOf = (declaration: Declaration): Omit<CodemodeTool, "execute"> =>
  declaration.signature !== undefined
    ? { name: declaration.name, description: declaration.description, signature: declaration.signature, spread: true }
    : {
      name: declaration.name,
      description: declaration.description,
      ...(declaration.inputSchema === undefined ? {} : { inputSchema: declaration.inputSchema }),
      ...(declaration.outputSchema === undefined ? {} : { outputSchema: declaration.outputSchema }),
      spread: false
    }

const describe = (declarations: ReadonlyArray<Declaration>) =>
  `Runs a JavaScript program that you write, and returns its result.
The program is the body of an async function: use \`await\` and \`return\`.

- The result is what the program printed with console.log(), then the value that it returned: a string as it is, another value as JSON. A program that throws gives its error.
- A function gives its whole result to the program. You are shown only so much of the program's result: a long one is shortened to its head and its tail. So search, slice or parse in the program, and return only what you need.
- Call functions at the same time with Promise.all().
- Wait for every function with \`await\`: a function that still runs when the program ends is stopped.
- A program starts with nothing from the programs before it: no variables, no state.
- There are no timers, no fetch(), no require() and no modules. A program reaches the world only through these functions:

${renderDeclarations({ globals: declarations.map((one) => ({ ...globalOf(one), execute: () => undefined })) })}`

// The head for a chat. `declarations`: the functions that a program can
// call. `rules`: the person's own instructions, if any. `name`: the agent's
// name in the fixed text, "EverChat" when none; one that `nameFault`
// (prompt.ts) refuses throws.
export const head = (declarations: ReadonlyArray<Declaration>, rules: string | null = null, name: string = NAME): Head => {
  const prompt = named(name)
  return {
    system: rules === null || rules.trim() === "" ? prompt : prompt + "\n# The user's instructions\n\n" + rules.trim() + "\n",
    tools: [{ name: TOOL, description: describe(declarations) }]
  }
}
