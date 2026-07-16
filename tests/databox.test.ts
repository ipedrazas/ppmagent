import { describe, expect, test } from "bun:test";
import {
  buildCreateParams,
  buildCreateProjectParams,
  buildUpdateProjectParams,
  buildUpdateTaskParams,
  classifySearchQuery,
  isUuid,
  refFromUrl,
  taskRef,
} from "../src/tracker/databox.ts";

describe("refFromUrl", () => {
  test("parses the human identifier out of a Linear issue URL", () => {
    expect(refFromUrl("https://linear.app/tavon/issue/TAV-9/some-slug")).toBe("TAV-9");
  });

  test("returns empty for a non-issue or non-string url", () => {
    expect(refFromUrl("https://linear.app/tavon/project/abc")).toBe("");
    expect(refFromUrl(undefined)).toBe("");
    expect(refFromUrl(42)).toBe("");
  });
});

describe("taskRef", () => {
  test("prefers a projected identifier, then the URL, then the raw id", () => {
    expect(taskRef({ identifier: "ENG-1", url: "https://x/issue/ENG-2/s" })).toBe("ENG-1");
    expect(taskRef({ url: "https://x/issue/ENG-2/s" })).toBe("ENG-2");
    expect(taskRef({ id: "uuid-3" })).toBe("uuid-3");
    expect(taskRef({})).toBe("");
  });
});

describe("buildCreateParams", () => {
  test("sends only title + description by default (Databox pins team_id)", () => {
    expect(buildCreateParams({ title: "T", description: "D" })).toEqual({
      title: "T",
      description: "D",
    });
  });

  test("omits an empty description", () => {
    expect(buildCreateParams({ title: "T", description: "" })).toEqual({ title: "T" });
  });

  test("includes team_id only when an override is given", () => {
    expect(buildCreateParams({ title: "T", description: "D", team: "TAV" })).toEqual({
      title: "T",
      description: "D",
      team_id: "TAV",
    });
  });

  test("includes project_id, assignee_id, labels, and priority when given", () => {
    expect(
      buildCreateParams({
        title: "T",
        description: "D",
        project_id: "proj-uuid",
        assignee_id: "user-uuid",
        label_ids: ["bug-uuid"],
        priority: 2,
      }),
    ).toEqual({
      title: "T",
      description: "D",
      project_id: "proj-uuid",
      assignee_id: "user-uuid",
      label_ids: ["bug-uuid"],
      priority: 2,
    });
  });

  test("drops an empty label set and keeps priority 0", () => {
    expect(buildCreateParams({ title: "T", description: "", label_ids: [], priority: 0 })).toEqual({
      title: "T",
      priority: 0,
    });
  });
});

describe("buildUpdateTaskParams", () => {
  test("always sends issue_id and only the provided fields", () => {
    expect(buildUpdateTaskParams({ ref: "TAV-9", title: "New" })).toEqual({
      issue_id: "TAV-9",
      title: "New",
    });
  });

  test("sends a workflow status when given", () => {
    expect(buildUpdateTaskParams({ ref: "TAV-9", status: "In Progress" })).toEqual({
      issue_id: "TAV-9",
      status: "In Progress",
    });
  });

  test("maps ref to issue_id and includes status, project_id, labels, priority", () => {
    expect(
      buildUpdateTaskParams({
        ref: "TAV-9",
        description: "D",
        status: "Done",
        project_id: "proj-uuid",
        label_ids: ["bug-uuid"],
        priority: 1,
      }),
    ).toEqual({
      issue_id: "TAV-9",
      description: "D",
      status: "Done",
      project_id: "proj-uuid",
      label_ids: ["bug-uuid"],
      priority: 1,
    });
  });
});

describe("classifySearchQuery", () => {
  test("classifies a human task reference as a ref lookup", () => {
    expect(classifySearchQuery("TAV-41")).toEqual({ kind: "ref", ref: "TAV-41" });
    expect(classifySearchQuery("  tav-41  ")).toEqual({ kind: "ref", ref: "tav-41" });
    expect(classifySearchQuery("ENG-123")).toEqual({ kind: "ref", ref: "ENG-123" });
  });

  test("classifies a status:value / status=value query as a status filter", () => {
    expect(classifySearchQuery("status:Backlog")).toEqual({ kind: "status", status: "Backlog" });
    expect(classifySearchQuery("status: Backlog")).toEqual({ kind: "status", status: "Backlog" });
    expect(classifySearchQuery("STATUS=In Progress")).toEqual({
      kind: "status",
      status: "In Progress",
    });
  });

  test("classifies a bare known workflow status word as a status filter", () => {
    expect(classifySearchQuery("Backlog")).toEqual({ kind: "status", status: "Backlog" });
    expect(classifySearchQuery("done")).toEqual({ kind: "status", status: "done" });
    expect(classifySearchQuery("In Progress")).toEqual({ kind: "status", status: "In Progress" });
  });

  test("falls back to full-text search for everything else", () => {
    expect(classifySearchQuery("fix login bug")).toEqual({
      kind: "text",
      query: "fix login bug",
    });
    expect(classifySearchQuery("TAV-41 fix bug")).toEqual({
      kind: "text",
      query: "TAV-41 fix bug",
    });
    expect(classifySearchQuery("nonexistentstatusword")).toEqual({
      kind: "text",
      query: "nonexistentstatusword",
    });
  });
});

describe("isUuid", () => {
  test("recognises a UUID and rejects a team key", () => {
    expect(isUuid("0fe3a87d-a739-4e96-aa4c-d9b3812cb5cc")).toBe(true);
    expect(isUuid("TAV")).toBe(false);
  });
});

describe("buildCreateProjectParams", () => {
  test("sends name + resolved team_id, omitting unset optionals", () => {
    expect(buildCreateProjectParams({ name: "P", team: "TAV" }, "team-uuid")).toEqual({
      name: "P",
      team_id: "team-uuid",
    });
  });

  test("includes description, lead_id, and state when given", () => {
    expect(
      buildCreateProjectParams(
        { name: "P", team: "TAV", description: "D", lead: "lead-uuid", state: "started" },
        "team-uuid",
      ),
    ).toEqual({
      name: "P",
      team_id: "team-uuid",
      description: "D",
      lead_id: "lead-uuid",
      state: "started",
    });
  });
});

describe("buildUpdateProjectParams", () => {
  test("always sends project_id and only the provided fields", () => {
    expect(buildUpdateProjectParams({ id: "proj-uuid", state: "completed" })).toEqual({
      project_id: "proj-uuid",
      state: "completed",
    });
  });

  test("maps lead to lead_id and includes name + description", () => {
    expect(
      buildUpdateProjectParams({
        id: "proj-uuid",
        name: "New",
        description: "D",
        lead: "lead-uuid",
      }),
    ).toEqual({
      project_id: "proj-uuid",
      name: "New",
      description: "D",
      lead_id: "lead-uuid",
    });
  });
});
