import { redactText, redactValue } from "../security/redaction.js";

export type RuntimeSecrets = readonly (string | undefined)[];

export function redactRuntimePayload<T>(value: T, secrets: RuntimeSecrets): T {
  return redactValue(value, secrets);
}

export function redactRuntimeError(error: unknown, secrets: RuntimeSecrets): string {
  return redactText(error instanceof Error ? error.message : String(error), secrets);
}

export function redactedRuntimeError(error: unknown, secrets: RuntimeSecrets): Error {
  return new Error(redactRuntimeError(error, secrets));
}

export function agentOutputPersistence(
  body: string,
  secrets: RuntimeSecrets,
): { body: string; enqueueMentionedAgents: false } {
  return {
    body: redactText(body, secrets),
    // Agent prose is output, not an authorization to create more runs.
    // Cross-agent work must go through the explicit delegation command.
    enqueueMentionedAgents: false,
  };
}
