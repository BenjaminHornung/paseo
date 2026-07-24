import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";

import { writeJsonFileAtomic } from "../atomic-file.js";
import { AgentFeatureSchema, AgentStatusSchema } from "../messages.js";
import { toStoredAgentRecord } from "./agent-projections.js";
import type { ManagedAgent } from "./agent-manager.js";
import type { AgentSessionConfig } from "./agent-sdk-types.js";
import { AgentOwnerSchema, daemonExecutionKey, type DaemonAgentOwner } from "./agent-owner.js";

const SERIALIZABLE_CONFIG_SCHEMA = z
  .object({
    modeId: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    thinkingOptionId: z.string().nullable().optional(),
    featureValues: z.record(z.string(), z.unknown()).nullable().optional(),
    extra: z.record(z.string(), z.any()).nullable().optional(),
    systemPrompt: z.string().nullable().optional(),
    mcpServers: z.record(z.string(), z.any()).nullable().optional(),
  })
  .nullable()
  .optional();

const PERSISTENCE_HANDLE_SCHEMA = z
  .object({
    provider: z.string(),
    sessionId: z.string(),
    nativeHandle: z.any().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .nullable()
  .optional();

const CLIENT_MESSAGE_ADMISSION_ENTRY_STATUS_SCHEMA = z.enum([
  "pending",
  "committed",
  "legacy_unverifiable",
]);

const CLIENT_MESSAGE_ADMISSION_ENTRY_SCHEMA = z.object({
  fingerprint: z.string(),
  status: CLIENT_MESSAGE_ADMISSION_ENTRY_STATUS_SCHEMA,
});

export const MAX_CLIENT_MESSAGE_ID_LENGTH = 256;
export const MAX_CLIENT_MESSAGE_ADMISSIONS = 4_096;

const CLIENT_MESSAGE_ADMISSION_ENTRIES_SCHEMA = z
  .custom<Record<string, unknown>>((value) => typeof value === "object" && value !== null)
  .transform(
    (value, ctx): Record<string, z.infer<typeof CLIENT_MESSAGE_ADMISSION_ENTRY_SCHEMA>> => {
      const normalized = Object.create(null) as Record<
        string,
        z.infer<typeof CLIENT_MESSAGE_ADMISSION_ENTRY_SCHEMA>
      >;
      for (const messageId of Object.getOwnPropertyNames(value)) {
        const parsed = CLIENT_MESSAGE_ADMISSION_ENTRY_SCHEMA.safeParse(value[messageId]);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            ctx.addIssue({
              ...issue,
              path: ["entries", messageId, ...issue.path],
            });
          }
          continue;
        }
        Object.defineProperty(normalized, messageId, {
          value: parsed.data,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return normalized;
    },
  );

const CLIENT_MESSAGE_ADMISSION_LEDGER_SCHEMA = z
  .object({
    version: z.literal(1),
    entries: CLIENT_MESSAGE_ADMISSION_ENTRIES_SCHEMA,
    legacyOverflow: z.boolean().optional(),
  })
  .superRefine((ledger, ctx) => {
    const messageIds = Object.keys(ledger.entries);
    if (messageIds.length > MAX_CLIENT_MESSAGE_ADMISSIONS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `clientMessageAdmissions exceeds ${MAX_CLIENT_MESSAGE_ADMISSIONS} entries`,
      });
    }
    for (const messageId of messageIds) {
      if (messageId.length > MAX_CLIENT_MESSAGE_ID_LENGTH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `clientMessageAdmissions contains an overlong messageId (${messageId.length} > ${MAX_CLIENT_MESSAGE_ID_LENGTH})`,
          path: ["entries", messageId],
        });
      }
    }
  });

