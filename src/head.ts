// Head
// ====
// The part of a request before the messages: the system prompt and the tool
// list. Turns, compactions and subagents all send the same head, so that
// they share one cache prefix (AGENTS.md, "One system prompt for every kind
// of request").
//
// The system prompt (prompt.txt) is the old one (ref/src/prompt.txt), with a
// section for a subagent task (the old `SUB` text in ref/src/tools.ts), the
// kind `asst`, and code mode in place of the list of tools. It names each
// kind of request and holds its rules. The block after the view says which
// kind a request is.
//
// The one tool is `run`: code mode. Its description will list the functions
// that a program can call, once code mode is built. Until then it says only
// what the tool is. A compaction has the tool in its head and does not use
// it: the prompt says so.
//
// The head is text that the program owns, so it is part of the executable.
// The person's own rules (a file that the config names) go at its end.

import prompt from "./prompt.txt" with { type: "text" }
import type { Head } from "./request.ts"

// The name of the one tool.
export const TOOL = "run"

const description = `Runs a JavaScript program that you write, and returns what the program returns.
The program is the body of an async function: use \`await\` and \`return\`.`

// The head for a chat. `rules`: the person's own instructions, if any.
export const head = (rules: string | null = null): Head => ({
  system: rules === null || rules.trim() === "" ? prompt : prompt + "\n# The user's instructions\n\n" + rules.trim() + "\n",
  tools: [{ name: TOOL, description }]
})
