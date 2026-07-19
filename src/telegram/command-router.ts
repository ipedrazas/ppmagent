/**
 * Parses and dispatches slash commands. `route()` returns the replies for a
 * handled command, or `null` when the text is not a command (the caller then
 * runs it as an agent turn). Extracted from {@link TelegramBot} so adding a
 * command is a change here, not in the transport/poll loop.
 */
import { COMMANDS, cmdsCommand } from "../commands/cmds.ts";
import { contextTokens, DEFAULT_KEEP_RECENT } from "../compaction.ts";
import type { Config } from "../config.ts";
import { execCommand } from "../exec.ts";
import { type Logger, nullLogger } from "../logger.ts";
import { formatDueAt } from "../reminder/parse.ts";
import type { ReminderStore } from "../reminder/store.ts";
import type { SessionIndex } from "../session/session-index.ts";
import { shortId } from "../session/store.ts";
import type { ConfirmationStore } from "../tools/confirmation.ts";
import type { TraceRecorder } from "../trace/recorder.ts";
import type { ChatSession } from "./chat-session.ts";
import type { Send } from "./reply.ts";

/**
 * Parse a slash command, handling the `/cmd@botname arg` form used in group
 * chats. Returns `{ cmd, arg }` or `null` when `text` is not a command.
 */
export function parseCommand(text: string): { cmd: string; arg: string } | null {
  const m = text.trim().match(/^\/(\w+)(?:@\w+)?\s*(.*)$/);
  if (!m) return null;
  return { cmd: m[1] ?? "", arg: (m[2] ?? "").trim() };
}

/** Full list of available slash commands, one line each, from {@link COMMANDS}. */
function helpText(): string {
  return ["Available commands:", ...COMMANDS.map((c) => `${c.usage} — ${c.summary}`)].join("\n");
}

export interface CommandRouterDeps {
  session: ChatSession;
  config: Config;
  send: Send;
  /** Aborts the `--version` subprocesses `/tools` spawns, on shutdown. */
  abortSignal: AbortSignal;
  /** When set, `/cancel` clears a pending confirmation. */
  confirmationStore?: ConfirmationStore;
  recorder?: TraceRecorder;
  /** Session index for the `/search` command. Absent = search unavailable. */
  index?: SessionIndex;
  /** When set, `/reminders` lists and cancels pending reminders. */
  reminderStore?: ReminderStore;
  logger?: Logger;
}

export class CommandRouter {
  private readonly log: Logger;

  constructor(private readonly deps: CommandRouterDeps) {
    this.log = (deps.logger ?? nullLogger).child().withContext({ component: "telegram-bot" });
  }

