import { describe, expect, test } from "bun:test";
import {
  PpmError,
  buildAuditArgs,
  buildInitiativeArgs,
  buildProjectUpdateArgs,
  buildStandardArgs,
  buildVerdictArgs,
  buildWaiveArgs,
  buildWriteArgs,
  parseEnvelope,
} from "../src/memory/ppm.ts";

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

describe("buildAuditArgs", () => {
  test("no params runs the full matrix", () => {
    expect(buildAuditArgs({})).toEqual(["audit"]);
  });

  test("all narrowing flags map through", () => {
    expect(
      buildAuditArgs({
        standard: "has-owner",
        initiative: "q3",
        check: "no-stale-questions:14d",
        tag: "infra",
        project: "p",
      }),
    ).toEqual([
      "audit",
      "--standard",
      "has-owner",
      "--initiative",
      "q3",
      "--check",
      "no-stale-questions:14d",
      "--tag",
      "infra",
      "--project",
      "p",
    ]);
  });
});

describe("buildStandardArgs", () => {
  test("list takes no id", () => {
    expect(buildStandardArgs({ action: "list" })).toEqual(["standard", "list"]);
  });

  test("show and retire require an id", () => {
    expect(buildStandardArgs({ action: "show", id: "s" })).toEqual(["standard", "show", "s"]);
    expect(buildStandardArgs({ action: "retire", id: "s" })).toEqual(["standard", "retire", "s"]);
    expect(() => buildStandardArgs({ action: "show" })).toThrow(PpmError);
  });

  test("add requires content and passes optional flags", () => {
    expect(
      buildStandardArgs({
        action: "add",
        id: "has-owner",
        content: "every project names an owner",
        title: "Has owner",
        check: "manual",
        severity: "block",
        appliesTo: "tag:infra",
      }),
    ).toEqual([
      "standard",
      "add",
      "has-owner",
      "--content",
      "every project names an owner",
      "--title",
      "Has owner",
      "--check",
      "manual",
      "--severity",
      "block",
      "--applies-to",
      "tag:infra",
    ]);
    expect(() => buildStandardArgs({ action: "add", id: "s" })).toThrow(PpmError);
  });
});

describe("buildInitiativeArgs", () => {
  test("list takes no id; other actions require one", () => {
    expect(buildInitiativeArgs({ action: "list" })).toEqual(["initiative", "list"]);
    expect(buildInitiativeArgs({ action: "show", id: "q3" })).toEqual(["initiative", "show", "q3"]);
    expect(() => buildInitiativeArgs({ action: "show" })).toThrow(PpmError);
  });

  test("add requires content", () => {
    expect(
      buildInitiativeArgs({
        action: "add",
        id: "q3",
        content: "harden the fleet",
        title: "Q3 hardening",
        appliesTo: "tag:infra",
      }),
    ).toEqual([
      "initiative",
      "add",
      "q3",
      "--content",
      "harden the fleet",
      "--title",
      "Q3 hardening",
      "--applies-to",
      "tag:infra",
    ]);
    expect(() => buildInitiativeArgs({ action: "add", id: "q3" })).toThrow(PpmError);
  });

  test("update requires status", () => {
    expect(buildInitiativeArgs({ action: "update", id: "q3", status: "paused" })).toEqual([
      "initiative",
      "update",
      "q3",
      "--status",
      "paused",
    ]);
    expect(() => buildInitiativeArgs({ action: "update", id: "q3" })).toThrow(PpmError);
  });

  test("bind requires project, ref, and content; url is optional", () => {
    expect(
      buildInitiativeArgs({
        action: "bind",
        id: "q3",
        project: "p",
        ref: "ENG-411",
        url: "http://x",
        content: "p joins q3",
      }),
    ).toEqual([
      "initiative",
      "bind",
      "q3",
      "p",
      "--ref",
      "ENG-411",
      "--url",
      "http://x",
      "--content",
      "p joins q3",
    ]);
    expect(() => buildInitiativeArgs({ action: "bind", id: "q3", ref: "ENG-411" })).toThrow(
      PpmError,
    );
    expect(() =>
      buildInitiativeArgs({ action: "bind", id: "q3", project: "p", content: "c" }),
    ).toThrow(PpmError);
  });
});

describe("buildVerdictArgs / buildWaiveArgs", () => {
  test("verdict maps standard, project, status, and rationale", () => {
    expect(
      buildVerdictArgs({ standard: "has-owner", project: "p", status: "pass", content: "ok" }),
    ).toEqual(["verdict", "has-owner", "p", "--status", "pass", "--content", "ok"]);
  });

  test("waive maps concern, project, and reason", () => {
    expect(buildWaiveArgs({ concern: "has-owner", project: "p", reason: "n/a here" })).toEqual([
      "waive",
      "has-owner",
      "p",
      "--content",
      "n/a here",
    ]);
  });
});

describe("buildProjectUpdateArgs", () => {
  test("maps every field, tags repeatable", () => {
    expect(
      buildProjectUpdateArgs({
        project: "p",
        status: "archived",
        title: "New title",
        addTags: ["infra", "web"],
        removeTags: ["old"],
        trackerSystem: "linear",
        trackerProject: "PMM",
        trackerUrl: "https://linear.app/x",
      }),
    ).toEqual([
      "project",
      "update",
      "p",
      "--status",
      "archived",
      "--title",
      "New title",
      "--tag",
      "infra",
      "--tag",
      "web",
      "--untag",
      "old",
      "--tracker-system",
      "linear",
      "--tracker-project",
      "PMM",
      "--tracker-url",
      "https://linear.app/x",
    ]);
  });

  test("rejects an update with nothing to change", () => {
    expect(() => buildProjectUpdateArgs({ project: "p" })).toThrow(PpmError);
    expect(() => buildProjectUpdateArgs({ project: "p", addTags: [] })).toThrow(PpmError);
  });
});
