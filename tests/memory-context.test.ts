import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { makeTransformContext } from "../src/memory/context.ts";
import type { PpmClient } from "../src/memory/ppm.ts";

const msg = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });

function fakePpm(body: string): PpmClient {
  return {
    context: async () => ({ message: body, data: {} as never, ok: true }),
  } as unknown as PpmClient;
}

describe("makeTransformContext — sliceTokens", () => {
  test("sliceTokens returns 0 before any injection", () => {
    const ctx = makeTransformContext({
      ppm: fakePpm("some memory content"),
      recent: 3,
      getActiveProject: () => "proj",
    });
    expect(ctx.sliceTokens()).toBe(0);
  });

  test("sliceTokens returns > 0 after a successful injection", async () => {
    const ctx = makeTransformContext({
      ppm: fakePpm("project context with many words to ensure tokens are counted"),
      recent: 3,
      getActiveProject: () => "proj",
    });
    await ctx.hook([msg("hello")]);
    expect(ctx.sliceTokens()).toBeGreaterThan(0);
  });

  test("sliceTokens resets to 0 when no project is active", async () => {
    let active: string | undefined = "proj";
    const ctx = makeTransformContext({
      ppm: fakePpm("some memory content here"),
      recent: 3,
      getActiveProject: () => active,
    });
    await ctx.hook([msg("hello")]);
    expect(ctx.sliceTokens()).toBeGreaterThan(0);

    active = undefined;
    await ctx.hook([msg("hello")]);
    expect(ctx.sliceTokens()).toBe(0);
  });

  test("sliceTokens resets to 0 when injection fails", async () => {
    const failPpm = {
      context: async () => {
        throw new Error("ppm unavailable");
      },
    } as unknown as PpmClient;
    const ctx = makeTransformContext({
      ppm: failPpm,
      recent: 3,
      getActiveProject: () => "proj",
    });
    await ctx.hook([msg("hello")]);
    expect(ctx.sliceTokens()).toBe(0);
  });

  test("sliceTokens reflects the most recent injection, not an earlier one", async () => {
    let body = "short";
    const dynamicPpm = {
      context: async () => ({ message: body, data: {} as never, ok: true }),
    } as unknown as PpmClient;
    const ctx = makeTransformContext({
      ppm: dynamicPpm,
      recent: 3,
      getActiveProject: () => "proj",
    });
    await ctx.hook([msg("hello")]);
    const first = ctx.sliceTokens();

    body = "a much longer body with many more words to drive the token count higher than before";
    await ctx.hook([msg("hello")]);
    const second = ctx.sliceTokens();

    expect(second).toBeGreaterThan(first);
  });
});
