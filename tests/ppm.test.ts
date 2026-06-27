import { describe, expect, test } from "bun:test";
import { PpmError, buildWriteArgs, parseEnvelope } from "../src/memory/ppm.ts";

describe("parseEnvelope", () => {
  test("parses a successful envelope", () => {
    const env = parseEnvelope<{ projects: string[] }>(
      '{"ok":true,"message":"2 projects","data":{"projects":["a","b"]}}',
    );
    expect(env.ok).toBe(true);
    expect(env.message).toBe("2 projects");
    expect(env.data?.projects).toEqual(["a", "b"]);
  });

  test("parses an error envelope (ok:false) without throwing", () => {
    const env = parseEnvelope('{"ok":false,"message":"nope","data":null,"error":"boom"}');
    expect(env.ok).toBe(false);
    expect(env.error).toBe("boom");
  });

  test("tolerates surrounding whitespace", () => {
    const env = parseEnvelope('  \n{"ok":true,"message":"ok","data":1}\n  ');
    expect(env.data).toBe(1);
  });

  test("throws PpmError on empty output", () => {
    expect(() => parseEnvelope("")).toThrow(PpmError);
  });

  test("throws PpmError on non-JSON output", () => {
    expect(() => parseEnvelope("panic: not json")).toThrow(PpmError);
  });

  test("throws PpmError on JSON that is not an envelope", () => {
    expect(() => parseEnvelope('{"foo":1}')).toThrow(PpmError);
  });
});

describe("buildWriteArgs", () => {
  test("summary/focus are singleton replaces", () => {
    expect(buildWriteArgs({ project: "p", type: "summary", content: "s" })).toEqual([
      "summary",
      "set",
      "p",
      "--content",
      "s",
    ]);
    expect(buildWriteArgs({ project: "p", type: "focus", content: "f" })).toEqual([
      "focus",
      "set",
      "p",
      "--content",
      "f",
    ]);
  });

  test("decision add", () => {
    expect(buildWriteArgs({ project: "p", type: "decision", content: "d" })).toEqual([
      "decision",
      "add",
      "p",
      "--content",
      "d",
    ]);
  });

  test("question add with and without a name", () => {
    expect(
      buildWriteArgs({ project: "p", type: "question", content: "q", name: "funnel" }),
    ).toEqual(["question", "add", "p", "--name", "funnel", "--content", "q"]);
    expect(buildWriteArgs({ project: "p", type: "question", content: "q" })).toEqual([
      "question",
      "add",
      "p",
      "--content",
      "q",
    ]);
  });

  test("question resolve requires a name", () => {
    expect(
      buildWriteArgs({
        project: "p",
        type: "question",
        content: "a",
        name: "funnel",
        resolve: true,
      }),
    ).toEqual(["question", "resolve", "p", "funnel", "--content", "a"]);
    expect(() =>
      buildWriteArgs({ project: "p", type: "question", content: "a", resolve: true }),
    ).toThrow(PpmError);
  });

  test("task requires a ref and includes url when present", () => {
    expect(
      buildWriteArgs({ project: "p", type: "task", content: "t", ref: "ENG-1", url: "http://x" }),
    ).toEqual(["task", "add", "p", "--ref", "ENG-1", "--url", "http://x", "--content", "t"]);
    expect(buildWriteArgs({ project: "p", type: "task", content: "t", ref: "ENG-1" })).toEqual([
      "task",
      "add",
      "p",
      "--ref",
      "ENG-1",
      "--content",
      "t",
    ]);
    expect(() => buildWriteArgs({ project: "p", type: "task", content: "t" })).toThrow(PpmError);
  });
});
