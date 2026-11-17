// The guard's view of the web standards that the server's files use beyond
// `ESNext` and the core's declarations (`../core/tsconfig.core.d.ts`), for
// the server's own program (tsconfig.json of this package) only. The guard
// has no Node and no Bun types. A new global goes here, in its smallest
// shape, never into a file of `src`.

// `crypto.randomUUID()`, for a new tenant's UUID in `src/backend.ts`, and
// `crypto.subtle.digest`, for the hash of the page's script in
// `src/page.ts`: Bun, Node and workerd have them.
declare var crypto: {
  randomUUID(): string
  readonly subtle: { digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer> }
}

// An import of an HTML file with `with { type: "text" }` (`src/page.ts`):
// the file's text.
declare module "*.html" {
  const text: string
  export default text
}
