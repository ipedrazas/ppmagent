import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTransformContext } from "../../src/memory/context.ts";
import { type ContextData, PpmClient, PpmError } from "../../src/memory/ppm.ts";
import { buildMemoryTools } from "../../src/memory/tools.ts";

// These tests drive the real `ppm` binary. They are skipped when ppm is not on
// PATH (e.g. a contributor without it) and run for real in CI, which installs it.
const ppmBin = Bun.which("ppm");
const PROJECT = "onboarding";

describe.skipIf(!ppmBin)("ppm integration", () => {
  let root: string;
  let ppm: PpmClient;

  beforeAll(async () => {
    // Temp root inside the repo to avoid sandboxed system-tmp restrictions.
    root = mkdtempSync(join(import.meta.dir, ".ppmroot-"));
    ppm = new PpmClient({ bin: ppmBin ?? "ppm", root });

    await ppm.run(["init"]);
    await ppm.projectCreate(PROJECT, "Onboarding drop-off");
    await ppm.write([
      "summary",
      "set",
      PROJECT,
      "--content",
      "Reduce onboarding drop-off via nudges.",
    ]);
    await ppm.write(["focus", "set", PROJECT, "--content", "Shipping the email nudge."]);
    await ppm.write([
      "decision",
      "add",
      PROJECT,
      "--content",
      "Email nudge first; cheap and testable.",
    ]);
    await ppm.write([
      "question",
      "add",
      PROJECT,
      "--name",
      "funnel",
      "--content",
      "Do funnel analytics exist?",
    ]);
    await ppm.write(["question", "add", PROJECT, "--content", "Who owns the metric?"]);
    await ppm.write([
      "task",
      "add",
      PROJECT,
      "--ref",
      "ENG-123",
      "--url",
      "https://linear.app/acme/issue/ENG-123",
      "--content",
      "Email nudge. Scope: email only.",
    ]);
    await ppm.write(["note", "add", PROJECT, "--content", "Misc note."]);
    await ppm.write(["conversation", "add", PROJECT, "--content", "User asked about onboarding."]);
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("project list includes the created project", async () => {
    const env = await ppm.projectList();
    expect(env.data.projects).toContain(PROJECT);
  });

  test("project show returns the entry shape", async () => {
    const { data } = await ppm.projectShow(PROJECT);
    expect(data.title).toBe("Onboarding drop-off");
    expect(data.counts.decision).toBe(1);
    expect(data.counts.question).toBe(2);
    expect(data.counts.task).toBe(1);
    const types = (data.entries ?? []).map((e) => e.type);
    expect(types).toContain("decision");
    expect(types).toContain("task");
  });

  test("read returns full entry content with frontmatter", async () => {
    const { data } = await ppm.read(PROJECT);
    expect(data.content).toContain("title: Onboarding drop-off");
  });

  test("search returns hits with provenance", async () => {
    const { data } = await ppm.search("nudge");
    expect(data.hits).not.toBeNull();
    expect((data.hits ?? []).some((h) => h.relPath.includes("tasks/eng-123"))).toBe(true);
  });

  test("a non-existent project surfaces as a thrown PpmError", async () => {
    let caught: unknown;
    try {
      await ppm.context("does-not-exist", 3);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PpmError);
    expect((caught as PpmError).message).toMatch(/not found/);
  });

  describe("context slice", () => {
    let ctx: ContextData;
    let message: string;

    beforeAll(async () => {
      const env = await ppm.context(PROJECT, 3);
      ctx = env.data;
      message = env.message;
    });

    test("full content for the cheap high-value entries", () => {
      expect(ctx.summary).toContain("Reduce onboarding drop-off");
      expect(ctx.focus).toContain("email nudge");
    });

    test("all open questions, resolved ones excluded", () => {
      const bodies = ctx.openQuestions.map((q) => q.body);
      expect(bodies).toContain("Who owns the metric?");
      // 'funnel' is still open here (we never resolved it in this suite)
      expect(ctx.openQuestions.length).toBe(2);
    });

    test("recent decisions are present", () => {
      expect(ctx.recentDecisions.length).toBe(1);
      expect(ctx.recentDecisions[0]?.body).toContain("Email nudge first");
    });

    test("everything else is available as shape", () => {
      const types = (ctx.shape.entries ?? []).map((e) => e.type);
      expect(types).toContain("note");
      expect(types).toContain("conversation");
      expect(ctx.shape.counts.task).toBe(1);
    });

    test("rendered message is the injectable slice", () => {
      expect(message).toContain("# summary");
      expect(message).toContain("### open questions");
      expect(message).toContain("### recent decisions");
      expect(message).toContain("### shape");
    });
  });

  describe("transformContext injection", () => {
    test("prepends the slice as a sentinel-tagged user message", async () => {
      const { hook: transform } = makeTransformContext({
        ppm,
        recent: 3,
        getActiveProject: () => PROJECT,
      });
      const out = await transform([{ role: "user", content: "hello", timestamp: 1 }]);
      expect(out.length).toBe(2);
      const first = out[0];
      expect(first && "role" in first && first.role).toBe("user");
      const injected = first && "content" in first ? String(first.content) : "";
      expect(injected).toContain("ppmagent:memory-context");
      expect(injected).toContain("Reduce onboarding drop-off");
    });

    test("replaces a prior injected slice instead of stacking", async () => {
      const { hook: transform } = makeTransformContext({
        ppm,
        recent: 3,
        getActiveProject: () => PROJECT,
      });
      const once = await transform([{ role: "user", content: "hello", timestamp: 1 }]);
      const twice = await transform(once);
      const injectedCount = twice.filter(
        (m) =>
          "content" in m &&
          typeof m.content === "string" &&
          m.content.includes("ppmagent:memory-context"),
      ).length;
      expect(injectedCount).toBe(1);
    });

    test("no active project leaves the transcript untouched", async () => {
      const { hook: transform } = makeTransformContext({
        ppm,
        recent: 3,
        getActiveProject: () => undefined,
      });
      const input = [{ role: "user" as const, content: "hi", timestamp: 1 }];
      const out = await transform(input);
      expect(out.length).toBe(1);
    });
  });

  describe("cross-cutting governance", () => {
    beforeAll(async () => {
      await ppm.projectUpdate({ project: PROJECT, addTags: ["growth"] });
      await ppm.standard({
        action: "add",
        id: "has-owner",
        title: "Has owner",
        check: "manual",
        severity: "warn",
        appliesTo: "tag:growth",
        content: "Every growth project names an owner.",
      });
      await ppm.initiative({
        action: "add",
        id: "q3-activation",
        title: "Q3 activation push",
        appliesTo: "tag:growth",
        content: "Lift activation across growth projects.",
      });
    });

    test("audit reports the manual standard as unknown and the initiative as unbound", async () => {
      const { data } = await ppm.audit({ project: PROJECT });
      const cells = data.matrix ?? [];
      const standard = cells.find((c) => c.concern === "has-owner");
      expect(standard?.status).toBe("unknown");
      const initiative = cells.find((c) => c.concern === "q3-activation");
      expect(initiative?.status).toBe("fail");
    });

    test("context slice carries the obligations", async () => {
      const env = await ppm.context(PROJECT, 3);
      expect(env.message).toContain("cross-cutting obligations");
      expect((env.data.standards ?? []).some((c) => c.concern === "has-owner")).toBe(true);
      expect((env.data.initiatives ?? []).some((c) => c.concern === "q3-activation")).toBe(true);
    });

    test("a verdict flips the standard's audit status", async () => {
      await ppm.verdict({
        standard: "has-owner",
        project: PROJECT,
        status: "pass",
        content: "Owner is the growth PM.",
      });
      const { data } = await ppm.audit({ standard: "has-owner", project: PROJECT });
      expect(data.matrix?.[0]?.status).toBe("pass");
    });

    test("binding the initiative flips its audit status", async () => {
      await ppm.initiative({
        action: "bind",
        id: "q3-activation",
        project: PROJECT,
        ref: "ENG-500",
        content: "Onboarding joins the activation push.",
      });
      const { data } = await ppm.audit({ initiative: "q3-activation", project: PROJECT });
      expect(data.matrix?.[0]?.status).toBe("pass");
      const show = await ppm.initiative({ action: "show", id: "q3-activation" });
      expect(show.data).toMatchObject({ boundCount: 1 });
    });

    test("a waived concern reports as waived", async () => {
      await ppm.standard({
        action: "add",
        id: "has-runbook",
        check: "manual",
        appliesTo: "tag:growth",
        content: "Every growth project has a runbook.",
      });
      await ppm.waive({
        concern: "has-runbook",
        project: PROJECT,
        reason: "Pure analytics project; nothing to operate.",
      });
      const { data } = await ppm.audit({ standard: "has-runbook", project: PROJECT });
      expect(data.matrix?.[0]?.status).toBe("waived");
    });

    test("a retired standard drops out of the audit", async () => {
      await ppm.standard({ action: "retire", id: "has-runbook" });
      const { data } = await ppm.audit({ project: PROJECT });
      expect((data.matrix ?? []).some((c) => c.concern === "has-runbook")).toBe(false);
    });
  });

  describe("memory tools over the real binary", () => {
    test("memory_list (no project) lists projects", async () => {
      const tools = buildMemoryTools(ppm);
      const listTool = tools.find((t) => t.name === "memory_list");
      const result = await listTool?.execute("call-1", {});
      const text = result?.content[0];
      expect(text && text.type === "text" && text.text).toContain(PROJECT);
    });

    test("memory_list (project) returns the shape", async () => {
      const tools = buildMemoryTools(ppm);
      const listTool = tools.find((t) => t.name === "memory_list");
      const result = await listTool?.execute("call-2", { project: PROJECT });
      const text = result?.content[0];
      expect(text && text.type === "text" && text.text).toContain("decision=1");
    });

    test("memory_write records a decision that shows up in context", async () => {
      const tools = buildMemoryTools(ppm);
      const writeTool = tools.find((t) => t.name === "memory_write");
      await writeTool?.execute("call-3", {
        project: PROJECT,
        type: "decision",
        content: "Defer the dashboard redesign until we have drop-off data.",
      });
      const { data } = await ppm.context(PROJECT, 5);
      const bodies = data.recentDecisions.map((d) => d.body);
      expect(bodies.some((b) => b.includes("Defer the dashboard redesign"))).toBe(true);
    });
  });
});
