/**
 * Converts the JSON Schema an OpenAI client sends for a function into the Zod
 * shape the Agent SDK's `tool()` helper requires.
 *
 * Only the subset that appears in real tool definitions is handled; anything
 * unrecognised degrades to a permissive type rather than throwing, because
 * rejecting a request over an exotic schema keyword would be worse than passing
 * the parameter through loosely — the model still sees the description.
 */

import { z } from "zod";

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  default?: unknown;
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  nullable?: boolean;
  additionalProperties?: boolean | JsonSchema;
}

/** Guards against a self-referential schema turning into infinite recursion. */
const MAX_DEPTH = 12;

function primitive(schema: JsonSchema, type: string): z.ZodTypeAny {
  switch (type) {
    case "string": {
      let s = z.string();
      if (schema.minLength !== undefined) s = s.min(schema.minLength);
      if (schema.maxLength !== undefined) s = s.max(schema.maxLength);
      return s;
    }
    case "integer": {
      let n = z.number().int();
      if (schema.minimum !== undefined) n = n.min(schema.minimum);
      if (schema.maximum !== undefined) n = n.max(schema.maximum);
      return n;
    }
    case "number": {
      let n = z.number();
      if (schema.minimum !== undefined) n = n.min(schema.minimum);
      if (schema.maximum !== undefined) n = n.max(schema.maximum);
      return n;
    }
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    default:
      return z.unknown();
  }
}

/** One JSON Schema node to one Zod type. */
export function toZodType(schema: JsonSchema | undefined, depth = 0): z.ZodTypeAny {
  if (!schema || typeof schema !== "object" || depth > MAX_DEPTH) return z.unknown();

  // A literal value pins the parameter.
  if (schema.const !== undefined) return z.literal(schema.const as never);

  // Enums: strings become a native enum, mixed types a union of literals.
  if (Array.isArray(schema.enum) && schema.enum.length) {
    const values = schema.enum;
    if (values.every((v) => typeof v === "string")) {
      return z.enum(values as [string, ...string[]]);
    }
    return z.union(
      values.map((v) => z.literal(v as never)) as unknown as [z.ZodTypeAny, z.ZodTypeAny],
    );
  }

  const variants = schema.anyOf ?? schema.oneOf;
  if (variants?.length) {
    if (variants.length === 1) return toZodType(variants[0], depth + 1);
    return z.union(
      variants.map((v) => toZodType(v, depth + 1)) as unknown as [z.ZodTypeAny, z.ZodTypeAny],
    );
  }

  // allOf is only merged for the common object case; anything else falls back.
  if (schema.allOf?.length) {
    const merged: JsonSchema = { type: "object", properties: {}, required: [] };
    for (const part of schema.allOf) {
      if (part.properties) Object.assign(merged.properties!, part.properties);
      if (part.required) merged.required!.push(...part.required);
    }
    if (Object.keys(merged.properties!).length) return toZodType(merged, depth + 1);
    return z.unknown();
  }

  // A type array is JSON Schema's way of saying nullable or a union.
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((t) => t !== "null");
    const nullable = schema.type.includes("null");
    const base =
      types.length === 1
        ? toZodType({ ...schema, type: types[0] }, depth + 1)
        : z.union(
            types.map((t) =>
              toZodType({ ...schema, type: t }, depth + 1),
            ) as unknown as [z.ZodTypeAny, z.ZodTypeAny],
          );
    return nullable ? base.nullable() : base;
  }

  const type = schema.type;

  if (type === "object") {
    const shape = toZodShape(schema, depth + 1);
    const obj = z.object(shape);
    // Tool arguments frequently carry more than the schema names; keeping the
    // extra keys is friendlier than failing the call.
    return schema.additionalProperties === false ? obj.strict() : obj.passthrough();
  }

  if (type === "array") {
    const items = Array.isArray(schema.items) ? schema.items[0] : schema.items;
    return z.array(toZodType(items, depth + 1));
  }

  if (typeof type === "string") {
    const base = primitive(schema, type);
    return schema.nullable ? base.nullable() : base;
  }

  // No type at all: accept anything.
  return z.unknown();
}

/**
 * The top level of a function's parameters, as the raw shape `tool()` wants.
 * Non-required properties become optional so the model may omit them.
 */
export function toZodShape(
  schema: JsonSchema | undefined,
  depth = 0,
): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  if (!schema?.properties) return shape;

  const required = new Set(schema.required ?? []);

  for (const [name, prop] of Object.entries(schema.properties)) {
    let field = toZodType(prop, depth);
    if (prop?.description) field = field.describe(prop.description);
    if (prop?.default !== undefined) field = field.default(prop.default as never);
    shape[name] = required.has(name) ? field : field.optional();
  }

  return shape;
}
