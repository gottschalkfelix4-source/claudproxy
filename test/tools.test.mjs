/**
 * Tests for the JSON Schema -> Zod conversion the Agent SDK's tool() requires.
 *
 * Fixtures mirror what real OpenAI clients send: nested objects, enums, arrays,
 * optional fields and the odd schema keyword that must not blow up the request.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { toZodShape, toZodType } from "../dist/jsonSchemaToZod.js";

const parse = (shape, value) => z.object(shape).parse(value);

test("required fields stay required, others become optional", () => {
  const shape = toZodShape({
    type: "object",
    properties: { city: { type: "string" }, unit: { type: "string" } },
    required: ["city"],
  });

  assert.deepEqual(parse(shape, { city: "Berlin" }), { city: "Berlin" });
  assert.throws(() => parse(shape, {}), /city/);
});

test("maps the primitive types", () => {
  const shape = toZodShape({
    type: "object",
    properties: {
      s: { type: "string" },
      n: { type: "number" },
      i: { type: "integer" },
      b: { type: "boolean" },
    },
    required: ["s", "n", "i", "b"],
  });

  assert.deepEqual(parse(shape, { s: "x", n: 1.5, i: 2, b: true }), {
    s: "x",
    n: 1.5,
    i: 2,
    b: true,
  });
  assert.throws(() => parse(shape, { s: "x", n: 1.5, i: 2.5, b: true }));
});

test("string enums are constrained", () => {
  const shape = toZodShape({
    type: "object",
    properties: { unit: { type: "string", enum: ["celsius", "fahrenheit"] } },
    required: ["unit"],
  });

  assert.deepEqual(parse(shape, { unit: "celsius" }), { unit: "celsius" });
  assert.throws(() => parse(shape, { unit: "kelvin" }));
});

test("handles arrays, including arrays of objects", () => {
  const shape = toZodShape({
    type: "object",
    properties: {
      tags: { type: "array", items: { type: "string" } },
      people: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
    },
    required: ["tags", "people"],
  });

  const value = { tags: ["a", "b"], people: [{ name: "Ada" }] };
  assert.deepEqual(parse(shape, value), value);
  assert.throws(() => parse(shape, { tags: [1], people: [] }));
});

test("nested objects keep their own required fields", () => {
  const shape = toZodShape({
    type: "object",
    properties: {
      location: {
        type: "object",
        properties: { lat: { type: "number" }, lon: { type: "number" } },
        required: ["lat", "lon"],
      },
    },
    required: ["location"],
  });

  assert.deepEqual(parse(shape, { location: { lat: 1, lon: 2 } }), {
    location: { lat: 1, lon: 2 },
  });
  assert.throws(() => parse(shape, { location: { lat: 1 } }));
});

test("a type array means nullable", () => {
  const shape = toZodShape({
    type: "object",
    properties: { note: { type: ["string", "null"] } },
    required: ["note"],
  });

  assert.deepEqual(parse(shape, { note: null }), { note: null });
  assert.deepEqual(parse(shape, { note: "hi" }), { note: "hi" });
});

test("anyOf becomes a union", () => {
  const t = toZodType({ anyOf: [{ type: "string" }, { type: "number" }] });
  assert.equal(t.parse("a"), "a");
  assert.equal(t.parse(2), 2);
  assert.throws(() => t.parse(true));
});

test("defaults are applied when the field is absent", () => {
  const shape = toZodShape({
    type: "object",
    properties: { unit: { type: "string", default: "celsius" } },
  });
  assert.deepEqual(parse(shape, {}), { unit: "celsius" });
});

test("extra keys survive unless additionalProperties is false", () => {
  const open = toZodType({
    type: "object",
    properties: { a: { type: "string" } },
  });
  assert.deepEqual(open.parse({ a: "x", extra: 1 }), { a: "x", extra: 1 });

  const strict = toZodType({
    type: "object",
    properties: { a: { type: "string" } },
    additionalProperties: false,
  });
  assert.throws(() => strict.parse({ a: "x", extra: 1 }));
});

test("an empty or absent schema accepts anything, rather than failing the call", () => {
  assert.deepEqual(toZodShape(undefined), {});
  assert.deepEqual(toZodShape({ type: "object" }), {});
  assert.equal(toZodType({}).parse("whatever"), "whatever");
  assert.equal(toZodType({ type: "surprise" }).parse(42), 42);
});

test("a self-referential schema terminates instead of recursing forever", () => {
  const node = { type: "object", properties: {} };
  node.properties.child = node;
  // Must not throw a stack overflow.
  assert.doesNotThrow(() => toZodShape(node));
});

test("descriptions are carried into the schema for the model to read", () => {
  const shape = toZodShape({
    type: "object",
    properties: { city: { type: "string", description: "City name" } },
    required: ["city"],
  });
  assert.equal(shape.city.description, "City name");
});
