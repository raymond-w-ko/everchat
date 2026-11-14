EverChat must meet everturn's harness interface (AGENTS.md, "How EverChat
will be used"). Read these before you design a part that the factory
touches (the launch, the hooks, the shell, the transcript):

- `~/src/everturn/docs/decisions/0186-harness-interface.md`: the decision
  (ADR 0186).
- `~/src/everturn/packages/bridge/src/runtime/types.ts`: the interface,
  `SeatRuntime`.
- `~/src/everturn/docs/references/seat-runtime.md`: the requirements, R1 to
  R34.
