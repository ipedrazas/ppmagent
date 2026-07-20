import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, toolResult } from "../tool-helpers.ts";
import { CONFIRM_SUFFIX, type ConfirmationStore } from "../tools/confirmation.ts";
import { sanitizeLine } from "../tools/sanitize.ts";
import type { PulseClient } from "./pulse.ts";

export interface PulseToolsOptions {
  /** When set, `pulse_up` and `pulse_down` require user confirmation before executing. */
  confirmationStore?: ConfirmationStore;
}

/**
 * `pulse_*` tools: deploy and manage Docker stacks on remote nodes/VMs via the
 * `pulse` CLI, in response to requests like "Redeploy ProteOS". pulse itself
 * owns node/container/image state; nothing here is mirrored into memory.
 *
 * Flow: pulse_nodes to see what's available → pulse_ps/pulse_images to inspect
 * a node → pulse_pull to fetch a newer image → pulse_up to (re)deploy the
 * compose stack. pulse_up and pulse_down change what is running on a node, so
 * they go through the confirmation gate like other mutating tools; pulse_pull
 * only fetches an image and does not disturb running containers.
 */
export function buildPulseTools(pulse: PulseClient, opts?: PulseToolsOptions): AgentTool[] {
  const nodeParam = Type.Optional(
    Type.String({ description: "node/agent name; omits to use pulse's default node" }),
  );
  const composeParam = Type.Optional(
    Type.String({ description: "path to the docker-compose file on the node" }),
  );

  const nodes = defineTool({
    name: "pulse_nodes",
    description: "List all agents (nodes/VMs) pulse can deploy to.",
    label: "List nodes",
    parameters: Type.Object({}),
    execute: async (_id, _params, signal) => {
      const out = await pulse.listNodes(signal);
      return toolResult(out, { output: out });
    },
  });

  const ps = defineTool({
    name: "pulse_ps",
    description: "List containers running on a node.",
    label: "List containers",
    parameters: Type.Object({ node: nodeParam }),
    execute: async (_id, params, signal) => {
      const out = await pulse.listContainers(params.node, signal);
      return toolResult(out, { output: out });
    },
  });

  const images = defineTool({
    name: "pulse_images",
    description: "List Docker images present on a node.",
    label: "List images",
    parameters: Type.Object({ node: nodeParam }),
    execute: async (_id, params, signal) => {
      const out = await pulse.listImages(params.node, signal);
      return toolResult(out, { output: out });
    },
  });

  const pull = defineTool({
    name: "pulse_pull",
    description: "Pull a Docker image on a node, e.g. before redeploying a compose stack with it.",
    label: "Pull image",
    parameters: Type.Object({
      image: Type.String({ description: "image reference, e.g. ghcr.io/org/app:latest" }),
      node: nodeParam,
    }),
    execute: async (_id, params, signal) => {
      const image = sanitizeLine(params.image);
      const out = await pulse.pullImage(image, params.node, signal);
      return toolResult(out, { output: out });
    },
  });

  const up = defineTool({
    name: "pulse_up",
    description:
      "Deploy or restart a Docker Compose stack on a node. Changes what is running, so it requires user confirmation.",
    label: "Deploy stack",
    parameters: Type.Object({ node: nodeParam, compose: composeParam }),
    execute: async (_id, params, signal) => {
      if (opts?.confirmationStore) {
        const lines = ["Deploy/restart compose stack"];
        if (params.node) lines.push(`  Node: ${params.node}`);
        if (params.compose) lines.push(`  Compose: ${params.compose}`);
        const description = lines.join("\n");
        opts.confirmationStore.set(description, (s) => pulse.up(params, s));
        return toolResult(`${description}${CONFIRM_SUFFIX}`, { output: "" }, { terminate: true });
      }

      const out = await pulse.up(params, signal);
      return toolResult(out, { output: out });
    },
  });

  const down = defineTool({
    name: "pulse_down",
    description:
      "Stop a Docker Compose stack on a node. Stops running services, so it requires user confirmation.",
    label: "Stop stack",
    parameters: Type.Object({ node: nodeParam, compose: composeParam }),
    execute: async (_id, params, signal) => {
      if (opts?.confirmationStore) {
        const lines = ["Stop compose stack"];
        if (params.node) lines.push(`  Node: ${params.node}`);
        if (params.compose) lines.push(`  Compose: ${params.compose}`);
        const description = lines.join("\n");
        opts.confirmationStore.set(description, (s) => pulse.down(params, s));
        return toolResult(`${description}${CONFIRM_SUFFIX}`, { output: "" }, { terminate: true });
      }

      const out = await pulse.down(params, signal);
      return toolResult(out, { output: out });
    },
  });

  const logs = defineTool({
    name: "pulse_logs",
    description: "View logs of a Docker Compose stack on a node.",
    label: "Stack logs",
    parameters: Type.Object({ node: nodeParam, compose: composeParam }),
    execute: async (_id, params, signal) => {
      const out = await pulse.logs(params, signal);
      return toolResult(out, { output: out });
    },
  });

  return [nodes, ps, images, pull, up, down, logs];
}
