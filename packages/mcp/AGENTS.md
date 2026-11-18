`packages/mcp/` (`@everchat/mcp`): the client of functions from outside (MCP).
The root `AGENTS.md` holds the rules for every file.

## Files and entries

- `packages/mcp/` (`@everchat/mcp`): the client of MCP servers, the
  functions from outside of a chat. It loads a server's definitions, checks
  them, and gives a chat's stack their declarations and their entries, of
  the core's shape; an entry calls the server's tool. The local connectors
  use it now, and the provider of a hosted deployment later. Its entry: `.`
  (`packages/mcp/src/client.ts`): `load`, its shapes and `DEFAULTS` (see
  "The load and the call").
- The tests of one module sit next to it, in `packages/mcp/src/`.

## What it is not

- No transport of its own: the caller gives one. Only `packages/local`
  imports the transport of a program on stdio; a hosted deployment gives
  its own.
- No store and no terminal: what a chat keeps, its stack keeps; what the
  person sees, the program that holds the client shows.
- No part of the core: the core does not know this package, and a chat
  with no server from outside runs with no line of it.

## Its libraries

Three, from the public npm registry (two for the sources, and one for
the tests only), each at an exact version in
`packages/mcp/package.json` (no caret, no tilde: a change of version is a
change of the manifest, reviewed as one):

- `@modelcontextprotocol/client` `2.4.0`, the official SDK of MCP: it
  speaks the protocol (the version's discovery, the list of a server's
  tools, a call) over the transport that the caller gives.
- `@earendil-works/pi-schema` `1.5.2`: EverChat's own check of what comes
  from outside, with JSON Schema: a server's definitions, the arguments
  of a call, and its result. It compiles only schemas that EverChat wrote
  or made: a form of a server's schema, never the schema as it came ("The
  form of a schema"). The SDK checks nothing of a call: the client gives
  it a check that takes every value.
- `@modelcontextprotocol/server` `2.4.0`, a `devDependencies` entry only:
  the server of the tests. Its tests import it; its sources never do.

The SDK's own dependencies: its manifest names `@modelcontextprotocol/core`
exactly (`2.4.0`), and the others (`zod`, `jose`, `cross-spawn`,
`eventsource`, `eventsource-parser`, `pkce-challenge`, and theirs) with
carets: `bun.lock` alone holds their versions.
Change one only with `bun install`, and read the lock's diff: each new or
changed package is a change of the supply chain. The root `package.json`
has no `trustedDependencies`, and none of these packages has an install
script (`preinstall`, `install`, `postinstall`; `bun pm untrusted` lists
none).

Never import `@modelcontextprotocol/client/stdio` here: that entry starts
a program as a child (it imports `cross-spawn`, `node:process` and
`node:stream`). Only `packages/local` imports it, and gives the client the
transport. No check of `just check` holds this rule: the reviews do (see
`docs/boundaries.md`, "A library's own imports").

## The load and the call

`client.ts` says each rule at its place; this is their summary.

**The load** (`load(servers, options)`): from a list of servers
(`Server`: a name, a function that makes the SDK's transport, the settings
`approval` and `tools`, and `marked`) to `Loaded`: `declarations` and
`entries` (`Outside`: the core's `Entry` with the server, the tool's own
name and its `_meta`) in one order, and every refusal (`Refused`: the server, the tool,
a sentence). It never fails, and no server can stop it:

- each server loads under one time limit for its connection, every page
  of its list of tools and the checks of its definitions (`load`, 10,000
  ms; G5): the checks run one definition for each step, with a yield
  between two, and a server whose checks have not ended in time is refused
  whole ("It did not load in N ms."). No step of one definition is
  long: G2, G4 and H4 bound it (H6). One that does not answer in time, or
  fails, gives no function and one refusal. Its close starts
  at once, and the load does not wait for it: the refusal is given as soon
  as the failure is known (a program on stdio may take the SDK's steps, up
  to 4 s, to end). The scope's end waits for that same close, under the
  same limit, and begins no second one; a close that fails changes
  nothing. The client pins the version of the protocol (`VERSION`);
