import path from "node:path";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { canonicalPath, hash, routeAllowsPath, type Config } from "./contracts.ts";
import { Git } from "./git.ts";
import { Store } from "./store.ts";
import { execFile } from "node:child_process";
import { codeRoot } from "./settings-files.ts";
import { PaseoProvider } from "./provider.ts";

// Research is a separate read-only contract: no commands, writes or task budget.
export const researchRequestSchema = z.strictObject({
  repository: z.string(),
  query: z.string().min(2).max(200),
  paths: z.array(z.string().min(1)).min(1).max(20),
  // Ignored legacy request input; repository and path ACLs remain active.
  scope: z.string().optional(),
  synthesize: z.boolean().optional(),
});
export type ResearchRequest = z.infer<typeof researchRequestSchema>;
export interface ResearchEvidence {
  id: string;
  source: string;
  startLine: number;
  endLine: number;
  revision: string;
  observedAt: string;
  summary: string;
  excerpt: string;
}
export interface ResearchResult {
  id: string;
  mode: "deterministic-read-only";
  revision: string;
  cached: boolean;
  evidence: ResearchEvidence[];
  openQuestions: string[];
  synthesis?: { routeId: string; summary: string; evidenceIds: string[]; openQuestions: string[] };
  skipped?: { routeId: string; reason: string }[];
}
export function synthesisEvidenceSafe(evidence: ResearchEvidence[]): boolean {
  return evidence.every(
    (item) =>
      !/(?:^|[\\/])(?:appsettings[^\\/]*\.json|[^\\/]*\.config|launchSettings\.json)|\.(?:publishsettings|pfx|p12|pem|key)$/i.test(
        item.source,
      ) &&
      !/(?:password|pwd|secret|token|api[_-]?key|accountkey|sharedaccesskey|connectionstring)["']?\s*[:=]|-----BEGIN[^\r\n]*PRIVATE KEY|\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\./i.test(
        item.excerpt,
      ),
  );
}

export function research(
  store: Store,
  config: Config,
  input: ResearchRequest,
  workspace: string,
  now = Date.now(),
): ResearchResult {
  const request = researchRequestSchema.parse(input),
    repository = canonicalPath(request.repository);
  const relative = path.relative(canonicalPath(workspace), repository);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw Error("RESEARCH_SCOPE_MISMATCH");
  const git = new Git(config.gitExecutable);
  if (canonicalPath(git.run(repository, ["rev-parse", "--show-toplevel"])) !== repository)
    throw Error("RESEARCH_REPOSITORY_REQUIRED");
  const head = git.run(repository, ["rev-parse", "HEAD"]);
  const tracked = new Set(git.run(repository, ["ls-files"]).split("\n"));
  const sources = request.paths.map((name) => {
    if (
      !tracked.has(name) ||
      name.split(/[\\/]/).some((part) => part === ".." || part === ".git") ||
      /(?:^|\/)(?:\.env(?:\.|$)|auth\.json|credentials|secrets)(?:\/|\.|$)/i.test(name)
    )
      throw Error("RESEARCH_PATH_NOT_APPROVED");
    const file = canonicalPath(path.join(repository, name)),
      relative = path.relative(repository, file);
    if (relative.startsWith("..") || path.isAbsolute(relative) || statSync(file).size > 128000)
      throw Error("RESEARCH_FILE_UNSAFE");
    const text = readFileSync(file, "utf8");
    if (text.includes("\0") || /sk-[a-zA-Z0-9_-]{16,}/.test(text))
      throw Error("RESEARCH_FILE_UNSAFE");
    return { name, text, revision: hash(text) };
  });
  const revision = hash({ head, files: sources.map(({ name, revision }) => ({ name, revision })) });
  const id = hash({ request, repository, revision });
  const prior = store.db
    .prepare("SELECT result_json,expires_ms FROM research_requests WHERE id=?")
    .get(id) as { result_json: string; expires_ms: number } | undefined;
  if (prior && prior.expires_ms > now) return { ...JSON.parse(prior.result_json), cached: true };
  const evidence: ResearchEvidence[] = [];
  for (const source of sources) {
    const lines = source.text.split(/\r?\n/);
    for (let index = 0; index < lines.length && evidence.length < 20; index++) {
      if (!lines[index].toLowerCase().includes(request.query.toLowerCase())) continue;
      const start = Math.max(0, index - 2),
        end = Math.min(lines.length, index + 3);
      evidence.push({
        id: hash({ source: source.name, revision: source.revision, index }),
        source: path.join(repository, source.name),
        startLine: start + 1,
        endLine: end,
        revision: source.revision,
        observedAt: new Date(now).toISOString(),
        summary: `Literal match for ${request.query} at line ${index + 1}`,
        excerpt: lines.slice(start, end).join("\n").slice(0, 3000),
      });
    }
  }
  // No provider receives repository data here. Model synthesis/remote connectors
  // require a separately verified read-only capability and explicit source ACL.
  const result: ResearchResult = {
    id,
    mode: "deterministic-read-only",
    revision,
    cached: false,
    evidence,
    openQuestions: evidence.length
      ? []
      : [
          "No literal evidence found in the approved tracked files. Refine the search or approve another source.",
        ],
  };
  store.db
    .prepare(
      "INSERT INTO research_requests VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET result_json=excluded.result_json,expires_ms=excluded.expires_ms",
    )
    .run(id, JSON.stringify(request), JSON.stringify(result), revision, now + 300000);
  return result;
}

