MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Upstream

The files of this directory are code of the library `@earendil-works/pi-codemode` 1.5.2, under the MIT license above: https://github.com/earendil-works/pi, directory `packages/codemode`, tag `v1.5.2`, commit `b4afdddf44e059c67ccf5097e5317d913521b470`.

- `declarations.ts`: `packages/codemode/src/declarations.ts`
- `identifier.ts`: `packages/codemode/src/identifier.ts`
- `types.ts`: `packages/codemode/src/types.ts`, its lines 3 to 109 and 200 to 204
- `declarations.test.ts`: `packages/codemode/test/declarations.test.ts`
- `LICENSE.md`: `LICENSE` (the text above)

## Local changes

- `types.ts` holds only the types of a tool, of a result, and `CodemodeDuring`: upstream's lines 3 to 109, an empty line, and its lines 200 to 204. Its import of `./wasm.ts` (line 1) is not here, and the rest of upstream's `types.ts` is in `packages/codemode/src/pi`.
- `types.ts`: `name?: string | undefined` and `stack?: string | undefined` on `CodemodeError` (upstream's `name?: string` and `stack?: string`), for this project's `exactOptionalPropertyTypes`. The JavaScript is the same.
- `declarations.ts`: `members[index]!` (upstream's `members[index]`), for this project's `noUncheckedIndexedAccess`. The JavaScript is the same.
- `declarations.test.ts`: on `node:test` and `node:assert/strict` instead of `vitest`, as the core's tests are; its import lines name `./declarations.ts` instead of `../src/index.ts`. Each case keeps its name, its input and its expected value: `toBe` is `assert.strictEqual`, `toBeUndefined` is `assert.strictEqual(..., undefined)`, `toContain` is `assert.ok(....includes(...))`.
- `identifier.ts`: no change.

The engine's part of the library is in `packages/codemode/src/pi`.
