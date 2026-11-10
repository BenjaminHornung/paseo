import { readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import lockfile from "proper-lockfile";

const budgetFilePattern = /^[a-f0-9]{64}\.json$/;
const countFields = [
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "reasoning",
  "text",
  "previous_response_id",
  "conversation",
  "truncation",
];

function samePath(left, right) {
  return path.relative(left, right) === "" && path.relative(right, left) === "";
}

function regularFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function ownedBudgetIdentity(file) {
  const dataRoot = process.env.PASEO_ORCHESTRATOR_DATA_ROOT;
  const stateFile = process.env.ORCHESTRATOR_STATE;
  if (
    !dataRoot ||
    !path.isAbsolute(dataRoot) ||
    !stateFile ||
    !path.isAbsolute(stateFile) ||
    !path.isAbsolute(file)
  ) {
    throw Error("Orchestrator budget binding invalid");
  }

  const canonicalDataRoot = realpathSync(dataRoot);
  const expectedDirectory = path.join(canonicalDataRoot, "state", "pi-budgets");
  const canonicalDirectory = realpathSync(expectedDirectory);
  const requestedName = path.basename(file);
  const canonicalFile = realpathSync(file);
  if (
    !budgetFilePattern.test(requestedName) ||
    !samePath(canonicalDirectory, expectedDirectory) ||
    !samePath(path.dirname(canonicalFile), canonicalDirectory) ||
    path.basename(canonicalFile) !== requestedName
  ) {
    throw Error("Orchestrator budget path invalid");
  }

  return { file: canonicalFile, controllerState: realpathSync(stateFile) };
}

function requestBudget(file = process.env.PASEO_ORCHESTRATOR_BUDGET_FILE) {
  if (!file) return undefined;

  const identity = ownedBudgetIdentity(file);
  const read = () => {
    const ledger = JSON.parse(readFileSync(identity.file, "utf8"));
    if (
      typeof ledger.controllerState !== "string" ||
      !path.isAbsolute(ledger.controllerState) ||
      !samePath(realpathSync(ledger.controllerState), identity.controllerState)
    ) {
      throw Error("Orchestrator budget identity invalid");
    }
    if (ledger.closed) throw Error("Orchestrator API task is closed");
    if (
      !Number.isSafeInteger(ledger.limit) ||
      ledger.limit < 1 ||
      !Number.isSafeInteger(ledger.debited) ||
      ledger.debited < 0 ||
      ledger.debited > ledger.limit
    ) {
      throw Error("Orchestrator budget invalid");
    }
    return ledger;
  };

  // The guard advertises its closed-ledger barrier while holding the same lock
  // used for reservations, before Pi can start a generation.
  const releaseHandshake = lockfile.lockSync(identity.file, { realpath: false, stale: 120000 });
  try {
    const ledger = read();
    if (ledger.freezeProtocol !== 1) {
      const temporary = `${identity.file}.${process.pid}.handshake`;
      writeFileSync(temporary, JSON.stringify({ ...ledger, freezeProtocol: 1 }), {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporary, identity.file);
    }
  } finally {
    releaseHandshake();
  }

  return {
    cap(payload, inputTokens) {
      const ledger = read();
      const remaining = ledger.limit - ledger.debited;
      // $1/M input and $5/M output are conservative ceilings for Luna,
      // including reasoning/cache writes. Reserve every HTTP attempt first.
      const affordable = Math.floor((remaining - inputTokens) / 5);
      if (affordable < 1024) throw Error("Orchestrator task budget exhausted");
      return {
        ...payload,
        max_output_tokens: Math.min(payload.max_output_tokens ?? 8192, 8192, affordable),
      };
    },
    reserve(payload, inputTokens) {
      if (payload.model !== "gpt-6-luna") throw Error("Orchestrator API model not approved");
      const cost = Math.ceil(inputTokens + payload.max_output_tokens * 5);
      if (!Number.isSafeInteger(cost) || cost <= 0)
        throw Error("Orchestrator request budget invalid");
      const release = lockfile.lockSync(identity.file, { realpath: false, stale: 120000 });
      try {
        const ledger = read();
        if (ledger.debited + cost > ledger.limit) throw Error("Orchestrator task budget exhausted");
        ledger.debited += cost;
        ledger.requests = (ledger.requests ?? 0) + 1;
        ledger.lastServiceTier = payload.service_tier ?? "default";
        ledger.standardRequests =
          (ledger.standardRequests ?? 0) + Number(ledger.lastServiceTier === "default");
        const temporary = `${identity.file}.${process.pid}.pending`;
        writeFileSync(temporary, JSON.stringify(ledger), { flag: "wx", mode: 0o600 });
        renameSync(temporary, identity.file);
      } finally {
        release();
      }
    },
  };
}

function resolvePiAiModules() {
  const configuredPackage = process.env.PASEO_ORCHESTRATOR_PI_PACKAGE;
  if (!configuredPackage || !path.isAbsolute(configuredPackage))
    throw Error("Orchestrator Pi SDK package invalid");

  const piPackage = realpathSync(configuredPackage);
  const piManifest = JSON.parse(readFileSync(path.join(piPackage, "package.json"), "utf8"));
  if (
    piManifest.name !== "@earendil-works/pi-coding-agent" ||
    !regularFile(path.join(piPackage, "dist", "index.js"))
  ) {
    throw Error("Orchestrator Pi SDK package invalid");
  }

  const candidates = [
    path.join(piPackage, "node_modules", "@earendil-works", "pi-ai"),
    path.resolve(piPackage, "..", "pi-ai"),
  ];
  for (const candidate of candidates) {
    try {
      const packageRoot = realpathSync(candidate);
      const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
      const index = path.join(packageRoot, "dist", "index.js");
      const provider = path.join(packageRoot, "dist", "providers", "openai.js");
      if (
        manifest.name === "@earendil-works/pi-ai" &&
        regularFile(index) &&
        regularFile(provider)
      ) {
        return {
          index: pathToFileURL(realpathSync(index)).href,
          provider: pathToFileURL(realpathSync(provider)).href,
        };
      }
    } catch {
      // The installed package has one of two known npm layouts; try the next.
    }
  }
  throw Error("Orchestrator Pi SDK dependency unavailable");
}

export function retryDelayMs(response, error = {}, now = Date.now()) {
  const milliseconds = Number(response.headers.get("retry-after-ms"));
  if (
    response.headers.has("retry-after-ms") &&
    Number.isFinite(milliseconds) &&
    milliseconds >= 0
  ) {
    return Math.ceil(milliseconds);
  }

  const header = response.headers.get("retry-after");
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }

  const text = String(error.message ?? "");
  const match = text.match(
    /(?:try again|retry|versuch\w*)\s+(?:in|after|nach)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|sekunden?|m|minutes?|minuten?)(?![a-z])/i,
  );
  if (!match) return undefined;
  const multiplier = /^(m|minutes?|minuten?)$/i.test(match[2])
    ? 60000
    : /^ms|millisecond/i.test(match[2])
      ? 1
      : 1000;
  return Math.ceil(Number(match[1]) * multiplier);
}

