// The host: the chats that it has loaded, each with its own stack, served
// over HTTP and WebSocket (docs/host.md, section 1). This entry,
// `@everchat/server`, will give `Host`, the service of the loaded chats, and
// `Host.layer(options)`; and `serve(options)`, the layer that serves the
// host's routes over the `HttpServer` in its context. Every build with HTTP
// uses it: `everchat serve` now, the server build later. Nothing is here yet.

export {}