- the list is asked page by page with the client's public `request`
  (`tools/list`), not with the SDK's `listTools` (G8), whose scan of each
  raw schema for `x-mcp-header` costs the depth squared and writes a
  dropped tool's text to the console: at most `PAGES` (64) pages; a cursor
  that comes again, or a 65th page, refuses the server ("Its list of tools
  failed."). A server that offers no tools gives no function and no
  refusal;
- the SDK's codec checks each page against its own schema of the protocol
  first: one malformed tool refuses that server's whole page, so the
  server gives no function and one refusal ("Its list of tools does not
  fit the protocol."; 2.4.0, lead, ec-x890l);
- the definitions are ordered by name (code units); nothing makes a JSON
  text of a definition or of a schema as the server sent it, nor of a
  form (G6). Two definitions of one server with one name are both refused
  ("Its name is given more than once by its server."); of two names that
  become one identifier (`a-b`, `a_b`) the first by name stays. A throw
  while one definition is handled (a `RangeError` too, also while its
  declaration is rendered, in its own step) refuses that tool ("It is not
  a definition of a tool."), and one while a server's list is handled
  refuses the server (G7): `load` never fails by what a server sent. A
  `default` 1,000,000 deep, which once threw there, is now left out of the
  shown schema with no read, as a list (H11);
- each definition is checked with `pi-schema`: its name, its description
  (at most 1,024 characters), the kind of its schemas; then each schema
  gets its form ("The form of a schema"), before anything else reads it.
  A fault refuses that tool only. At most `tools` definitions of one
  server (256), the first by name. The declaration that the model reads
  holds the shown schemas ("The shown schema"), never the schemas as they
  came (H1);
- a tool's setting (`Setting`: its own in `tools`, else its server's
  `approval`, else `auto`; a value that is no setting counts as `ask`):
  `deny` leaves it out with no refusal; `ask` lets it in with
  `approval: true` on its entry, so a program's call of it does not run
  and waits for a person's yes (the core's `Entry`; the gate is in
  `packages/codemode/src/calls.ts`, `invoke`); `auto` lets it in with no
  flag. The flag is not in the declaration: the head's bytes do not change
  with a setting;
- a server that is `marked` (the provider of a hosted deployment sets it;
  the local connectors do not) also gates a tool whose definition's
  `_meta` has the own key `io.everchat/approval` (`MARK`) with any value
  but `false` (`true`, `"yes"`, `1`, `null` all gate), whatever its
  setting but `deny`, which still leaves it out. Without `marked` the key
  is not read: a server cannot gate or ungate a tool of the local use by
  its definitions. The key is read after the definition's checks, which
  make `_meta` an object or nothing;
- the list is sorted by name; the core's check of a list (`refusals`)
  runs over the built-in functions (`beside`) and the list; then at most
  `count` functions (100) and at most `budget` characters of their
  rendered declarations together (32,768), and at most `HEAD_RENDER`
  (4,000,000) of their weights together (H9, "The shown schema"), checked
  in that order. So the render of the head at the launch reads the shown
  schemas of at most `count` kept functions, each within H4, and their sum
  within H9 (H6);
- each refusal is a warning of Effect's log, with the source `mcp`.

The connections live in the caller's scope, and close with it, all at one
time: the scope's end takes as long as the slowest close, not their sum.

**The call** (an entry's `run(args, caller)`):

- the arguments are `[object]`, checked with `pi-schema` against the
  form of the `inputSchema`, with no coercion, before anything is sent,
  under the bound of the check's work. A fault is a `FunctionError` with
  each fault's path and sentence;
- the SDK's `callTool`, with the tool's own name, under `call` (60,000
  ms), and with a signal that the interruption of the entry's effect
  aborts: when the program ends or is stopped, the request ends and the
  server is told it is cancelled. Calls on one connection run side by
  side, with no lock. Its options carry `toolDefinition`, a definition of
  EverChat's own (`{ name, inputSchema: { type: "object" } }`, G9): the SDK
  scans and compiles nothing of the server's, and asks no list again after
  a refusal of a header;
- each error is a `FunctionError` with the server's or the SDK's text: a
  result with `isError`, a refusal of the protocol (an unknown tool), the
  time limit, a connection that is gone (it names the server); a cause with
  no text (a null prototype) gives the ordinary sentence of a failed call.
  After a time limit the connection serves the next call; nothing connects
  again: the next load does;
- the result: with an `outputSchema`, its `structuredContent` must be
  there and pass EverChat's own check with `pi-schema` against the form of
  that schema, under the same bound, and the program gets the object (one
  nested so deep that the check or its JSON text overflows the stack is a
  `FunctionError` that names the server); with
  none, the text parts of `content`, one line each,
  and a part of another kind is one line that names its kind and its
  type, without its data;
- the cap: the result's text (the text, or the object's JSON text) of
  more than `hard` bytes (`HARD`, 64 MiB) is a `FunctionError` that says
  its size, refused and never cut with no way to the rest. Of more than
  `max` characters (`MAX`, 1,048,576), the entry gives a `Shortened` of
  the core: the call's row keeps its `whole`, and the program gets its
  head, a line that names `result(<call>, from, to)` and its tail
  (`given`), and reads the rest with `result(<call>, from, to)`. A
  `Shortened` is only ever the entry's whole value (`calls.ts` sees no
  other);