const STORED_AGENT_SCHEMA = z.object({
  id: z.string(),
  provider: z.string(),
  cwd: z.string(),
  workspaceId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastActivityAt: z.string().optional(),
  lastUserMessageAt: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  labels: z.record(z.string(), z.string()).default({}),
  lastStatus: AgentStatusSchema.default("closed"),
  lastModeId: z.string().nullable().optional(),
  config: SERIALIZABLE_CONFIG_SCHEMA,
  runtimeInfo: z
    .object({
      provider: z.string(),
      sessionId: z.string().nullable(),
      model: z.string().nullable().optional(),
      thinkingOptionId: z.string().nullable().optional(),
      modeId: z.string().nullable().optional(),
      extra: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  features: z.array(AgentFeatureSchema).optional(),
  persistence: PERSISTENCE_HANDLE_SCHEMA,
  lastError: z.string().nullable().optional(),
  requiresAttention: z.boolean().optional(),
  attentionReason: z.enum(["finished", "error", "permission"]).nullable().optional(),
  attentionTimestamp: z.string().nullable().optional(),
  internal: z.boolean().optional(),
  archivedAt: z.string().nullable().optional(),
  owner: AgentOwnerSchema.optional(),
  clientMessageAdmissions: CLIENT_MESSAGE_ADMISSION_LEDGER_SCHEMA.optional(),
});

export type ClientMessageAdmissionDisposition =
  | "new"
  | "duplicate"
  | "conflict"
  | "pending"
  | "capacity"
  | "legacy"
  | "legacy_unverifiable";
export type ClientMessageAdmissionLedger = z.infer<typeof CLIENT_MESSAGE_ADMISSION_LEDGER_SCHEMA>;

export type SerializableAgentConfig = Pick<
  AgentSessionConfig,
  | "modeId"
  | "model"
  | "thinkingOptionId"
  | "featureValues"
  | "extra"
  | "systemPrompt"
  | "mcpServers"
>;

export type StoredAgentRecord = z.infer<typeof STORED_AGENT_SCHEMA>;
export function parseStoredAgentRecord(value: unknown): StoredAgentRecord {
  const record = STORED_AGENT_SCHEMA.parse(value);
  if (!record.clientMessageAdmissions) {
    return record;
  }
  return {
    ...record,
    clientMessageAdmissions: normalizeClientMessageAdmissionLedger(record.clientMessageAdmissions),
  };
}

function copyClientMessageAdmissionEntries<
  T extends {
    fingerprint: string;
    status: z.infer<typeof CLIENT_MESSAGE_ADMISSION_ENTRY_STATUS_SCHEMA>;
  },
>(entries: Record<string, T>): Record<string, T> {
  const normalized = Object.create(null) as Record<string, T>;
  for (const messageId of Object.getOwnPropertyNames(entries)) {
    Object.defineProperty(normalized, messageId, {
      value: entries[messageId],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return normalized;
}

function normalizeClientMessageAdmissionLedger(
  ledger: ClientMessageAdmissionLedger,
): ClientMessageAdmissionLedger {
  return {
    ...ledger,
    entries: copyClientMessageAdmissionEntries(ledger.entries),
  };
}

export class AgentStorage {
  private cache: Map<string, StoredAgentRecord> = new Map();
  private pathById: Map<string, string> = new Map();
  private pathsById: Map<string, Set<string>> = new Map();
  private pendingWrites: Map<string, Promise<void>> = new Map();
  private deleting: Set<string> = new Set();
  private daemonAgentIdsByExecution: Map<string, string> = new Map();
  private daemonExecutionKeysByAgentId: Map<string, string> = new Map();
  private loaded = false;
  private baseDir: string;
  private loadPromise: Promise<StoredAgentRecord[]> | null = null;
  private logger: Logger;

  constructor(baseDir: string, logger: Logger) {
    this.baseDir = baseDir;
    this.logger = logger.child({ module: "agent", component: "agent-storage" });
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async list(): Promise<StoredAgentRecord[]> {
    await this.load();
    return Array.from(this.cache.values());
  }

  async get(agentId: string): Promise<StoredAgentRecord | null> {
    await this.load();
    return this.cache.get(agentId) ?? null;
  }

  async findByDaemonExecution(owner: DaemonAgentOwner): Promise<StoredAgentRecord | null> {
    await this.load();
    const agentId = this.daemonAgentIdsByExecution.get(daemonExecutionKey(owner));
    return agentId ? (this.cache.get(agentId) ?? null) : null;
  }

  async upsert(record: StoredAgentRecord): Promise<void> {
    await this.load();
    await this.queueRecordWrite(record);
  }

  async admitClientMessage(
    agentId: string,
    messageId: string,
    fingerprint: string,
  ): Promise<ClientMessageAdmissionDisposition> {
    await this.load();
    let disposition: ClientMessageAdmissionDisposition = "new";
    const previous = this.pendingWrites.get(agentId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.deleting.has(agentId)) {
          throw new Error(`Agent ${agentId} is being deleted`);
        }
        const record = this.cache.get(agentId);
        if (!record) {
          throw new Error(`Agent ${agentId} not found`);
        }
        const ledger = record.clientMessageAdmissions;
        if (!ledger) {
          disposition = "legacy";
          return undefined;
        }
        const existing = Object.hasOwn(ledger.entries, messageId)
          ? ledger.entries[messageId]
          : undefined;
        if (existing) {
          if (existing.status === "legacy_unverifiable") {
            disposition = "legacy_unverifiable";
            return undefined;
          }
          if (existing.fingerprint !== fingerprint) {
            disposition = "conflict";
          } else if (existing.status === "committed") {
            disposition = "duplicate";
          } else {
            disposition = "pending";
          }
          return undefined;
        }
        if (
          ledger.legacyOverflow ||
          Object.keys(ledger.entries).length >= MAX_CLIENT_MESSAGE_ADMISSIONS
        ) {
          disposition = "capacity";
          return undefined;
        }
        const entries = copyClientMessageAdmissionEntries(ledger.entries);
        entries[messageId] = { fingerprint, status: "pending" };
        await this.writeRecord({
          ...record,
          clientMessageAdmissions: {
            ...ledger,
            entries,
          },
        });
        return undefined;
      });
    const tracked = next.finally(() => {
      if (this.pendingWrites.get(agentId) === tracked) {
        this.pendingWrites.delete(agentId);
      }
    });
    this.pendingWrites.set(agentId, tracked);
    await tracked;
    return disposition;
  }

  async releaseClientMessageAdmission(
    agentId: string,
    messageId: string,
    fingerprint: string,
  ): Promise<void> {
    await this.load();
    const previous = this.pendingWrites.get(agentId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.deleting.has(agentId)) {
          throw new Error(`Agent ${agentId} is being deleted`);
        }
        const record = this.cache.get(agentId);
        const ledger = record?.clientMessageAdmissions;
        const existing =
          ledger && Object.hasOwn(ledger.entries, messageId)
            ? ledger.entries[messageId]
            : undefined;
        if (
          !record ||
          !ledger ||
          existing?.fingerprint !== fingerprint ||
          existing.status !== "pending"
        ) {
          return undefined;
        }
        const entries = copyClientMessageAdmissionEntries(ledger.entries);
        delete entries[messageId];
        await this.writeRecord({
          ...record,
          clientMessageAdmissions: { ...ledger, entries },
        });
        return undefined;
      });
    const tracked = next.finally(() => {
      if (this.pendingWrites.get(agentId) === tracked) {
        this.pendingWrites.delete(agentId);
      }
    });
    this.pendingWrites.set(agentId, tracked);
    await tracked;
  }

  async commitClientMessageAdmission(
    agentId: string,
    messageId: string,
    fingerprint: string,
  ): Promise<void> {
    await this.load();
    const previous = this.pendingWrites.get(agentId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.deleting.has(agentId)) {
          throw new Error(`Agent ${agentId} is being deleted`);
        }
        const record = this.cache.get(agentId);
        const ledger = record?.clientMessageAdmissions;
        const existing =
          ledger && Object.hasOwn(ledger.entries, messageId)
            ? ledger.entries[messageId]
            : undefined;
        if (!record || !ledger || existing?.fingerprint !== fingerprint) {
          throw new Error(`Client message admission ${messageId} is no longer reserved`);
        }
        if (existing.status === "committed") {
          return undefined;
        }
        const entries = copyClientMessageAdmissionEntries(ledger.entries);
        entries[messageId] = { ...existing, status: "committed" };
        await this.writeRecord({
          ...record,
          clientMessageAdmissions: {
            ...ledger,
            entries,
          },
        });
        return undefined;
      });
    const tracked = next.finally(() => {
      if (this.pendingWrites.get(agentId) === tracked) {
        this.pendingWrites.delete(agentId);
      }
    });
    this.pendingWrites.set(agentId, tracked);
    await tracked;
  }

  async initializeClientMessageAdmissions(
    agentId: string,
    entries: Record<string, { fingerprint: string; status: "committed" | "legacy_unverifiable" }>,
    legacyOverflow: boolean,
  ): Promise<void> {
    await this.load();
    if (Object.keys(entries).length > MAX_CLIENT_MESSAGE_ADMISSIONS) {
      throw new Error("Initial client message admission ledger exceeds its durable limit");
    }
    const previous = this.pendingWrites.get(agentId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.deleting.has(agentId)) {
          throw new Error(`Agent ${agentId} is being deleted`);
        }
        const record = this.cache.get(agentId);
        if (!record) {
          throw new Error(`Agent ${agentId} not found`);
        }
        if (record.clientMessageAdmissions) {
          return undefined;
        }
        await this.writeRecord({
          ...record,
          clientMessageAdmissions: {
            version: 1,
            entries: copyClientMessageAdmissionEntries(entries),
            ...(legacyOverflow ? { legacyOverflow: true } : {}),
          },
        });
        return undefined;
      });
    const tracked = next.finally(() => {
      if (this.pendingWrites.get(agentId) === tracked) {
        this.pendingWrites.delete(agentId);
      }
    });
    this.pendingWrites.set(agentId, tracked);
    await tracked;
  }

  private queueRecordWrite(record: StoredAgentRecord): Promise<void> {
    const agentId = record.id;
    const prev = this.pendingWrites.get(agentId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        if (this.deleting.has(agentId)) {
          return undefined;
        }

        const currentLedger = this.cache.get(agentId)?.clientMessageAdmissions;
        await this.writeRecord(
          currentLedger ? { ...record, clientMessageAdmissions: currentLedger } : record,
        );
        return undefined;
      });

    const tracked = next.finally(() => {
      if (this.pendingWrites.get(agentId) === tracked) {
        this.pendingWrites.delete(agentId);
      }
    });

    this.pendingWrites.set(agentId, tracked);
    return tracked;
  }

  private async writeRecord(record: StoredAgentRecord): Promise<void> {
    const agentId = record.id;
    const nextPath = this.buildRecordPath(record);
    const previousPath = this.pathById.get(agentId);

    await writeJsonFileAtomic(nextPath, record);
    this.addIndexedPath(agentId, nextPath);

    if (previousPath && previousPath !== nextPath) {
      try {
        await fs.unlink(previousPath);
      } catch {
        // ignore cleanup errors
      }
      this.removeIndexedPath(agentId, previousPath);
    }

    this.cache.set(agentId, record);
    this.indexOwner(record);
    this.pathById.set(agentId, nextPath);
  }

  beginDelete(agentId: string): void {
    this.deleting.add(agentId);
  }

  async remove(agentId: string): Promise<void> {
    await this.load();
    this.beginDelete(agentId);
    while (this.pendingWrites.has(agentId)) {
      await this.waitForPendingWrite(agentId);
    }
    const paths = Array.from(this.pathsById.get(agentId) ?? []);
    await Promise.all(
      paths.map(async (filePath) => {
        try {
          await fs.unlink(filePath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code && code !== "ENOENT") {
            this.logger.warn(
              { err: error, agentId, filePath },
              "Failed to remove agent record file",
            );
          }
        }
      }),
    );

    this.cache.delete(agentId);
    this.removeOwnerIndex(agentId);
    this.pathById.delete(agentId);
    this.pathsById.delete(agentId);
  }

  async applySnapshot(
    agent: ManagedAgent,
    options?: { title?: string | null; internal?: boolean },
  ): Promise<void> {
    await this.load();
    await this.waitForPendingWrite(agent.id);
    const existing = (await this.get(agent.id)) ?? null;
    const hasTitleOverride =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, "title");
    const hasInternalOverride =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, "internal");
    const record = toStoredAgentRecord(agent, {
      title: hasTitleOverride ? (options?.title ?? null) : (existing?.title ?? null),
      createdAt: existing?.createdAt,
      internal: hasInternalOverride ? options?.internal : (agent.internal ?? existing?.internal),
    });

    // Preserve soft-delete/archive status across snapshot flushes.
    // `archivedAt` is not part of the ManagedAgent snapshot, so a naive projection
    // would wipe it during normal persistence (including on daemon restart).
    if (existing && existing.archivedAt !== undefined) {
      record.archivedAt = existing.archivedAt;
    }
    if (existing?.clientMessageAdmissions !== undefined) {
      record.clientMessageAdmissions = existing.clientMessageAdmissions;
    }
    await this.upsert(record);
  }

  async setTitle(agentId: string, title: string): Promise<void> {
    await this.load();
    await this.waitForPendingWrite(agentId);
    const record = await this.get(agentId);
    if (!record) {
      throw new Error(`Agent ${agentId} not found`);
    }
    await this.upsert({ ...record, title });
  }

  async flush(): Promise<void> {
    await this.load().catch(() => undefined);
    const writes = Array.from(this.pendingWrites.values());
    await Promise.allSettled(writes);
  }

  private async load(): Promise<StoredAgentRecord[]> {
    if (this.loaded) {
      return Array.from(this.cache.values());
    }

    if (!this.loadPromise) {
      this.loadPromise = this.doLoad();
    }

    return this.loadPromise;
  }

  private async doLoad(): Promise<StoredAgentRecord[]> {
    this.cache.clear();
    this.pathById.clear();
    this.pathsById.clear();
    this.daemonAgentIdsByExecution.clear();
    this.daemonExecutionKeysByAgentId.clear();

    try {
      const records = await this.scanDisk();
      this.loaded = true;
      return records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.loaded = true;
        return [];
      }
      this.logger.error({ err: error }, "Failed to load agents");
      this.loaded = true;
      return [];
    }
  }

  private async scanDisk(): Promise<StoredAgentRecord[]> {
    const records: StoredAgentRecord[] = [];
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(this.baseDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const rootRecordPaths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(this.baseDir, entry.name));

    const projectDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(this.baseDir, entry.name));

    const projectFileLists = await Promise.all(
      projectDirs.map(async (projectDir) => {
        try {
          const files = await fs.readdir(projectDir, { withFileTypes: true });
          return files
            .filter((file) => file.isFile() && file.name.endsWith(".json"))
            .map((file) => path.join(projectDir, file.name));
        } catch {
          return [];
        }
      }),
    );

    const allFilePaths = [...rootRecordPaths, ...projectFileLists.flat()];
    const loaded = await Promise.all(
      allFilePaths.map(async (filePath) => {
        const record = await this.readRecordFile(filePath);
        return record ? { record, filePath } : null;
      }),
    );

    for (const item of loaded) {
      if (!item) continue;
      const { record, filePath } = item;
      records.push(record);
      this.cache.set(record.id, record);
      this.indexOwner(record);
      this.pathById.set(record.id, filePath);
      this.addIndexedPath(record.id, filePath);
    }

    return records;
  }

  private async readRecordFile(filePath: string): Promise<StoredAgentRecord | null> {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(content);
      return parseStoredAgentRecord(parsed);
    } catch (error) {
      this.logger.error({ err: error, filePath }, "Skipping invalid agent record");
      return null;
    }
  }

  private buildRecordPath(record: StoredAgentRecord): string {
    const projectDir = projectDirNameFromCwd(record.cwd);
    return path.join(this.baseDir, projectDir, `${record.id}.json`);
  }

  private addIndexedPath(agentId: string, filePath: string): void {
    const paths = this.pathsById.get(agentId) ?? new Set<string>();
    paths.add(filePath);
    this.pathsById.set(agentId, paths);
  }

  private removeIndexedPath(agentId: string, filePath: string): void {
    const paths = this.pathsById.get(agentId);
    if (!paths) {
      return;
    }
    paths.delete(filePath);
    if (paths.size === 0) {
      this.pathsById.delete(agentId);
    }
  }

  private indexOwner(record: StoredAgentRecord): void {
    this.removeOwnerIndex(record.id);
    if (record.owner?.kind === "daemon") {
      const key = daemonExecutionKey(record.owner);
      const previousAgentId = this.daemonAgentIdsByExecution.get(key);
      if (previousAgentId && previousAgentId !== record.id) {
        this.daemonExecutionKeysByAgentId.delete(previousAgentId);
      }
      this.daemonAgentIdsByExecution.set(key, record.id);
      this.daemonExecutionKeysByAgentId.set(record.id, key);
    }
  }

  private removeOwnerIndex(agentId: string): void {
    const key = this.daemonExecutionKeysByAgentId.get(agentId);
    if (!key) return;
    if (this.daemonAgentIdsByExecution.get(key) === agentId) {
      this.daemonAgentIdsByExecution.delete(key);
    }
    this.daemonExecutionKeysByAgentId.delete(agentId);
  }

  private async waitForPendingWrite(agentId: string): Promise<void> {
    await (this.pendingWrites.get(agentId) ?? Promise.resolve()).catch(() => undefined);
  }
}

function projectDirNameFromCwd(cwd: string): string {
  // path.win32.parse handles drive letters, UNC roots, and Unix roots on all platforms
  const { root } = path.win32.parse(cwd);
  const withoutRoot = cwd.slice(root.length).replace(/[\\/]+$/, "");
  // Sanitize root: strip colons and separators, keep letters (e.g. "C:\" → "C", "\\server\share\" → "server-share")
  const sanitizedRoot = root.replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "");
  const prefix = sanitizedRoot ? sanitizedRoot + "-" : "";
  if (!withoutRoot) {
    return sanitizedRoot || "root";
  }
  return prefix + withoutRoot.replace(/[\\/]+/g, "-");
}
