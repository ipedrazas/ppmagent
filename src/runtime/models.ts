import {
  createProvider,
  envApiKeyAuth,
  type Model,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  builtinModels,
  getBuiltinModel,
  getBuiltinModels,
} from "@earendil-works/pi-ai/providers/all";
import type { Config } from "../config.ts";
import { type Logger, nullLogger } from "../logger.ts";

/**
 * Model resolution for the durable runtime. A durable conversation stores only a
 * `{ provider, modelId }` reference and the harness resolves it against a
 * `Models` collection on every request — including after a restart — so the
 * collection built here must be able to answer for every model the config can
 * name, not just the ones in pi's catalog.
 */

/**
 * pi-ai has no built-in Ollama provider (it's a local, self-hosted server with
 * no fixed model catalog). Build it the way pi-ai's own OpenAI-compatible
 * providers do — deepseek, zai, and openrouter all wrap `openAICompletionsApi()`
 * via `createProvider` — pointed at the configured base URL, carrying the one
 * model the config names.
 */
function ollamaProvider(config: Config, model: Model<"openai-completions">): Provider {
  return createProvider({
    id: "ollama",
    name: "Ollama",
    baseUrl: config.baseUrl,
    auth: { apiKey: envApiKeyAuth("Ollama API key", ["OLLAMA_API_KEY"]) },
    models: [model],
    api: openAICompletionsApi(),
  });
}

/** Build the runtime Model descriptor for the configured Ollama model id. */
function resolveOllamaModel(config: Config): Model<"openai-completions"> {
  return {
    id: config.model,
    name: config.model,
    api: "openai-completions",
    provider: "ollama",
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

/** Catalog ids for a provider, ranked so the closest matches to `wanted` come first. */
function suggestModelIds(provider: string, wanted: string): string[] {
  const ids = getBuiltinModels(provider as "anthropic").map((m) => m.id);
  // A mis-typed id is usually a real id plus/minus a suffix (a date stamp, a
  // `-latest`), so rank by shared prefix length before falling back to
  // alphabetical order.
  const sharedPrefix = (id: string): number => {
    let i = 0;
    while (i < id.length && i < wanted.length && id[i] === wanted[i]) i++;
    return i;
  };
  return ids.sort((a, b) => sharedPrefix(b) - sharedPrefix(a) || a.localeCompare(b)).slice(0, 10);
}

/**
 * Context/output assumptions for a model pi's catalog does not know. They only
 * feed compaction, so they are deliberately conservative — set
 * PPMA_COMPACTION_TOKEN_THRESHOLD explicitly when running an uncatalogued model.
 */
const UNCATALOGUED_CONTEXT_WINDOW = 128_000;
const UNCATALOGUED_MAX_TOKENS = 8_192;

/**
 * Build a descriptor for a model id the catalog does not list, by borrowing the
 * endpoint and wire API from any catalogued model of the same provider. Returns
 * undefined when the provider is unknown or does not speak
 * `openai-completions` — those (e.g. anthropic) need provider-specific request
 * shaping we cannot safely synthesize.
 *
 * A provider's catalog snapshot ages faster than the pinned pi-ai release, so a
 * brand-new model id is a legitimate config, not a typo. Costs are zeroed
 * because they are genuinely unknown — see the warning in {@link resolveModel}.
 */
function uncataloguedModel(config: Config): Model<"openai-completions"> | undefined {
  // The cast widens away the catalog's per-provider `api` literal so the runtime
  // check below is expressible (config supplies the provider at runtime). A
  // provider can mix wire APIs (openrouter lists anthropic-messages models too),
  // so borrow from a model that speaks openai-completions specifically.
  const catalog = getBuiltinModels(config.provider as "anthropic") as Model<any>[];
  const sample = catalog.find((m) => m.api === "openai-completions");
  const baseUrl = config.baseUrl || sample?.baseUrl;
  if (!baseUrl || (catalog.length > 0 && !sample)) return undefined;
  return {
    id: config.model,
    name: config.model,
    api: "openai-completions",
    provider: config.provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: UNCATALOGUED_CONTEXT_WINDOW,
    maxTokens: UNCATALOGUED_MAX_TOKENS,
  };
}

/**
 * Resolve the configured provider + model to a runtime `Model`. Ollama is
 * handled specially; every other provider goes through `getBuiltinModel`, which
 * is strongly typed over the built-in catalog — the casts let config-supplied
 * values flow through (it is a runtime catalog lookup).
 *
 * A catalog miss must never return `undefined`: a durable conversation with an
 * unresolvable model reference parks its run as `no_model` and the bot answers
 * every message with a failure. So a miss either synthesizes a descriptor for
 * the provider's endpoint (loudly — the id may simply be newer than the pinned
 * catalog) or throws at startup.
 */
export function resolveModel(config: Config, logger: Logger = nullLogger): Model<any> {
  if (config.provider === "ollama") return resolveOllamaModel(config);
  const model = getBuiltinModel(
    config.provider as "anthropic",
    config.model as "claude-sonnet-4-6",
  );
  if (model) return model;

  const synthesized = uncataloguedModel(config);
  if (synthesized) {
    logger
      .withMetadata({
        model: config.model,
        provider: config.provider,
        baseUrl: synthesized.baseUrl,
        assumedContextWindow: synthesized.contextWindow,
        closestCatalogIds: suggestModelIds(config.provider, config.model).slice(0, 3),
      })
      .warn(
        `Model "${config.model}" is not in pi's catalog; calling ${config.provider} with it ` +
          "anyway. Cost is reported as $0 (so PPMA_TURN_MAX_COST_USD / " +
          "PPMA_SESSION_MAX_COST_USD stop enforcing) and the context window is an " +
          "assumption. If the provider does not know the id either it will reject the " +
          "call — that surfaces as a `model turn failed` log line, not a crash.",
      );
    return synthesized;
  }

  const suggestions = suggestModelIds(config.provider, config.model);
  throw new Error(
    `Unknown model "${config.model}" for provider "${config.provider}" — ` +
      "it is not in pi's built-in catalog and cannot be called generically " +
      "(this provider does not use the OpenAI-completions wire format). " +
      "Set PPMA_MODEL to a known id" +
      (suggestions.length > 0 ? `, e.g. one of: ${suggestions.join(", ")}` : "") +
      ".",
  );
}

/**
 * The `Models` collection the harness resolves model references against: every
 * built-in provider, plus whatever is needed so `model` itself is resolvable —
 * the Ollama provider, or the configured provider extended with an
 * uncatalogued model id.
 */
export function buildModels(config: Config, model: Model<any>): MutableModels {
  const models = builtinModels();
  if (config.provider === "ollama") {
    models.setProvider(ollamaProvider(config, model as Model<"openai-completions">));
    return models;
  }
  if (!models.getModel(model.provider, model.id)) {
    const base = models.getProvider(model.provider);
    if (base) {
      // Delegate everything (auth, streaming, catalog) to the built-in provider and
      // only widen its model list, so the synthesized id resolves.
      const widened: Provider = Object.create(base, {
        getModels: { value: () => [...base.getModels(), model] },
        getAllModels: { value: () => [...(base.getAllModels?.() ?? base.getModels()), model] },
      });
      models.setProvider(widened);
    }
  }
  return models;
}
