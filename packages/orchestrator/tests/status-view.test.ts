import { strict as assert } from "node:assert";
import { test } from "node:test";
import { decisionView } from "../paseo-plugin/shared/status-view.ts";

test("latest decision shows the effective result and never substitutes an older result", () => {
  const detail = {
    id: "new",
    source: "decisions",
    response: "saved response",
    result: JSON.stringify({ intent: "new-task", needImplementation: true }),
  };
  assert.deepEqual(decisionView({ latestId: "new", detail, loading: false, error: false }), {
    status: "Decision-Ergebnis",
    summary: "Neuer Auftrag · Umsetzung",
  });
  assert.deepEqual(decisionView({ latestId: "newer", detail, loading: false, error: false }), {
    status: "Decision ausstehend.",
    summary: "",
  });
});

test("fallback, pending and errors cannot appear as a successful model decision", () => {
  const detail = {
    id: "new",
    source: "fallback",
    response: null,
    result: JSON.stringify({ complexity: "unknown" }),
  };
  assert.deepEqual(decisionView({ latestId: "new", detail, loading: false, error: false }), {
    status: "Lokaler Controller-Fallback",
    summary: "Unbekannt",
  });
  assert.deepEqual(
    decisionView({
      latestId: "new",
      detail: { ...detail, source: "pending" },
      loading: false,
      error: false,
    }),
    { status: "Decision ausstehend.", summary: "" },
  );
  assert.deepEqual(decisionView({ latestId: "new", detail, loading: false, error: true }), {
    status: "Decision konnte nicht geladen werden.",
    summary: "",
  });
});
