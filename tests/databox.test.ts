import { describe, expect, test } from "bun:test";
import {
  buildCreateParams,
  buildCreateProjectParams,
  buildUpdateProjectParams,
  isUuid,
  toTrackerProject,
  toTrackerTask,
  toTrackerTeam,
} from "../src/tracker/databox.ts";

describe("toTrackerTask", () => {
  test("projects a raw Databox issue into neutral fields", () => {
    const task = toTrackerTask({
      id: "uuid-1",
      identifier: "ENG-123",
      title: "Email nudge",
      status: "Todo",
      team: "ENG",
      url: "https://linear.app/acme/issue/ENG-123",
      description: "ignored",
    });
    expect(task).toEqual({
      ref: "ENG-123",
      url: "https://linear.app/acme/issue/ENG-123",
      title: "Email nudge",
      status: "Todo",
      team: "ENG",
      id: "uuid-1",
    });
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
});

describe("toTrackerProject", () => {
  test("projects a raw Databox project into neutral fields", () => {
    const project = toTrackerProject({
      id: "uuid-1",
      name: "a2",
      url: "https://linear.app/acme/project/a2",
      description: "",
      status: "backlog",
      lead: "",
      teams: ["TAV"],
      progress: 0.25,
    });
    expect(project).toEqual({
      id: "uuid-1",
      name: "a2",
      url: "https://linear.app/acme/project/a2",
      status: "backlog",
      teams: ["TAV"],
      progress: 0.25,
    });
  });

  test("drops empty teams and keeps a zero progress", () => {
    const project = toTrackerProject({
      id: "uuid-2",
      name: "b",
      url: "u",
      teams: [],
      progress: 0,
    });
    expect(project.teams).toBeUndefined();
    expect(project.progress).toBe(0);
  });
});

describe("toTrackerTeam", () => {
  test("projects a raw Databox team into neutral fields", () => {
    expect(toTrackerTeam({ id: "uuid-1", key: "TAV", name: "Tavon", description: "" })).toEqual({
      id: "uuid-1",
      key: "TAV",
      name: "Tavon",
      description: undefined,
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