- an error's text from outside (the text of an `isError` result, the
  message of a refusal of the protocol or of the SDK, the list of a
  check's faults) has the same bounds: of more than `hard` bytes it is
  not shown, and the message has its size and the bound; of more than
  `max` characters it is cut to its first `max`, with a closing part that
  gives the whole count (of a list of faults, the count of all faults;
  the list is joined only until it is past `max`);
- nothing here writes the store: the call's row is `calls.ts`'s.

Four known limits. The SDK reads a whole answer into memory before any
bound here can act, so `hard` bounds what the program and the store get,
not what the process reads. An error's text past `max` has no way to the
rest: an error is a message, and a failed call keeps no whole text. And
EverChat sends no `Mcp-Param-*` header (G10): the `x-mcp-header` of a
tool's schema is not read, so a server over HTTP that asks for such a
header refuses the call, and the program gets that refusal. And the
candidates of a load (each form, shown schema and compiled check) are held
to the load's end, with no bound of their bytes: at the default `load`, 256
tools of 4,000 to 16,000 properties gave a peak of 549 to 671 MB
(ec-ghh1t); the person names the servers. The bound of a hosted
provider's answers, and of its load's memory, is the server plan's.

## The form of a schema

A server writes the schemas of its tools: they are input from outside. And
a check of a value is one synchronous step of `pi-schema`: no time limit,
no interruption and no test's deadline can end it once it runs, so one
schema could stop every chat of the process. So EverChat checks a value
only against a form of each schema that it made itself, at the load
(`formOf`, `checkOf` in `client.ts`), and neither `pi-schema` nor the SDK
gets a server's schema as it came (ec-b2xg6, the fix of the review
ec-hj0hr; its rulings are S1 to S9, S7a to S7c). The form is a new JSON
value, made by a walk of EverChat's own that knows the keywords: a key of
`properties` is a name, and the members of `enum` and the value of `const`
are data, never schemas. The model reads the shown schema that the same
walk makes ("The shown schema"), never the schema as it came.

- **References (S2).** The walk follows a `$ref` only when its text is `#`
  or `#/` and a JSON pointer (RFC 6901, `~0` and `~1`, after the fragment's
  percent escapes) in the same schema, whose target is an object or a
  boolean; under a schema with an `$id` (no fragment), a pointer starts
  there. A copy of the target's form takes the reference's place, and the
  keywords beside the `$ref` stay beside it (the copy joins their
  `allOf`): both hold. Any other `$ref`, a pointer that names nothing or no
  schema, `$dynamicRef` and `$recursiveRef` refuse the tool. The form holds
  no `$ref`, `$id`, `$anchor`, `$dynamicAnchor`, `$defs` or `definitions`.
- **No schema that holds itself (S3).** A reference to a schema that is
  being filled in refuses the tool, also when the way goes through
  `properties` or `items` (a tree, as a schema of a file tree has it). A
  limit that you meet: no simple rule tells a tree that is safe to check
  from one whose check doubles at each level of the value.