// Retries happen before a response stream reaches Pi. Once a successful
// stream starts, this layer never replays it.
export function resilientOpenAiFetch(fetcher = fetch, options = {}) {
  const wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  return async (url, init = {}) => {
    const target = new URL(typeof url === "string" || url instanceof URL ? url : url.url);
    const generation = target.pathname === "/v1/responses";
    if (
      options.beforeAttempt &&
      (target.origin !== "https://api.openai.com" ||
        !generation ||
        init.method?.toUpperCase() !== "POST")
    ) {
      throw Error("Unapproved budgeted API endpoint");
    }
    if (generation && options.beforeAttempt && typeof init.body !== "string") {
      throw Error("Uninspectable generation request");
    }
    if (
      target.origin !== "https://api.openai.com" ||
      !["/v1/responses", "/v1/responses/input_tokens"].includes(target.pathname) ||
      typeof init.body !== "string"
    ) {
      return fetcher(url, init);
    }

    let payload;
    try {
      payload = JSON.parse(init.body);
    } catch {
      if (options.beforeAttempt) throw Error("Uninspectable generation request");
      return fetcher(url, init);
    }

    const originalSignal = options.sdkTimeoutFallback
      ? options.signal
      : (options.signal ?? init.signal);
    let transportSignal = init.signal;
    let standardFallback = false;
    for (let attempt = 0; ; attempt++) {
      originalSignal?.throwIfAborted();
      if (generation) await options.beforeAttempt?.(payload);
      let response;
      const signal = options.requestTimeoutMs
        ? AbortSignal.any([
            ...(originalSignal ? [originalSignal] : []),
            AbortSignal.timeout(options.requestTimeoutMs),
          ])
        : transportSignal;
      try {
        response = await fetcher(url, { ...init, signal, body: JSON.stringify(payload) });
      } catch (error) {
        if (
          !generation ||
          originalSignal?.aborted ||
          (init.signal?.aborted && !options.sdkTimeoutFallback) ||
          standardFallback ||
          payload.service_tier !== "flex" ||
          attempt >= 2
        ) {
          throw error;
        }
        if (transportSignal?.aborted) {
          transportSignal = AbortSignal.any([
            ...(originalSignal ? [originalSignal] : []),
            AbortSignal.timeout(options.fallbackTimeoutMs ?? 3600000),
          ]);
        }
        payload = { ...payload, service_tier: "default" };
        standardFallback = true;
        options.onTierFallback?.();
        continue;
      }

      if (![408, 429, 500, 502, 503, 504].includes(response.status)) return response;
      let error = {};
      try {
        error = (await response.clone().json()).error ?? {};
      } catch {
        // Keep the response when its error body cannot be parsed.
      }
      const text = `${error.code ?? ""} ${error.type ?? ""} ${error.message ?? ""}`;
      if (
        /insufficient_quota|credit_balance_exhausted|spend_limit|usage_limit|invalid_api_key|authentication/i.test(
          text,
        )
      ) {
        return response;
      }
      const unavailable = /resource.?unavailable|flex.?unavailable|insufficient.*capacity/i.test(
        text,
      );
      const retryAfter = retryDelayMs(response, error);
      if (retryAfter !== undefined) await wait(retryAfter, originalSignal);
      if (attempt >= 2) return response;
      if (retryAfter === undefined && !unavailable && response.status !== 408) {
        await wait(1000 * 2 ** attempt, originalSignal);
      }
      originalSignal?.throwIfAborted();
      await response.body?.cancel();
      if (
        generation &&
        !standardFallback &&
        payload.service_tier === "flex" &&
        (unavailable || response.status === 408 || response.status >= 500)
      ) {
        payload = { ...payload, service_tier: "default" };
        standardFallback = true;
        options.onTierFallback?.();
      }
    }
  };
}

