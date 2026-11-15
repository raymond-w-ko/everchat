// The QuickJS file, imported `with { type: "file" }`: such an import gives
// the file's path. In the executable, that path is inside the executable,
// and Bun reads from it as from any file.

declare module "quickjs-wasi/quickjs.wasm" {
  const path: string
  export default path
}
