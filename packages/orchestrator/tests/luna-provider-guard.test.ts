import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

function createEventStream() {
  const queue: unknown[] = [];
  const waiters: ((result: IteratorResult<unknown>) => void)[] = [];
  let ended = false;
  return {
    push(event: unknown) {
      if (ended) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ value: event, done: false });
      else queue.push(event);
    },
    end() {
      ended = true;
      while (waiters.length) waiters.shift()!({ value: undefined, done: true });
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length) {
          yield queue.shift();
          continue;
        }
        if (ended) return;
        const next = await new Promise<IteratorResult<unknown>>((resolve) => waiters.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    },
  };
}

async function collectEvents(stream: AsyncIterable<unknown>) {
  const events = [];
  for await (const event of stream)
    events.push(event as { type?: string; error?: { errorMessage?: string } });
  return events;
}

test("the Luna guard binds its ledger to the owned controller state before fake generation transport", async () => {
  const { wrapProvider } = await import(
    new URL("../pi/extensions/luna-provider-guard.mjs", import.meta.url).href
  );
  const stateDirectory = path.join(process.cwd(), "state");
  mkdirSync(stateDirectory, { recursive: true });
  const temporaryRoot = mkdtempSync(path.join(stateDirectory, "luna-provider-guard-"));
  const dataRoot = path.join(temporaryRoot, "data");
  const budgetDirectory = path.join(dataRoot, "state", "pi-budgets");
  const stateFile = path.join(dataRoot, "state", "controller.sqlite");
  const otherStateFile = path.join(temporaryRoot, "other-controller.sqlite");
  const budgetName = `${createHash("sha256").update("offline-guard-test").digest("hex")}.json`;
  const budgetFile = path.join(budgetDirectory, budgetName);
  const otherBudgetFile = path.join(temporaryRoot, "other-data", "state", "pi-budgets", budgetName);
  const environmentKeys = [
    "PASEO_ORCHESTRATOR_DATA_ROOT",
    "ORCHESTRATOR_STATE",
    "PASEO_ORCHESTRATOR_BUDGET_FILE",
  ] as const;
  const previousEnvironment = Object.fromEntries(
    environmentKeys.map((key) => [key, process.env[key]]),
  );

  mkdirSync(budgetDirectory, { recursive: true });
  mkdirSync(path.dirname(otherBudgetFile), { recursive: true });
  writeFileSync(stateFile, "");
  writeFileSync(otherStateFile, "");
  process.env.PASEO_ORCHESTRATOR_DATA_ROOT = dataRoot;
  process.env.ORCHESTRATOR_STATE = stateFile;
  process.env.PASEO_ORCHESTRATOR_BUDGET_FILE = budgetFile;

  const makeLedger = (overrides: Record<string, unknown> = {}) => ({
    limit: 20_000,
    debited: 0,
    requests: 0,
    controllerState: stateFile,
    ...overrides,
  });
  const saveLedger = (file: string, ledger: object) =>
    writeFileSync(file, JSON.stringify(ledger), { mode: 0o600 });
  saveLedger(budgetFile, makeLedger());
  saveLedger(otherBudgetFile, makeLedger());

  const calls: { endpoint: string; payload?: Record<string, unknown> }[] = [];
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    assert.equal(
      target.origin,
      "https://api.openai.com",
      "guard uses only the approved fake API host",
    );
    const payload =
      typeof init.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({ endpoint: target.pathname, payload });
    if (target.pathname === "/v1/responses/input_tokens") {
      return new Response(JSON.stringify({ input_tokens: 100 }), { status: 200 });
    }
    if (target.pathname === "/v1/responses")
      return new Response('{"id":"fake-response"}', { status: 200 });
    throw Error(`Unexpected fake endpoint: ${target.pathname}`);
  };

  const fakeProvider = {
    async *stream(model: { id: string }, _context: unknown, options: Record<string, unknown>) {
      const onPayload = options.onPayload as (
        payload: Record<string, unknown>,
        model: unknown,
      ) => Promise<Record<string, unknown>>;
      const send = options.fetch as typeof fetch;
      const payload = await onPayload(
        {
          model: model.id,
          input: "offline regression prompt",
          service_tier: "flex",
          max_output_tokens: 8192,
        },
        model,
      );
      const response = await send("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw Error("Fake generation request failed");
      yield { type: "done", message: { role: "assistant", content: [] } };
    },
    streamSimple() {
      throw Error("Unexpected streamSimple call");
    },
  };
  const guardedProvider = wrapProvider(fakeProvider, fakeFetch, createEventStream);
  const model = { id: "gpt-6-luna", api: "openai-responses", provider: "openai" };
  const options = {
    apiKey: "offline-test-only",
    fetch: fakeFetch,
    sessionId: "offline-guard-test",
  };
  const generationCount = () => calls.filter((call) => call.endpoint === "/v1/responses").length;
  const errorMessage = (events: { type?: string; error?: { errorMessage?: string } }[]) =>
    events.find((event) => event.type === "error")?.error?.errorMessage;

  try {
    const accepted = await collectEvents(guardedProvider.stream(model, { messages: [] }, options));
    assert.equal(
      accepted.some((event) => event.type === "done"),
      true,
    );
    assert.deepEqual(
      calls.map((call) => call.endpoint),
      ["/v1/responses/input_tokens", "/v1/responses"],
    );
    assert.equal(calls[1].payload?.model, "gpt-6-luna");
    assert.equal(calls[1].payload?.max_output_tokens, 3980);
    assert.deepEqual(
      JSON.parse(readFileSync(budgetFile, "utf8")),
      makeLedger({
        debited: 20_000,
        requests: 1,
        freezeProtocol: 1,
        lastServiceTier: "flex",
        standardRequests: 0,
      }),
    );

    process.env.PASEO_ORCHESTRATOR_BUDGET_FILE = otherBudgetFile;
    const beforeCrossRoot = calls.length;
    assert.throws(
      () => guardedProvider.stream(model, { messages: [] }, options),
      /Orchestrator budget path invalid/,
    );
    assert.equal(
      calls.length,
      beforeCrossRoot,
      "cross-root ledger is rejected before token-count transport",
    );

    process.env.PASEO_ORCHESTRATOR_BUDGET_FILE = budgetFile;
    saveLedger(budgetFile, makeLedger({ controllerState: otherStateFile }));
    const beforeStateMismatch = calls.length;
    assert.throws(
      () => guardedProvider.stream(model, { messages: [] }, options),
      /Orchestrator budget identity invalid/,
    );
    assert.equal(
      calls.length,
      beforeStateMismatch,
      "ledger bound to another controller state is rejected before transport",
    );

    saveLedger(budgetFile, makeLedger({ closed: true, freezeProtocol: 1 }));
    const beforeClosed = calls.length;
    assert.throws(
      () => guardedProvider.stream(model, { messages: [] }, options),
      /Orchestrator API task is closed/,
    );
    assert.equal(
      calls.length,
      beforeClosed,
      "closed ledger is rejected before token-count transport",
    );

    saveLedger(budgetFile, makeLedger({ limit: 5000, freezeProtocol: 1 }));
    const beforeInsufficient = calls.length;
    const beforeInsufficientGenerations = generationCount();
    assert.match(
      errorMessage(await collectEvents(guardedProvider.stream(model, { messages: [] }, options))) ??
        "",
      /Orchestrator task budget exhausted/,
    );
    assert.equal(
      calls.length,
      beforeInsufficient + 1,
      "only the fake token-count request runs before cap rejection",
    );
    assert.equal(
      generationCount(),
      beforeInsufficientGenerations,
      "insufficient budget blocks fake generation transport",
    );
  } finally {
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