export async function researchWithSynthesis(
  store: Store,
  config: Config,
  input: ResearchRequest,
  workspace: string,
): Promise<ResearchResult> {
  const result = research(store, config, input, workspace);
  if (!input.synthesize || result.cached || !result.evidence.length) return result;
  const skipped = [{ routeId: "haiku-api", reason: "no-confirmed-api-credential" }];
  if (!synthesisEvidenceSafe(result.evidence)) {
    result.skipped = [{ routeId: "all-models", reason: "source-may-contain-credentials" }];
    result.openQuestions.push(
      "Model synthesis blocked: an approved local source may contain credentials.",
    );
    store.db
      .prepare("UPDATE research_requests SET result_json=? WHERE id=?")
      .run(JSON.stringify(result), result.id);
    return result;
  }
  const go = config.routes.find(
    (route) => route.access === "opencode-go" && route.model === "opencode-go/deepseek-v4.1-flash",
  );
  const api = (config.roleRoutes?.["implement-simple"] ?? [])
    .map((id) => config.routes.find((route) => route.id === id))
    .find(
      (route) =>
        route?.access === "openai-api" && /^openai\/gpt-6-luna(?:-standard)?$/.test(route.model),
    );
  const routes = [go, api].filter((route) => !!route);
  for (const route of routes) {
    if (
      store.stopped() ||
      !route.enabled ||
      !routeAllowsPath(route, input.repository) ||
      store.circuitOpen(route.access, Date.now()) ||
      store.circuitOpen(`route:${route.id}`, Date.now())
    ) {
      skipped.push({
        routeId: route.id,
        reason: "route-disabled-repository-or-provider-blocked",
      });
      continue;
    }
    const provider = new PaseoProvider(config.daemonUrl);
    const requestKey = `research:${result.id}`;
    let reserved = false;
    try {
      // Auth checks credential presence/launcher identity without returning it.
      await provider.authorize(route, input.repository);
      const env = { ...process.env };
      delete env.PASEO_ORCHESTRATOR_BUDGET_FILE;
      if (route.access === "openai-api") {
        // Persistent identity prevents replay after a lost result/reconnect.
        // These reservations participate in the same normal-API allocation.
        store.reserveResearch(requestKey, route, config);
        reserved = true;
        env.PASEO_ORCHESTRATOR_BUDGET_FILE = provider.prepareBudget(requestKey);
      }
      const text = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          process.execPath,
          [path.join(codeRoot, "scripts/explorer-synthesis.mjs")],
          {
            cwd: canonicalPath(input.repository),
            encoding: "utf8",
            env,
            ...(route.access === "opencode-go" ? { timeout: 180000 } : {}),
            maxBuffer: 256000,
            windowsHide: true,
          },
          (error, stdout) => {
            if (error) {
              reject(Error("EXPLORER_MODEL_UNAVAILABLE"));
              return;
            }
            resolve(stdout);
          },
        );
        child.stdin?.end(
          JSON.stringify({
            id: result.id,
            model: route.model,
            reasoning: route.reasoning,
            question: input.query,
            evidence: result.evidence,
          }),
        );
      });
      const envelope = z.object({ text: z.string(), tools: z.literal(0) }).parse(JSON.parse(text));
      const synthesis = z
        .strictObject({
          summary: z.string().min(1).max(8000),
          evidenceIds: z.array(z.string()).min(1).max(20),
          openQuestions: z.array(z.string().max(1000)).max(20),
        })
        .parse(JSON.parse(envelope.text.replace(/^```(?:json)?\s*|\s*```$/g, "")));
      if (synthesis.evidenceIds.some((id) => !result.evidence.some((item) => item.id === id)))
        throw Error("EXPLORER_SOURCE_NOT_VERIFIED");
      result.synthesis = { routeId: route.id, ...synthesis };
    } catch {
      skipped.push({ routeId: route.id, reason: "model-only-synthesis-unavailable" });
    } finally {
      if (reserved) {
        try {
          store.settleResearch(requestKey, provider.freezeApiBudget(requestKey).debited);
        } catch {
          result.synthesis = undefined;
          skipped.push({
            routeId: route.id,
            reason: "api-accounting-unknown-reservation-retained",
          });
        }
      }
    }
    if (result.synthesis) break;
  }
  if (!result.synthesis) {
    result.openQuestions.push(
      "Model synthesis unavailable. Use the supplied evidence; no unguarded API fallback was started.",
    );
  }
  result.skipped = skipped;
  store.db
    .prepare("UPDATE research_requests SET result_json=? WHERE id=?")
    .run(JSON.stringify(result), result.id);
  return result;
}
