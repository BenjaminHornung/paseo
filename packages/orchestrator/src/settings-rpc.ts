import { settingsOperation, settingsRequestSchema } from "./settings.ts";
import { localPath } from "./contracts.ts";

try {
  localPath(process.cwd());
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > 65536) throw Error("REQUEST_TOO_LARGE");
  }
  const parsed = settingsRequestSchema.safeParse(JSON.parse(input));
  if (!parsed.success) throw Error("SETTINGS_INVALID");
  const result = await settingsOperation(parsed.data);
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  const safe =
    error instanceof Error && /^[A-Z][A-Z0-9_]{1,70}$/.test(error.message)
      ? error.message
      : "SETTINGS_OPERATION_FAILED";
  // Never serialize schema issues, request input, child stderr or provider errors.
  process.stdout.write(JSON.stringify({ ok: false, error: safe }));
  process.exitCode = 1;
}