  /**
   * Dispatch a slash command. Returns the replies sent, or `null` when `text`
   * is not a handled command (the caller runs it as an agent turn).
   *
   * Handles the group-chat form `/cmd@botname arg` via {@link parseCommand}.
   */
  async route(chatId: number, text: string): Promise<string[] | null> {
    const { session, confirmationStore, recorder } = this.deps;

    const parsed = parseCommand(text);
    if (!parsed) return null;

    const { cmd, arg } = parsed;
    recorder?.record({ type: "command", command: `/${cmd}`, arg: arg || undefined });

    if (cmd === "project") {
      const reply = arg ? `Active project set to "${arg}".` : "Usage: /project <slug>";
      if (arg) {
        session.activeProject = arg;
        session.persist();
        this.log.withMetadata({ chatId, project: arg }).info("active project switched");
      }
      return this.reply(chatId, reply);
    }

    if (cmd === "context") {
      this.log.withMetadata({ chatId }).info("context reported");
      return this.reply(chatId, session.contextReport());
    }

    if (cmd === "compact") {
      const before = contextTokens(session.messages);
      const beforeCount = session.messages.length;
      const outcome = await session.compact(1); // threshold 1 = always attempt
      session.persist();
      // Message-count reduction is the true signal: the token estimate is
      // dominated by the fixed system prompt + tool schemas, so collapsing a few
      // short messages can leave the token total essentially unchanged.
      const reply =
        outcome.messages.length < beforeCount
          ? `Compacted: ${beforeCount} → ${outcome.messages.length} messages (~${before.toLocaleString()} → ~${outcome.tokensAfter.toLocaleString()} tokens).`
          : `Nothing to compact yet — ${beforeCount} messages (~${before.toLocaleString()} tokens). Compaction keeps the ${DEFAULT_KEEP_RECENT} most recent.`;
      this.log
        .withMetadata({ chatId, tokensBefore: before, tokensAfter: outcome.tokensAfter })
        .info("manual compaction");
      return this.reply(chatId, reply);
    }

    if (cmd === "new") {
      const name = arg || undefined;
      const fresh = session.startNew(name);
      const reply =
        `Started a new session ${shortId(fresh.sessionId)}${name ? ` "${name}"` : ""}. ` +
        `Transcript cleared${fresh.activeProject ? `, still on "${fresh.activeProject}"` : ""}; memory is untouched.`;
      this.log.withMetadata({ chatId, sessionId: fresh.sessionId }).info("new session");
      return this.reply(chatId, reply);
    }

    if (cmd === "name") {
      const reply = arg ? `Session named "${arg}".` : "Usage: /name <name>";
      if (arg) {
        session.name = arg;
        session.persist();
        this.log
          .withMetadata({ chatId, sessionId: session.sessionId, name: arg })
          .info("session named");
      }
      return this.reply(chatId, reply);
    }

    if (cmd === "session") {
      return this.reply(chatId, session.sessionReport());
    }

    if (cmd === "describe") {
      return this.reply(chatId, this.describeCommand(arg));
    }

    if (cmd === "tools") {
      this.log.withMetadata({ chatId }).info("tools reported");
      return this.reply(chatId, await this.toolsReport());
    }

    if (cmd === "resume") {
      const reply = session.resume(arg);
      this.log.withMetadata({ chatId, sessionId: session.sessionId }).info("resume command");
      return this.reply(chatId, reply);
    }

    if (cmd === "search") {
      return this.reply(chatId, this.searchSessions(arg));
    }

    if (cmd === "reminders") {
      return this.reply(chatId, this.remindersCommand(arg));
    }

    if (cmd === "cancel") {
      // When called from the poll loop while a turn is active, the poll loop
      // aborts the agent before routing here. This branch handles the direct
      // call case (no turn in flight) — we still clear any pending confirmation.
      const hadConfirmation = confirmationStore?.hasPending() ?? false;
      if (hadConfirmation) confirmationStore?.clear();
      return this.reply(chatId, hadConfirmation ? "Cancelled." : "No active turn to cancel.");
    }

    if (cmd === "help") {
      return this.reply(chatId, helpText());
    }

    if (cmd === "explain") {
      return this.reply(chatId, this.explainCommand(arg));
    }

    if (cmd === "cmds") {
      return this.reply(chatId, cmdsCommand());
    }

    return null;
  }

  /** Send a single reply and return it as the replies array. */
  private async reply(chatId: number, text: string): Promise<string[]> {
    await this.deps.send(chatId, [text]);
    return [text];
  }

  /**
   * Handle `/describe [on|off]`. With no argument, toggles the current state;
   * "on"/"off" (case-insensitive) set it explicitly. Persists the change so it
   * survives a restart.
   */
  private describeCommand(arg: string): string {
    const { session } = this.deps;
    const normalized = arg.trim().toLowerCase();
    if (normalized === "on") {
      session.describeEnabled = true;
    } else if (normalized === "off") {
      session.describeEnabled = false;
    } else if (normalized === "") {
      session.describeEnabled = !session.describeEnabled;
    } else {
      return "Usage: /describe, /describe on, or /describe off";
    }
    session.persist();
    this.log
      .withMetadata({ describeEnabled: session.describeEnabled })
      .info("describe mode toggled");
    return `Describe mode is now ${session.describeEnabled ? "ON" : "OFF"}.`;
  }