export function wrapProvider(provider, count = fetch, createAssistantMessageEventStream) {
  if (typeof createAssistantMessageEventStream !== "function") {
    throw Error("Orchestrator Pi event stream factory unavailable");
  }

  const standardSessions = new Set();
  const guard =
    (method) =>
    (model, context, options = {}) => {
      const budget = requestBudget();
      if (budget && !["gpt-6-luna", "gpt-6-luna-standard"].includes(model.id)) {
        throw Error("Orchestrator API model not approved");
      }

      const targetModels = {
        "gpt-6-luna": "gpt-6-luna",
        "gpt-6-luna-standard": "gpt-6-luna",
        "gpt-6.1-terra": "gpt-6.1-terra",
        "gpt-6.1-terra-standard": "gpt-6.1-terra",
      };
      if (!targetModels[model.id]) return provider[method](model, context, options);

      const onPayload = options.onPayload;
      const sessionKey = `${options.sessionId ?? "current"}:${targetModels[model.id]}`;
      let inputTokens = 0;
      let activeTier = ["gpt-6-luna", "gpt-6.1-terra"].includes(model.id) ? "flex" : "default";
      const guarded = {
        ...options,
        fetch: resilientOpenAiFetch(options.fetch ?? fetch, {
          signal: options.signal,
          sdkTimeoutFallback: true,
          beforeAttempt: budget ? (payload) => budget.reserve(payload, inputTokens) : undefined,
          onTierFallback: () => {
            activeTier = "default";
            standardSessions.add(sessionKey);
          },
        }),
        maxRetries: 0,
        timeoutMs: ["gpt-6-luna", "gpt-6.1-terra"].includes(model.id)
          ? Math.max(options.timeoutMs ?? 0, 3600000)
          : options.timeoutMs,
        onPayload: async (original, payloadModel) => {
          let payload = (await onPayload?.(original, payloadModel)) ?? original;
          if (
            !payload ||
            typeof payload !== "object" ||
            payload.model !== targetModels[model.id] ||
            !options.apiKey
          ) {
            throw Error("Token guard: request or authentication unavailable");
          }
          if (standardSessions.has(sessionKey)) payload = { ...payload, service_tier: "default" };
          const body = Object.fromEntries(
            countFields
              .filter((field) => payload[field] !== undefined)
              .map((field) => [field, payload[field]]),
          );
          const response = await resilientOpenAiFetch(count, {
            signal: options.signal,
            requestTimeoutMs: 10000,
          })("https://api.openai.com/v1/responses/input_tokens", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${options.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal: options.signal,
          });
          if (!response.ok)
            throw Error(`Token guard: token count failed (HTTP ${response.status})`);
          const result = await response.json();
          if (
            !Number.isSafeInteger(result.input_tokens) ||
            result.input_tokens < 0 ||
            result.input_tokens > 272000
          ) {
            throw Error("Token guard: input exceeds 272000 tokens or count is invalid");
          }
          inputTokens = result.input_tokens;
          activeTier = payload.service_tier ?? "default";
          return budget ? budget.cap(payload, inputTokens) : payload;
        },
      };

      const output = createAssistantMessageEventStream();
      (async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const attemptOptions =
            attempt === 0
              ? guarded
              : {
                  ...guarded,
                  samplingParams: {
                    ...options.samplingParams,
                    model: targetModels[model.id],
                    service_tier: "default",
                  },
                };
          let bufferedStart;
          let contentStarted = false;
          let fallback = false;
          for await (const event of provider[method](model, context, attemptOptions)) {
            if (event.type === "start" && !contentStarted) {
              bufferedStart = event;
              continue;
            }
            if (
              event.type === "error" &&
              !contentStarted &&
              !event.error.content.length &&
              !options.signal?.aborted &&
              attempt === 0 &&
              activeTier === "flex" &&
              /flex processing is temporarily unavailable|resource.?unavailable|flex.?unavailable/i.test(
                event.error.errorMessage ?? "",
              )
            ) {
              fallback = true;
              break;
            }
            if (bufferedStart) {
              output.push(bufferedStart);
              bufferedStart = undefined;
            }
            contentStarted = true;
            output.push(event);
          }
          if (!fallback) {
            output.end();
            return;
          }
          activeTier = "default";
          standardSessions.add(sessionKey);
        }
      })().catch((error) => {
        output.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "error",
            errorMessage:
              error instanceof Error && error.message.startsWith("Orchestrator ")
                ? error.message
                : "Pi provider request failed before completion",
            timestamp: Date.now(),
          },
        });
        output.end();
      });
      return output;
    };

  return { ...provider, stream: guard("stream"), streamSimple: guard("streamSimple") };
}

export default async function (pi) {
  // Check the close barrier before importing/registering the provider. A closed
  // or invalid task ledger therefore fails before Pi can select this provider.
  requestBudget();
  const modules = resolvePiAiModules();
  const [{ openaiProvider }, { createAssistantMessageEventStream }] = await Promise.all([
    import(modules.provider),
    import(modules.index),
  ]);
  pi.registerProvider(wrapProvider(openaiProvider(), fetch, createAssistantMessageEventStream));
}
