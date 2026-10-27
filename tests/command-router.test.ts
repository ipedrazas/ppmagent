import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { SessionState, SessionStore } from "../src/session/store.ts";
import { ChatSession } from "../src/telegram/chat-session.ts";
import { CommandRouter, parseCommand } from "../src/telegram/command-router.ts";
import { makeTestConfig } from "./support/config.ts";
import { type FauxAgent, makeFauxAgent } from "./support/faux-agent.ts";

function memStore(seed?: SessionState): SessionStore {
  let current = seed ?? null;
  return {
    load: () => current,
    save: (s: SessionState) => {
      current = s;
    },
    list: () => (current ? [{ ...current }] : []),
    find: () => undefined,
  } as unknown as SessionStore;
}

const agents: FauxAgent[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((a) => a.close()));
});

/** A CommandRouter wired to a real ChatSession, capturing what it sends. */
async function makeRouter() {
  const sent: Array<{ chatId: number; messages: string[] }> = [];
  const config = makeTestConfig();
  const session = new ChatSession(config, { store: memStore() });
  const agent = await makeFauxAgent(config);
  agents.push(agent);
  session.attach(agent.built);
  const router = new CommandRouter({
    session,
    config,
    send: async (chatId, messages) => {
      sent.push({ chatId, messages });
    },
    abortSignal: new AbortController().signal,
  });
  return { router, session, sent, agent };
}

describe("parseCommand", () => {
  test("parses a simple command", () => {
    expect(parseCommand("/project foo")).toEqual({ cmd: "project", arg: "foo" });
  });

  test("strips @botname from group chat commands", () => {
    expect(parseCommand("/project@mybot foo")).toEqual({ cmd: "project", arg: "foo" });
  });

  test("returns null for non-command text", () => {
    expect(parseCommand("hello world")).toBeNull();
  });

  test("handles command with no argument", () => {
    expect(parseCommand("/help")).toEqual({ cmd: "help", arg: "" });
  });

  test("handles @botname with no argument", () => {
    expect(parseCommand("/help@mybot")).toEqual({ cmd: "help", arg: "" });
  });
});

describe("CommandRouter.route", () => {
  test("returns null for a non-command message (caller runs it as a turn)", async () => {
    const { router, sent } = await makeRouter();
    expect(await router.route(1, "just a normal message")).toBeNull();
    expect(sent).toHaveLength(0); // nothing sent — it's not a command
  });

  test("/help returns and sends the command list", async () => {
    const { router, sent } = await makeRouter();
    const replies = await router.route(1, "/help");
    expect(replies?.[0]).toContain("/project");
    expect(replies?.[0]).toContain("/cancel");
    expect(sent.at(-1)?.messages[0]).toContain("Available commands:");
  });

  test("/project sets the active project on the session", async () => {
    const { router, session } = await makeRouter();
    const replies = await router.route(1, "/project onboarding");
    expect(replies?.[0]).toContain("onboarding");
    expect(session.activeProject).toBe("onboarding");
  });

  test("/project with no slug reports usage and does not change the project", async () => {
    const { router, session } = await makeRouter();
    const replies = await router.route(1, "/project");
    expect(replies?.[0]).toContain("Usage: /project");
    expect(session.activeProject).toBeUndefined();
  });

  test("/project@botname slug (group chat form) sets the active project", async () => {
    const { router, session } = await makeRouter();
    const replies = await router.route(1, "/project@mybot onboarding");
    expect(replies?.[0]).toContain("onboarding");
    expect(session.activeProject).toBe("onboarding");
  });

  test("/help@botname (group chat form) returns the command list", async () => {
    const { router } = await makeRouter();
    const replies = await router.route(1, "/help@mybot");
    expect(replies?.[0]).toContain("Available commands:");
  });

  test("unknown command in group chat form (/unknown@botname) returns null", async () => {
    const { router } = await makeRouter();
    expect(await router.route(1, "/unknown@mybot")).toBeNull();
  });
});

