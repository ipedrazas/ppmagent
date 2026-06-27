import { describe, expect, test } from "bun:test";
import { buildCreateParams, toTrackerTask } from "../src/tracker/databox.ts";

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