  /**
   * Handle `/explain <cmd>`. Looks up `cmd` (leading "/" optional) in the
   * {@link COMMANDS} registry and returns a detailed description, or a
   * usage/error message when `cmd` is missing or unknown.
   */
  private explainCommand(arg: string): string {
    if (!arg) {
      return "Usage: /explain <cmd> — e.g. /explain describe";
    }

    const name = arg.trim().replace(/^\//, "").toLowerCase();
    const spec = COMMANDS.find((c) => c.name === name);
    if (!spec) {
      const available = COMMANDS.map((c) => c.name).join(", ");
      return `Unknown command "/${name}". Available commands: ${available}.`;
    }

    return [
      `/${spec.name} — ${spec.summary}`,
      "",
      spec.details,
      "",
      `Usage: ${spec.usage}`,
      `Example: ${spec.example}`,
    ].join("\n");
  }

  /**
   * Handle `/reminders [cancel <id>]`.
   * With no arg: list pending reminders.
   * With "cancel <id>": remove the identified reminder.
   */
  private remindersCommand(arg: string): string {
    const { reminderStore } = this.deps;
    if (!reminderStore) return "Reminders are not configured.";

    if (arg) {
      const cancelMatch = arg.match(/^cancel\s+(\S+)$/i);
      if (cancelMatch?.[1]) {
        const id = cancelMatch[1];
        const removed = reminderStore.remove(id);
        return removed ? `Reminder ${id} cancelled.` : `No reminder found with id "${id}".`;
      }
      return "Usage: /reminders or /reminders cancel <id>";
    }

    const reminders = reminderStore.list();
    if (reminders.length === 0) return "No pending reminders.";
    const lines = reminders.map((r) => `• [${r.id}] ${formatDueAt(r.dueAt)} — ${r.message}`);
    return `Pending reminders (${reminders.length}):\n${lines.join("\n")}`;
  }

  /**
   * Search the session index and format results. Accepts an optional query:
   *   - `project:<slug>` — filter by project slug (exact match)
   *   - anything else — filter by name substring (case-insensitive)
   *   - empty — list all sessions
   */
  private searchSessions(query: string): string {
    const { index, session } = this.deps;
    if (!index) return "Session search is unavailable (no index configured).";

    let results = index.list();
    if (query) {
      const projectMatch = query.match(/^project:(.+)$/i);
      if (projectMatch?.[1]) {
        const slug = projectMatch[1].trim();
        results = index.search({ project: slug });
      } else {
        results = index.search({ name: query });
      }
    }

    if (results.length === 0) {
      return query ? `No sessions match "${query}".` : "No sessions yet.";
    }

    const currentId = session.sessionId;
    const lines = results.map((s) => {
      const label = shortId(s.sessionId);
      const name = s.name ? ` "${s.name}"` : "";
      const project = s.activeProject ? `, ${s.activeProject}` : "";
      const current = s.sessionId === currentId ? " (current)" : "";
      return `• ${label}${name} — ${s.messageCount} msgs${project}${current}`;
    });

    const header = query ? `Sessions matching "${query}":` : `Sessions (${results.length}):`;
    return `${header}\n${lines.join("\n")}`;
  }

  /**
   * The external CLIs ppmagent shells out to, paired with what each powers.
   * `/tools` reports these so an operator can confirm from the chat which tool
   * builds are deployed alongside the bot.
   */
  private toolSpecs(): Array<{ bin: string; role: string }> {
    return [
      { bin: this.deps.config.ppmBin, role: "memory" },
      { bin: this.deps.config.dbxcliBin, role: "tracker" },
      { bin: this.deps.config.proteosBin, role: "ProteOS task lane" },
    ];
  }

  /**
   * Query each external CLI's `--version` and report it. A tool that fails to
   * spawn (not on PATH) or exits non-zero is reported as unavailable rather than
   * failing the whole command, so `/tools` always answers. Version formats differ
   * per CLI, so the raw output is passed through (multi-line collapsed to one).
   */
  private async toolsReport(): Promise<string> {
    const lines = await Promise.all(
      this.toolSpecs().map(async ({ bin, role }) => {
        try {
          const result = await execCommand(bin, ["--version"], {
            signal: this.deps.abortSignal,
            logger: this.log,
          });
          if (result.exitCode !== 0) {
            return `• ${bin} (${role}) — unavailable (exit ${result.exitCode})`;
          }
          const version =
            [result.stdout, result.stderr]
              .join("\n")
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean)
              .join(" · ") || "(no version output)";
          return `• ${version} — ${role}`;
        } catch {
          return `• ${bin} (${role}) — not installed`;
        }
      }),
    );
    return `ppmagent tools:\n${lines.join("\n")}`;
  }
}
