const sensitiveAssignment = /\b(MOB_AI_KEY|MOB_RUN_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY)=\S+/giu;
const bearerToken = /\bBearer\s+\S+/giu;
const commonApiKey = /\b(?:mob-|sk-)[A-Za-z0-9_-]{20,}\b/gu;

export function redactText(value: string, secrets: readonly (string | undefined)[] = []): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted
    .replace(sensitiveAssignment, (_match, name: string) => `${name}=[REDACTED]`)
    .replace(bearerToken, "Bearer [REDACTED]")
    .replace(commonApiKey, "[REDACTED]");
}

export function redactValue<T>(value: T, secrets: readonly (string | undefined)[] = []): T {
  if (typeof value === "string") return redactText(value, secrets) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets)]),
    ) as T;
  }
  return value;
}
