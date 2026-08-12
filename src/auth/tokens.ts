import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const baseClaimsSchema = z.object({
  actorId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
});

const sessionClaimsSchema = baseClaimsSchema.extend({
  kind: z.literal("session"),
});

const runClaimsSchema = baseClaimsSchema.extend({
  kind: z.literal("run"),
  runId: z.string().uuid(),
  taskId: z.string().uuid(),
});

export type SessionClaims = z.infer<typeof sessionClaimsSchema>;
export type RunClaims = z.infer<typeof runClaimsSchema>;
export type TokenClaims = SessionClaims | RunClaims;

function sign(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

export function issueToken(claims: TokenClaims, secret: string): string {
  const schema = claims.kind === "session" ? sessionClaimsSchema : runClaimsSchema;
  const payload = schema.parse(claims);
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload, secret)}`;
}

export function verifyToken(
  token: string,
  secret: string,
  expectedKind: TokenClaims["kind"],
  now = Date.now(),
): TokenClaims {
  const [encodedPayload, providedSignature, trailing] = token.split(".");
  if (!encodedPayload || !providedSignature || trailing) {
    throw new Error("Invalid token format");
  }

  const expectedSignature = sign(encodedPayload, secret);
  const provided = Buffer.from(providedSignature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new Error("Invalid token signature");
  }

  let rawClaims: unknown;
  try {
    rawClaims = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid token payload");
  }

  const schema = expectedKind === "session" ? sessionClaimsSchema : runClaimsSchema;
  const claims = schema.parse(rawClaims);
  if (claims.expiresAt <= now) {
    throw new Error("Token expired");
  }

  return claims;
}

export function issueSessionToken(
  input: Omit<SessionClaims, "kind" | "issuedAt" | "expiresAt">,
  secret: string,
  lifetimeMs = 7 * 24 * 60 * 60 * 1_000,
  now = Date.now(),
): string {
  return issueToken(
    {
      kind: "session",
      ...input,
      issuedAt: now,
      expiresAt: now + lifetimeMs,
    },
    secret,
  );
}

export function issueRunToken(
  input: Omit<RunClaims, "kind" | "issuedAt" | "expiresAt">,
  secret: string,
  lifetimeMs = 4 * 60 * 60 * 1_000,
  now = Date.now(),
): string {
  return issueToken(
    {
      kind: "run",
      ...input,
      issuedAt: now,
      expiresAt: now + lifetimeMs,
    },
    secret,
  );
}
