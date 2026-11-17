// The `.` entry of `@everchat/server` (docs/host.md, section 1, the table of
// entries): each name of host.ts (`Host`, `Host.layer`, `HostOptions` and
// the errors of a message in), `serve`, the layer of the routes, and
// `serverOptions`, the numbers of the server that `serve` runs on (serve.ts).

export * from "./host.ts"
export { serve, serverOptions } from "./serve.ts"
