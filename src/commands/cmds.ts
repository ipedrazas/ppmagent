/**
 * Registry of every handled Telegram slash command, and the self-generating
 * `/cmds` command that lists them. Single source of truth for `/help`
 * (name + usage + summary), `/explain` (the full spec), and `/cmds` — add a
 * command here and it shows up in all three automatically.
 */

export interface CommandSpec {
  name: string;
  usage: string;
  summary: string;
  details: string;
  example: string;
}

export const COMMANDS: CommandSpec[] = [
  {
    name: "project",
    usage: "/project <slug>",
    summary: "switch active project",
    details: "Sets the active project for this session, used to scope tracker lookups and context.",
    example: "/project onboarding",
  },
  {
    name: "context",
    usage: "/context",
    summary: "show context token usage",
    details:
      "Reports how many tokens the current transcript is using, to help decide when to compact.",
    example: "/context",
  },
  {
    name: "compact",
    usage: "/compact",
    summary: "compact the transcript",
    details:
      "Compacts the transcript to reduce token usage, keeping the most recent messages and summarizing the rest.",
    example: "/compact",
  },
  {
    name: "new",
    usage: "/new [name]",
    summary: "start a fresh session",
    details:
      "Starts a fresh session, clearing the transcript. The active project and memory are left untouched.",
    example: "/new sprint-planning",
  },
  {
    name: "name",
    usage: "/name <name>",
    summary: "label current session",
    details:
      "Labels the current session with a name, so it's easier to find later with /search or /resume.",
    example: "/name sprint-planning",
  },
  {
    name: "session",
    usage: "/session",
    summary: "show session details",
    details:
      "Shows details about the current session: id, name, active project, and message count.",
    example: "/session",
  },
  {
    name: "describe",
    usage: "/describe [on|off]",
    summary: "toggle reasoning-detail prompts for tool calls",
    details:
      "Toggles describe mode. With no argument it flips the current state; 'on' or 'off' set it explicitly. The setting persists across restarts.",
    example: "/describe on",
  },
  {
    name: "tools",
    usage: "/tools",
    summary: "report CLI tool versions",
    details:
      "Reports the versions of the external CLIs ppmagent shells out to (memory, tracker, ProteOS task lane).",
    example: "/tools",
  },
  {
    name: "resume",
    usage: "/resume [id|name]",
    summary: "list or switch sessions",
    details:
      "With no argument, lists saved sessions. With an id or name, switches to that session.",
    example: "/resume onboarding",
  },
  {
    name: "search",
    usage: "/search [query]",
    summary: "search saved sessions (project:<slug> or name fragment)",
    details:
      "Searches saved sessions. Use 'project:<slug>' to filter by project, any other text matches against the session name, or leave empty to list all sessions.",
    example: "/search project:onboarding",
  },
  {
    name: "reminders",
    usage: "/reminders [cancel <id>]",
    summary: "list pending reminders, or cancel one by id",
    details:
      "With no argument, lists pending reminders. With 'cancel <id>', cancels the reminder with that id.",
    example: "/reminders cancel abc123",
  },
  {
    name: "cancel",
    usage: "/cancel",
    summary: "cancel an in-flight turn",
    details:
      "Cancels an in-flight agent turn, or clears a pending confirmation if one is waiting on a reply.",
    example: "/cancel",
  },
  {
    name: "help",
    usage: "/help",
    summary: "show this message",
    details: "Lists every available slash command with a one-line summary of what it does.",
    example: "/help",
  },
  {
    name: "explain",
    usage: "/explain <cmd>",
    summary: "explain what a command does",
    details:
      "Describes a specific command in detail: what it does, its usage/syntax, any flags, and an example.",
    example: "/explain describe",
  },
  {
    name: "cmds",
    usage: "/cmds",
    summary: "list all available commands",
    details: "Lists every available slash command and its description, formatted for Telegram.",
    example: "/cmds",
  },
];

/** Format {@link COMMANDS} as a Telegram Markdown bullet list for `/cmds`. */
export function cmdsCommand(): string {
  const lines = COMMANDS.map((c) => `**${c.usage}** — ${c.summary}`);
  return ["**Available commands:**", ...lines].join("\n");
}
