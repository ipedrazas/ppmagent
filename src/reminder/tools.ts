import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, toolResult } from "../tool-helpers.ts";
import { formatDueAt, parseWhen } from "./parse.ts";
import type { ReminderStore } from "./store.ts";

/**
 * Agent tools for managing reminders.
 *
 * `reminder_create` — set a reminder at a natural-language or ISO 8601 time.
 * `reminder_list`   — list all pending reminders.
 * `reminder_cancel` — cancel a reminder by id.
 */
export function buildReminderTools(store: ReminderStore): AgentTool[] {
  const reminderCreate = defineTool({
    name: "reminder_create",
    description:
      "Set a reminder that fires a Telegram message at a specified time. " +
      "The `when` field accepts natural language (e.g. \"tomorrow\", \"in 2 hours\", " +
      "\"at 3pm\", \"next Monday\", \"tomorrow at 9am\") or an ISO 8601 datetime " +
      "(e.g. \"2025-07-08T09:00:00\"). Times are relative to the server's local clock.",
    label: "Create reminder",
    parameters: Type.Object({
      message: Type.String({ description: "The reminder text to send when it fires." }),
      when: Type.String({
        description:
          'When to fire. Natural language ("in 2 hours", "tomorrow", "at 3pm", ' +
          '"next Monday") or ISO 8601 datetime ("2025-07-08T09:00:00").',
      }),
    }),
    execute: async (_id, params) => {
      const dueAt = parseWhen(params.when);
      if (dueAt === null) {
        return toolResult(
          `Could not parse time expression: "${params.when}". ` +
            'Try "in 2 hours", "tomorrow", "at 3pm", or an ISO 8601 datetime.',
          null,
          { terminate: false },
        );
      }
      const reminder = store.add({ message: params.message, dueAt });
      const humanTime = formatDueAt(dueAt);
      return toolResult(
        `Reminder set (id: ${reminder.id}). Will fire at ${humanTime}.\nMessage: ${params.message}`,
        reminder,
      );
    },
  });

  const reminderList = defineTool({
    name: "reminder_list",
    description: "List all pending reminders with their ids and scheduled times.",
    label: "List reminders",
    parameters: Type.Object({}),
    execute: async () => {
      const reminders = store.list();
      if (reminders.length === 0) {
        return toolResult("No pending reminders.", reminders);
      }
      const lines = reminders.map(
        (r) => `• [${r.id}] ${formatDueAt(r.dueAt)} — ${r.message}`,
      );
      return toolResult(`Pending reminders (${reminders.length}):\n${lines.join("\n")}`, reminders);
    },
  });

  const reminderCancel = defineTool({
    name: "reminder_cancel",
    description: "Cancel a pending reminder by its id (from reminder_list or reminder_create).",
    label: "Cancel reminder",
    parameters: Type.Object({
      id: Type.String({ description: "The reminder id to cancel." }),
    }),
    execute: async (_toolCallId, params) => {
      const removed = store.remove(params.id);
      if (!removed) {
        return toolResult(`No reminder found with id "${params.id}".`, null);
      }
      return toolResult(`Reminder ${params.id} cancelled.`, null);
    },
  });

  return [reminderCreate, reminderList, reminderCancel];
}
