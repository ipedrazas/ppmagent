/**
 * Parses and dispatches slash commands. `route()` returns the replies for a
 * handled command, or `null` when the text is not a command (the caller then
 * runs it as an agent turn). Extracted from {@link TelegramBot} so adding a
 * command is a change here, not in the transport/poll loop.
 */
import { DEFAULT_KEEP_RECENT, contextTokens } from "../compaction.ts";
import type { Config } from "../config.ts";
import { execCommand } from "../exec.ts";
import { type Logger, nullLogger } from "../logger.ts";
import type { SessionIndex } from "../session/session-index.ts";
import { shortId } from "../session/store.ts";
import type { ConfirmationStore } from "../tools/confirmation.ts";
import type { TraceRecorder } from "../trace/recorder.ts";
import type { ChatSession } from "./chat-session.ts";
import type { Send } from "./reply.ts";

/** Full list of available slash commands, one line each. */
function helpText(): string {
  return [
    "Available commands:",
    "/project <slug> — switch active project",
    "/context — show context token usage",
    "/compact — compact the transcript",
    "/new [name] — start a fresh session",
    "/name <name> — label current session",
    "/session — show session details",
    "/tools — report CLI tool versions",
    "/resume [id|name] — list or switch sessions",
    "/search [query] — search saved sessions (project:<slug> or name fragment)",
    "/cancel — cancel an in-flight turn",
    "/help — show this message",
  ].join("\n");
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
   */
  async route(chatId: number, text: string): Promise<string[] | null> {
    const { session, confirmationStore, recorder } = this.deps;
    const trimmed = text.trim();

    // Trace every slash command uniformly (name + arg); turns are traced elsewhere.
    if (trimmed.startsWith("/")) {
      const [command = "", ...rest] = trimmed.split(/\s+/);
      recorder?.record({ type: "command", command, arg: rest.join(" ") || undefined });
    }

    if (trimmed.startsWith("/project")) {
      const slug = trimmed.slice("/project".length).trim();
      const reply = slug ? `Active project set to "${slug}".` : "Usage: /project <slug>";
      if (slug) {
        session.activeProject = slug;
        session.persist();
        this.log.withMetadata({ chatId, project: slug }).info("active project switched");
      }
      return this.reply(chatId, reply);
    }

    if (trimmed === "/context") {
      this.log.withMetadata({ chatId }).info("context reported");
      return this.reply(chatId, session.contextReport());
    }

    if (trimmed === "/compact") {
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

    if (trimmed === "/new" || trimmed.startsWith("/new ")) {
      const name = trimmed.slice("/new".length).trim() || undefined;
      const fresh = session.startNew(name);
      const reply =
        `Started a new session ${shortId(fresh.sessionId)}${name ? ` "${name}"` : ""}. ` +
        `Transcript cleared${fresh.activeProject ? `, still on "${fresh.activeProject}"` : ""}; memory is untouched.`;
      this.log.withMetadata({ chatId, sessionId: fresh.sessionId }).info("new session");
      return this.reply(chatId, reply);
    }

    if (trimmed.startsWith("/name")) {
      const name = trimmed.slice("/name".length).trim();
      const reply = name ? `Session named "${name}".` : "Usage: /name <name>";
      if (name) {
        session.name = name;
        session.persist();
        this.log.withMetadata({ chatId, sessionId: session.sessionId, name }).info("session named");
      }
      return this.reply(chatId, reply);
    }

    if (trimmed === "/session") {
      return this.reply(chatId, session.sessionReport());
    }

    if (trimmed === "/tools") {
      this.log.withMetadata({ chatId }).info("tools reported");
      return this.reply(chatId, await this.toolsReport());
    }

    if (trimmed === "/resume" || trimmed.startsWith("/resume ")) {
      const reply = session.resume(trimmed.slice("/resume".length).trim());
      this.log.withMetadata({ chatId, sessionId: session.sessionId }).info("resume command");
      return this.reply(chatId, reply);
    }

    if (trimmed === "/search" || trimmed.startsWith("/search ")) {
      return this.reply(chatId, this.searchSessions(trimmed.slice("/search".length).trim()));
    }

    if (trimmed === "/cancel") {
      // When called from the poll loop while a turn is active, the poll loop
      // aborts the agent before routing here. This branch handles the direct
      // call case (no turn in flight) — we still clear any pending confirmation.
      const hadConfirmation = confirmationStore?.hasPending() ?? false;
      if (hadConfirmation) confirmationStore?.clear();
      return this.reply(chatId, hadConfirmation ? "Cancelled." : "No active turn to cancel.");
    }

    if (trimmed === "/help") {
      return this.reply(chatId, helpText());
    }

    return null;
  }

  /** Send a single reply and return it as the replies array. */
  private async reply(chatId: number, text: string): Promise<string[]> {
    await this.deps.send(chatId, [text]);
    return [text];
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
