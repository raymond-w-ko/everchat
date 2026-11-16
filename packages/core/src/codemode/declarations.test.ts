import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	renderDeclarations,
	renderToolSample,
	renderToolSignature,
	resolveSchemaRef,
	schemaToType,
} from "./declarations.ts";

const execute = () => undefined;

describe("schemaToType", () => {
	it("renders primitives, literals, and unions", () => {
		assert.strictEqual(schemaToType({ type: "string" }), "string");
		assert.strictEqual(schemaToType({ type: "integer" }), "number");
		assert.strictEqual(schemaToType({ type: ["string", "null"] }), "string | null");
		assert.strictEqual(schemaToType({ const: "a" }), '"a"');
		assert.strictEqual(schemaToType({ enum: ["a", 1, null] }), '"a" | 1 | null');
		assert.strictEqual(schemaToType({ anyOf: [{ type: "string" }, { type: "number" }] }), "string | number");
		assert.strictEqual(schemaToType({ anyOf: [{ type: "string" }, {}] }), "unknown");
		assert.strictEqual(
			schemaToType({ allOf: [{ anyOf: [{ type: "string" }, { type: "number" }] }, { const: 1 }] }),
			"(string | number) & 1",
		);
		assert.strictEqual(schemaToType({ $ref: "#/defs/x" }), "unknown");
		assert.strictEqual(schemaToType(true), "unknown");
		assert.strictEqual(schemaToType(false), "never");
	});

	it("renders objects on one line with sorted properties", () => {
		assert.strictEqual(
			schemaToType({
				type: "object",
				properties: { city: { type: "string" }, "max-lines": { type: "number" } },
				required: ["city"],
				additionalProperties: false,
			}),
			'{ city: string; "max-lines"?: number; }',
		);
		assert.strictEqual(
			schemaToType({ type: "object", additionalProperties: { type: "number" } }),
			"{ [key: string]: number; }",
		);
		assert.strictEqual(schemaToType({ type: "object" }), "{ [key: string]: unknown; }");
		assert.strictEqual(schemaToType({ type: "object", properties: {}, additionalProperties: false }), "{}");
	});

	it("puts property descriptions on comment lines", () => {
		assert.strictEqual(
			schemaToType({
				type: "object",
				properties: {
					weather: {
						type: "array",
						description: "look up weather for a given list of locations",
						items: { type: "object", properties: { location: { type: "string" } }, required: ["location"] },
					},
				},
				required: ["weather"],
			}),
			"{\n  // look up weather for a given list of locations\n  weather: Array<{ location: string; }>;\n}",
		);
		assert.strictEqual(
			schemaToType({
				type: "object",
				properties: {
					outer: {
						type: "object",
						description: "Outer",
						properties: { inner: { type: "string", description: "Inner" } },
					},
				},
			}),
			"{\n  // Outer\n  outer?: {\n    // Inner\n    inner?: string;\n  };\n}",
		);
	});

	// https://github.com/earendil-works/pi/issues/10707
	it("puts constraints the type cannot express on property comment lines", () => {
		assert.strictEqual(
			schemaToType({
				type: "object",
				properties: {
					timeoutMs: {
						type: "integer",
						minimum: 0,
						maximum: 30000,
						default: 0,
						description: "Wait in milliseconds.",
					},
					id: { type: "string", pattern: "^[a-z]+$", maxLength: 8 },
					tags: { type: "array", items: { type: "string" }, maxItems: 5, uniqueItems: true, deprecated: true },
					name: { type: "string" },
				},
				required: ["id"],
			}),
			[
				"{",
				"  // @maxLength 8 @pattern ^[a-z]+$",
				"  id: string;",
				"  name?: string;",
				"  // @maxItems 5 @uniqueItems @deprecated",
				"  tags?: Array<string>;",
				"  // Wait in milliseconds.",
				"  // @integer @minimum 0 @maximum 30000 @default 0",
				"  timeoutMs?: number;",
				"}",
			].join("\n"),
		);
	});

	it("reads constraints of optional fields from the non-null branch", () => {
		// Pydantic's `limit: int | None = Field(None, ge=1, le=100)`.
		assert.strictEqual(
			schemaToType({
				type: "object",
				properties: {
					limit: {
						anyOf: [{ type: "integer", minimum: 1, maximum: 100 }, { type: "null" }],
						default: null,
						title: "Limit",
					},
				},
			}),
			"{\n  // @integer @minimum 1 @maximum 100\n  limit?: number | null;\n}",
		);
		// Constraints of the property and the branch both apply.
		assert.strictEqual(
			schemaToType({
				type: "object",
				properties: {
					n: {
						anyOf: [{ type: "integer", minimum: 10, maximum: 50, format: "int32" }, { type: "null" }],
						minimum: 0,
						maximum: 20,
						format: "port",
					},
				},
			}),
			"{\n  // @integer @minimum 10 @maximum 20 @format port @format int32\n  n?: number | null;\n}",
		);
	});

	it("reads draft-04 boolean exclusive bounds", () => {
		assert.strictEqual(
			schemaToType({
				type: "object",
				properties: {
					n: { type: "integer", minimum: 0, exclusiveMinimum: true, maximum: 10, exclusiveMaximum: false },
					m: { anyOf: [{ type: "number", maximum: 5, exclusiveMaximum: true }, { type: "null" }], maximum: 8 },
				},
			}),
			[
				"{",
				"  // @maximum 8 @exclusiveMaximum 5",
				"  m?: number | null;",
				"  // @integer @exclusiveMinimum 0 @maximum 10",
				"  n?: number;",
				"}",
			].join("\n"),
		);
	});

	it("leaves out long tags and escapes line terminators", () => {
		assert.strictEqual(
			schemaToType({
				type: "object",
				properties: { config: { type: "object", default: { text: "x".repeat(100) } } },
			}),
			"{ config?: { [key: string]: unknown; }; }",
		);
		assert.strictEqual(
			schemaToType({
				type: "object",
				properties: {
					sep: { type: "string", pattern: "^[\r\n\u2028\u2029]$", default: "\u2028", description: "a\u2028b" },
				},
			}),
			[
				"{",
				"  // a",
				"  // b",
				'  // @pattern ^[\\u000d\\u000a\\u2028\\u2029]$ @default "\\u2028"',
				"  sep?: string;",
				"}",
			].join("\n"),
		);
	});

	it("drops constraint tags before rendering a type over the budget as unknown", () => {
		const schema = { type: "object", properties: { n: { type: "integer", minimum: 1 } } };
		assert.strictEqual(schemaToType(schema), "{\n  // @integer @minimum 1\n  n?: number;\n}");
		assert.strictEqual(schemaToType(schema, { maxChars: 20 }), "{ n?: number; }");
		assert.strictEqual(schemaToType(schema, { maxChars: 10 }), "unknown");
	});

	it("resolves local references and stops at recursive ones", () => {
		const schema = {
			type: "object",
			properties: {
				item: { $ref: "#/$defs/Item" },
				legacy: { $ref: "#/definitions/Legacy" },
				remote: { $ref: "https://example.com/schema.json" },
			},
			required: ["item"],
			$defs: {
				Item: {
					type: "object",
					properties: { id: { type: "string" }, parent: { $ref: "#/$defs/Item" } },
					required: ["id"],
				},
			},
			definitions: { Legacy: { enum: ["a", "b"] } },
		};
		assert.strictEqual(
			schemaToType(schema),
			'{ item: { id: string; parent?: unknown; }; legacy?: "a" | "b"; remote?: unknown; }',
		);
	});

	it("renders arrays and tuples", () => {
		assert.strictEqual(schemaToType({ type: "array", items: { type: "string" } }), "Array<string>");
		assert.strictEqual(
			schemaToType({ type: "array", prefixItems: [{ type: "string" }, { type: "number" }] }),
			"[string, number]",
		);
		assert.strictEqual(schemaToType({ type: "array" }), "unknown[]");
	});

	it("renders types over the budget as unknown", () => {
		const properties = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`field${i}`, { type: "string" }]));
		const schema = { type: "object", properties };
		assert.strictEqual(schemaToType(schema, { maxChars: 100 }), "unknown");
		assert.ok(schemaToType(schema).includes("field49?: string;"));
	});
});

