export const claudeSubscriptionAccess = {
  claude: "claude-company-pro",
  "claude-private": "claude-personal-pro",
} as const;

export function isClaudeProvider(
  provider: string,
): provider is keyof typeof claudeSubscriptionAccess {
  return provider === "claude" || provider === "claude-private";
}

export function isClaudeSubscription(access: string): boolean {
  return access === "claude-company-pro" || access === "claude-personal-pro";
}