describe("CommandRouter — /describe", () => {
  test("defaults to off", async () => {
    const { session } = await makeRouter();
    expect(session.describeEnabled).toBe(false);
  });

  test("with no argument, toggles the current state", async () => {
    const { router, session } = await makeRouter();
    let replies = await router.route(1, "/describe");
    expect(session.describeEnabled).toBe(true);
    expect(replies?.[0]).toContain("ON");

    replies = await router.route(1, "/describe");
    expect(session.describeEnabled).toBe(false);
    expect(replies?.[0]).toContain("OFF");
  });

  test("/describe on enables it explicitly", async () => {
    const { router, session } = await makeRouter();
    const replies = await router.route(1, "/describe on");
    expect(session.describeEnabled).toBe(true);
    expect(replies?.[0]).toContain("ON");
  });

  test("/describe off disables it explicitly", async () => {
    const { router, session } = await makeRouter();
    await router.route(1, "/describe on");
    const replies = await router.route(1, "/describe off");
    expect(session.describeEnabled).toBe(false);
    expect(replies?.[0]).toContain("OFF");
  });

  test("/describe@botname (group chat form) toggles it", async () => {
    const { router, session } = await makeRouter();
    await router.route(1, "/describe@mybot on");
    expect(session.describeEnabled).toBe(true);
  });

  test("an invalid argument reports usage without changing state", async () => {
    const { router, session } = await makeRouter();
    const replies = await router.route(1, "/describe maybe");
    expect(replies?.[0]).toContain("Usage: /describe");
    expect(session.describeEnabled).toBe(false);
  });

  test("/help lists /describe", async () => {
    const { router } = await makeRouter();
    const replies = await router.route(1, "/help");
    expect(replies?.[0]).toContain("/describe");
  });
});

describe("CommandRouter — /explain", () => {
  test("with no argument, prompts the user to specify a command", async () => {
    const { router } = await makeRouter();
    const replies = await router.route(1, "/explain");
    expect(replies?.[0]).toContain("Usage: /explain");
  });

  test("explains a known command with usage and an example", async () => {
    const { router } = await makeRouter();
    const replies = await router.route(1, "/explain describe");
    expect(replies?.[0]).toContain("/describe");
    expect(replies?.[0]).toContain("Usage: /describe");
    expect(replies?.[0]).toContain("Example:");
  });

  test("accepts a leading slash on the command name", async () => {
    const { router } = await makeRouter();
    const replies = await router.route(1, "/explain /tools");
    expect(replies?.[0]).toContain("/tools");
  });

  test("is case-insensitive", async () => {
    const { router } = await makeRouter();
    const replies = await router.route(1, "/explain DESCRIBE");
    expect(replies?.[0]).toContain("/describe");
  });

  test("an unknown command returns an error listing available commands", async () => {
    const { router } = await makeRouter();
    const replies = await router.route(1, "/explain bogus");
    expect(replies?.[0]).toContain('Unknown command "/bogus"');
    expect(replies?.[0]).toContain("help");
    expect(replies?.[0]).toContain("tools");
  });

  test("/help lists /explain", async () => {
    const { router } = await makeRouter();
    const replies = await router.route(1, "/help");
    expect(replies?.[0]).toContain("/explain");
  });

  test("/explain@botname (group chat form) explains the command", async () => {
    const { router } = await makeRouter();
    const replies = await router.route(1, "/explain@mybot tools");
    expect(replies?.[0]).toContain("/tools");
  });
});

describe("CommandRouter — /cmds", () => {
  test("lists every registered command", async () => {
    const { router } = await makeRouter();
    const replies = await router.route(1, "/cmds");
    expect(replies?.[0]).toContain("/project");
    expect(replies?.[0]).toContain("/describe");
    expect(replies?.[0]).toContain("/explain");
    expect(replies?.[0]).toContain("/cmds");
  });

  test("new commands appear automatically without extra wiring", async () => {
    const { router } = await makeRouter();
    const replies = await router.route(1, "/cmds");
    const { COMMANDS } = await import("../src/commands/cmds.ts");
    for (const c of COMMANDS) {
      expect(replies?.[0]).toContain(c.usage);
    }
  });

  test("/cmds@botname (group chat form) lists commands", async () => {
    const { router } = await makeRouter();
    const replies = await router.route(1, "/cmds@mybot");
    expect(replies?.[0]).toContain("/help");
  });
});

describe("CommandRouter — durable session reports", () => {
  test("/context and /session report the stored transcript, not an empty one", async () => {
    const { router, session, agent } = await makeRouter();
    agent.faux.setResponses([fauxAssistantMessage("hello back")]);
    const id = await session.ensureConversation();
    await agent.built.runtime.runTurn(id, "hello");
    await session.refreshMessageCount();

    const context = await router.route(1, "/context");
    expect(context?.[0]).toMatch(/Context: ~[\d,]+ tokens across 2 messages/);
    const report = await router.route(1, "/session");
    expect(report?.[0]).toContain("Messages: 2");
  });

  test("/compact on a short transcript reports nothing to compact", async () => {
    const { router, session, agent } = await makeRouter();
    agent.faux.setResponses([fauxAssistantMessage("ok")]);
    await agent.built.runtime.runTurn(await session.ensureConversation(), "hello");
    const reply = await router.route(1, "/compact");
    expect(reply?.[0]).toContain("Nothing to compact yet");
  });

  test("/context works before the first turn", async () => {
    const { router } = await makeRouter();
    const context = await router.route(1, "/context");
    expect(context?.[0]).toMatch(/across 0 messages/);
  });
});
