import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { canonicalPath, hash } from "./contracts.ts";
import { appRoot } from "./settings-files.ts";

const bindingSchema = z.object({
  version: z.literal(1),
  generation: z.string().uuid(),
  monitorFile: z.string(),
  startedAt: z.number(),
});
const sampleSchema = z.object({
  version: z.literal(1),
  hostPid: z.number().int().positive(),
  rootPid: z.number().int().positive(),
  agentPid: z.number().int().positive(),
  activeChildren: z.number().int().nonnegative(),
  covered: z.boolean(),
  agentAlive: z.boolean(),
  closed: z.boolean(),
  updatedAt: z.number(),
});
export interface ProcessInventory {
  verified: boolean;
  runningChildren: number | null;
  generation?: string;
  sampledAt?: number;
  closed?: boolean;
}
const unknown: ProcessInventory = { verified: false, runningChildren: null };
export function processMonitorFile(requestKey: string): string {
  return path.join(appRoot, "state/process-monitors", `${hash(requestKey)}.json`);
}
export function blockedToolWasRecorded(
  requestKey: string,
  callId: string,
  input: unknown,
  observedReason?: string,
): boolean {
  if (!observedReason || !/^ORCHESTRATOR_[A-Z_]+$/.test(observedReason)) return false;
  try {
    const contents = readFileSync(`${processMonitorFile(requestKey)}.policy.jsonl`, "utf8");
    if (contents.length > 1000000) return false;
    return contents
      .trim()
      .split("\n")
      .some((line) => {
        const value = JSON.parse(line);
        return (
          value.callId === callId &&
          value.inputHash === hash(input) &&
          value.reason === observedReason
        );
      });
  } catch {
    return false;
  }
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
export function readProcessInventory(requestKey: string): ProcessInventory {
  try {
    const file = processMonitorFile(requestKey),
      directory = canonicalPath(path.dirname(file));
    const binding = bindingSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    if (
      path.basename(binding.monitorFile) !== `${hash(requestKey)}-${binding.generation}.json` ||
      canonicalPath(path.dirname(binding.monitorFile)) !== directory ||
      path.dirname(canonicalPath(binding.monitorFile)) !== directory
    )
      return unknown;
    const sample = sampleSchema.parse(JSON.parse(readFileSync(binding.monitorFile, "utf8")));
    if (
      !sample.covered ||
      sample.agentPid !== sample.rootPid ||
      sample.updatedAt < binding.startedAt ||
      sample.updatedAt > Date.now() + 1000
    )
      return unknown;
    if (sample.closed)
      return !sample.agentAlive && sample.activeChildren === 0 && !alive(sample.rootPid)
        ? {
            verified: true,
            runningChildren: 0,
            generation: binding.generation,
            sampledAt: sample.updatedAt,
            closed: true,
          }
        : unknown;
    if (
      !sample.agentAlive ||
      Date.now() - sample.updatedAt > 5000 ||
      !alive(sample.hostPid) ||
      !alive(sample.rootPid)
    )
      return unknown;
    return {
      verified: true,
      runningChildren: sample.activeChildren,
      generation: binding.generation,
      sampledAt: sample.updatedAt,
    };
  } catch {
    return unknown;
  }
}
export async function settledProcessInventory(requestKey: string): Promise<ProcessInventory> {
  const observedAt = Date.now();
  const first = readProcessInventory(requestKey);
  if (!first.verified || first.runningChildren !== 0 || first.closed) return first;
  // A stale zero from before the completed tool is not a settlement proof.
  await setTimeout(400);
  const second = readProcessInventory(requestKey);
  if (
    !second.verified ||
    second.generation !== first.generation ||
    second.sampledAt! <= first.sampledAt! ||
    second.sampledAt! <= observedAt
  )
    return unknown;
  return second;
}