describe("resolveSchemaRef", () => {
	const item = { type: "string" };
	const root = { $defs: { item, "a/b": item, "c~d": item, "e f": item } };

	it("resolves local references with escaped segments", () => {
		assert.strictEqual(resolveSchemaRef("#", root), root);
		assert.strictEqual(resolveSchemaRef("#/$defs/item", root), item);
		assert.strictEqual(resolveSchemaRef("#/$defs/a~1b", root), item);
		assert.strictEqual(resolveSchemaRef("#/$defs/c~0d", root), item);
		assert.strictEqual(resolveSchemaRef("#/$defs/e%20f", root), item);
	});

	it("returns undefined for remote, missing, and malformed references", () => {
		assert.strictEqual(resolveSchemaRef("other.json#/$defs/item", root), undefined);
		assert.strictEqual(resolveSchemaRef("#/$defs/missing", root), undefined);
		assert.strictEqual(resolveSchemaRef("#/$defs/%E0%A4%A", root), undefined);
	});
});

describe("tool declarations", () => {
	it("renders signatures with normalized identifiers", () => {
		assert.strictEqual(
			renderToolSignature({
				name: "hidden-dynamic-tool",
				inputSchema: {
					type: "object",
					properties: { city: { type: "string" } },
					required: ["city"],
					additionalProperties: false,
				},
				outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
			}),
			"hidden_dynamic_tool(args: { city: string; }): Promise<{ ok: boolean; }>;",
		);
		assert.strictEqual(renderToolSignature({ name: "free" }), "free(args: unknown): Promise<unknown>;");
	});

	it("renders output schemas shaped like an MCP CallToolResult as plain types", () => {
		const outputSchema = {
			type: "object",
			properties: {
				content: { type: "array", items: { type: "object" } },
				isError: { type: "boolean" },
				_meta: { type: "object" },
			},
			required: ["content"],
		};
		assert.strictEqual(
			renderToolSignature({ name: "plain", inputSchema: { type: "object", properties: {} }, outputSchema }),
			"plain(args: { [key: string]: unknown; }): Promise<{ _meta?: { [key: string]: unknown; }; content: Array<{ [key: string]: unknown; }>; isError?: boolean; }>;",
		);
	});

	it("renders the per-tool sample", () => {
		assert.strictEqual(
			renderToolSample({ name: "foo", description: "bar", inputSchema: { type: "string" } }),
			"bar\n\ncodemode tool declaration:\n```ts\ndeclare const tools: { foo(args: string): Promise<unknown>; };\n```",
		);
	});
});

