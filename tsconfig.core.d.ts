// The guard's view of the one Node module and the web standards that the
// core may use (tsconfig.core.json). The guard has no Node and no Bun types.

declare module "node:crypto" {
  interface Hash {
    update(data: string | Uint8Array): Hash
    copy(): Hash
    digest(encoding: "hex" | "base64"): string
  }
  export function createHash(algorithm: "sha256"): Hash
}

interface TextEncoder {
  encode(input?: string): Uint8Array
}
declare var TextEncoder: { new(): TextEncoder }

interface TextDecoder {
  decode(input?: Uint8Array): string
}
declare var TextDecoder: { new(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): TextDecoder }