- **The size (G1, G2; in place of S4).** A part is one object, array,
  text, number, boolean or null of the form (a key is not one); the size
  of a JSON value is its parts and the UTF-16 units of all its texts and
  keys (`sizeOf`: no recursion, it stops past its bound). A form of more
  than `FORM` (50,000) parts, of a size of more than `FORM_SIZE`
  (1,000,000), or of more than `DEPTH` (64) schema levels (the levels of
  S7c) refuses the tool, with the sentence of a form too large. The walk
  counts as it goes and stops at the bound, so a schema that grows without
  a cycle (references that double at each step) never makes its copies,
  and a schema however deep is a refusal, never a defect.
- **The pairs (G4).** The library's compile looks a name up in a list by a
  scan at three places: each property of a schema in its `required`; for
  an `anyOf` or a `oneOf` (its tagged union), each property of the first
  branch in each branch's `required` and in the list of branches; for a
  `oneOf`, each `const` among those of the branches before it. These
  products, summed over the form, are at most `PAIRS` (1,000,000), or the
  tool is refused (too large): each compile is linear. The last two were
  found by the measure of each kept keyword at the bounds (ec-5y29u).
- **The keywords (S5).** Kept and checked: `type`, `enum`, `const`,
  `properties`, `required`, `additionalProperties`, `propertyNames`,
  `minProperties`, `maxProperties`, `dependentRequired`, `dependentSchemas`,
  `items` (one schema), `prefixItems`, `contains`, `minContains`,
  `maxContains`, `minItems`, `maxItems`, `unevaluatedProperties`,
  `unevaluatedItems`, `minLength`, `maxLength`, `minimum`, `maximum`,
  `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `allOf`, `anyOf`,
  `oneOf`, `not`, `if`, `then`, `else`. Every other keyword is left out, as
  an annotation is. Limits that you meet: `pattern`, `uniqueItems` and
  `format` are not checked (no bound of the work of the first two exists;
  the server's own check is the one that holds for them). Below `not`, `if`
  or `oneOf`, or in a `contains` that has a `maxContains`, a `pattern` or a
  `uniqueItems` refuses the tool, since leaving it out there could refuse a
  value that the schema takes; so do a list of `items` (draft 7), an
  `additionalItems` that is not `true`, a `dependencies` that is an object,
  and a `required` with an entry that is no text (ec-egsmp).
  `patternProperties` refuses the tool: a pattern decides there which schema
  a property takes. A kept keyword whose value is not of its kind is left
  out (a list of `items`, the old form of `prefixItems`, too); a schema's
  place that holds no object or boolean refuses the tool ("does not
  compile").
- **The SDK (S6).** The SDK's `Client` gets a `jsonSchemaValidator` that
  compiles nothing and takes every value, so EverChat's check on the form
  is the only one of a structured result. The SDK still says itself that
  a result of a tool with an output schema has no structured content.
- **The work of a check (S7, S7a, S7c).** Counted once at the load:
  the form's parts `P`, its text checks `T` (each `minLength`, each
  `maxLength`, and each text and key at any depth in a `const` or `enum`)
  and its depth `D` (the most schema levels on one way from its root, each
  keyword that holds a schema counted, a reference filled in too). For
  each value, one walk with no recursion counts its parts `V` and the
  UTF-16 units of its texts and keys `U`, and stops once past the bound.
  The plain check runs only when `P × V + T × U` is at most `work`
  (`WORK`, 100,000,000; an option of the load): over it, no check is run,
  and the arguments are refused with nothing sent, or the result fails
  the call, with a sentence that gives the counts and the bound.
- **The list of faults (G3; in place of the bound of S7b and S7c).** A
  value that the plain check refused gets the list of its faults only when
  (the form's size) × (`V + U`) × (`D + 1`) is at most `work`: the
  library's list copies the form's data (a `const`, an `enum`) and walks
  the value's texts at each failing place, on each level of its way down.
  Past that, the value is refused with a sentence that says the list was
  not made.
- **The sentences (S8).** Each refusal of the load names the schema ("Its
  input schema ...", "Its output schema ...") and keywords of EverChat's own
  lists only, never a text of the schema: a reference that EverChat does not
  follow; a schema that holds itself; a form too large or too deep;
  `patternProperties`; `pattern`, `uniqueItems`, a list of `items`,
  `additionalItems`, `dependencies` or a `required` with no text below
  `not`, `if`, `oneOf` or `contains`; a schema that does not compile; a
  shown schema whose size times its levels is past `RENDER` (H4).

## The shown schema

The renderer of the core's declarations (`declarations.ts`, adopted code)
reads parts of a schema that the form does not count (a `default` whole, a
list of `items`, each entry of a `type` list), in one synchronous step: a
schema as it came could make the step, and the head's render at the
launch, take minutes (ec-qvkk0, finding 1). So since ec-kfn3y the renderer
gets only a schema that EverChat made, with bounds that keep its work
small. The lead's rulings are H1 to H6, H5a, H9, H10 to H13 and H5b
(ec-jgam9), and H14 (ec-6ho3g):

- **No reader of a schema as it came (H1).** Once `fault` has made the
  forms, nothing reads the `inputSchema` or `outputSchema` of the
  definition again: not the core's `refusals`, not `renderDeclarations`,
  not the head, not the sandbox. The declaration's schemas are the shown
  schemas. The entry's `form` and `run` are as before.
- **The shown schema (H2).** The form (with no reference, the kept
  keywords with the kinds of their values, the references filled in), with,
  at each schema object, these annotations of the same object of the
  server's schema and nothing else: `description` when it is a text;
  `default` only as a scalar (**H11**, amending H2, ec-jgam9): a text, a
  number or a boolean whose size (G1: 1, and for a text 1 + its units) is
  at most `TAG` (80); a list, an object or null is left out with no read
  of what is in it (the walk once measured a list's size at each
  expansion of a reference: ec-ghh1t); `format` and `pattern`, each when it
  is a text of at most `TAG` units (as a tag only: the form and the check
  never get them); `uniqueItems` and `deprecated`, each when it is `true`.
  The annotations beside a `$ref` are those of the place: on the copy of
  the target they take the place of the target's own (a description
  beside a reference is the one shown; a reference to a boolean shows
  none). A `type` list has each entry one time, in the order of its first
  places. The places where `pattern` and `uniqueItems` refuse the tool are
  as before. The walk makes the form and the shown schema at once.
- **The form does not change (H3).** `compile`, `weigh`, G3 and the checks
  of a call get the form, with its counts and its size, and no
  annotation. One change: a `type` list of the form loses its repeated
  entries too (the same meaning). **H12** (amending H3's allowance): the
  walk counts one part for each entry of a `type` list as the server sent
  it, before it reads them, so a list past FORM is refused (too large)
  and no expansion reads a list that it does not count.
- **The walk reads only what it counts (H10).** In the walk (`schemaOf`,
  `annotate` and what they call), no step's work grows with a list, an
  object or a text of the server's that the walk has not counted toward
  FORM (a part for each entry) or toward the sizes (G1, H4) before or as
  it reads it. A text is taken by its reference and its length.
- **The kind test counts what it reads (H13).** The test of a kept
  keyword's kind (a `type` list, `required`, `dependentRequired`: each key
  and each entry of each list) counts one part for each entry as it reads
  it, and stops at the first entry not of its kind. So a long list is
  refused as too large at FORM, whether or not it is of its kind, and a
  value not of its kind is left out as before, with the parts of what was
  read counted. For a value of its kind the count is as before: no entry
  is counted two times (with H12 for a `type` list). H3 reads: the form's
  counts are as before for a schema whose kept keywords are of their
  kinds.
- **The keys of a server's object count at once (H14, ec-6ho3g).** The
  keys of an object (`Object.keys`) are the one read that cannot be
  counted before it. Where a later test can stop before each key is
  counted (`dependentRequired`, whose kind test stops at the first value
  that is no list of texts), the walk counts one part for every key in one
  step, right after the enumeration and before it reads a value, and is
  refused as too large past FORM; a key is not counted a second time. So
  an object not of its kind is left out with all its keys counted, and for
  one of its kind the counts are as before. Elsewhere each key is counted
  as its value is walked, or the walk is refused: `properties` and
  `dependentSchemas` (a schema for each key, which counts or refuses), and
  the data of `enum` and `const` (`dataOf` counts each value). So no
  expansion of a reference enumerates an object that it does not count.
- **The bounds of the shown schema (H4).** Its size (G1) is at most
  `FORM_SIZE`, counted as the walk puts each annotation, so the walk stops
  at the bound: past it the tool is refused with the sentence of a form
  too large. And its size times the form's levels (`D`) is at most
  `RENDER` (2,000,000), or the tool is refused ("... too large for
  EverChat to show ..."): each level of the rendered type copies the text
  below it, so the renderer's work is some constant times the size times
  the levels. Both are checked in `formOf`, before the compile and before
  the declaration is made.
- **What the model reads (H5).** For a schema that has no `$ref`, no list
  of `items`, no `type` list with a repeated entry, no `default` of a size
  past `TAG` or that is a list or an object, no `format` or `pattern`
  past `TAG` units or that is no text, no boolean `exclusiveMinimum` or `exclusiveMaximum`, and no kept
  keyword whose value is not of its kind (a keyword of a number takes a
  finite number: `1e400`, read as `Infinity`, is left out and gives no
  tag), the declaration's text is the
  same byte for byte as the render of the schema as it came. The accepted
  differences: a reference is filled in at every place (no stop at 32, and
  its target's siblings as the form joins them); a list of `items` shows
  as `unknown[]` (with `type: "array"`); the boolean form of
  `exclusiveMinimum` and `exclusiveMaximum` (draft 4) is not shown; a
  `type` list shows each type once; a long `default`, `format` or
  `pattern` gives no tag. **H5a** (the lead, on ec-kfn3y): a `format` or
  `pattern` whose value is no text gives no tag (a number there is no
  valid schema). **H5b** (the lead, on ec-jgam9): a `default` that is a
  list or an object gives no `@default` tag.
- **The step and the head (H6).** No step of one definition is long: G2,
  G4 and H4 bound it. The render at the launch reads the shown schemas of
  at most `count` kept functions, each within H4, and their sum within H9.
  The launch renders each kept function two times: in the head, and in
  the core's `refusals` of `make` (`packages/core/src/functions.ts`).
- **The bound of the whole list (H9).** A function's weight is the sum,
  over its input schema and its output schema (when it has one), of the
  shown schema's size times the form's levels (the two numbers of H4). In
  `bounded`, after `count` and `budget` and by their rule (the list's
  order; once a function passes a bound, it and every function after it
  are refused), the weights of the kept functions sum to at most
  `HEAD_RENDER` (4,000,000, two times `RENDER`: one function with both
  schemas at `RENDER` still fits): "Its schemas would pass the 4000000 of
  size times levels of the schemas of the functions from outside." Each
  render is some constant times its weight: 100 functions each at
  `RENDER` whose text the renderer drops at the top took 9.8 s to render
  in the head, and 5 of them (a bound of 10,000,000) up to 1.3 s
  (ec-kfn3y's measure). In an object of many lines each line gets 2 spaces
  a level, so a text of short lines costs about its lines times its levels
  squared; and with both schemas at `RENDER` one step was measured at 415
  to 529 ms (ec-ghh1t). An honest list is cut by `budget` long before.
- **The comparison (H7).** `client.test.ts` compares the render of the
  shown schema with the render of the schema as it came (the oracle) on
  schemas of H5's first sentence, from a seeded generator: 8 fixed seeds
  of 500 pairs each; a failure prints the seed and the schema.

## Its imports

The package's code imports `effect`, `@everchat/core` and the libraries
that its row names (the root `AGENTS.md`, "Be modular"), and nothing
else: no store, no wire, no engine, nothing of the local build or of the
server, and no module of Bun or of Node. So the same client serves the
local build and the server, and neither imports the other. Two checks hold
it. `tools/graph.ts`: the package's files (not its tests) may import no
built-in module, and must not reach `packages/local/`, `packages/openai/`,
`packages/sqlite/`, `packages/codemode/` or `packages/server/`; and the
core's row there forbids `packages/mcp/`, so the core does not reach it.
The type program `packages/mcp/tsconfig.json`: its files are checked with
no Bun and no Node types. The program lists the core's file of
declarations, `packages/core/tsconfig.core.d.ts`; a source that needs a
global beyond it gets a file of the package's own, never a declaration in
a source file. The type program passes what that file names, the core's
`node:crypto` too, and refuses only a module that none names: the list of
built-ins of `tools/graph.ts`, which gives the package's files none, is
what refuses each module of Bun or of Node there. Its tests may import any
of them, with the Bun types (`packages/mcp/tsconfig.test.json`).