describe("renderDeclarations", () => {
	it("renders tools and globals", () => {
		const text = renderDeclarations({
			tools: [
				{
					name: "read",
					description: "Read a file.\nSecond line.",
					inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
					outputSchema: { type: "string" },
					execute,
				},
				{ name: "remote-api", execute },
			],
			globals: [{ name: "attach", description: "Attach it.", inputSchema: { type: "string" }, execute }],
		});
		assert.strictEqual(
			text,
			[
				"declare const tools: {",
				"  /**",
				"   * Read a file.",
				"   * Second line.",
				"   */",
				"  read(args: { path: string; }): Promise<string>;",
				"  remote_api(args: unknown): Promise<unknown>;",
				"};",
				"",
				"/** Attach it. */",
				"declare function attach(args: string): Promise<unknown>;",
			].join("\n"),
		);
	});

	it("renders namespaced globals and explicit signatures", () => {
		const text = renderDeclarations({
			globals: [
				{
					name: "models.list",
					description: "List models.",
					signature: "(type: string): Promise<string[]>",
					execute,
				},
				{ name: "models.get", inputSchema: { type: "string" }, execute },
				{ name: "plain", signature: "(): void", execute },
			],
		});
		assert.strictEqual(
			text,
			[
				"declare function plain(): void;",
				"",
				"declare const models: {",
				"  /** List models. */",
				"  list(type: string): Promise<string[]>;",
				"  get(args: string): Promise<unknown>;",
				"};",
			].join("\n"),
		);
	});

	it("escapes comment terminators in descriptions", () => {
		const text = renderDeclarations({ tools: [{ name: "x", description: "a */ b", execute }] });
		assert.ok(text.includes("/** a *\\/ b */"));
	});
});
