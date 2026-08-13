import { describe, expect, it, vi } from "vitest";
import { MobApiClient, MobApiError } from "../../src/client/api.js";

describe("Mob API client", () => {
  it("sends bearer authentication and JSON bodies to the configured server", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: "task-1" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new MobApiClient({
      server: "https://mob.example.test/base/",
      token: "signed-run-token",
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      client.request<{ id: string }>("/api/tasks", {
        method: "POST",
        body: { title: "Ship it" },
      }),
    ).resolves.toEqual({ id: "task-1" });

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(input).toBe("https://mob.example.test/base/api/tasks");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer signed-run-token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(init?.body).toBe(JSON.stringify({ title: "Ship it" }));
  });

  it("passes FormData through without setting its content type", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    const client = new MobApiClient({
      server: "https://mob.example.test",
      token: "signed-run-token",
      fetch: fetchMock as typeof fetch,
    });
    const form = new FormData();
    form.set("file", new Blob(["hello"], { type: "text/plain" }), "hello.txt");

    await expect(
      client.request("api/tasks/task-1/artifacts", { method: "POST", body: form }),
    ).resolves.toBeUndefined();

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.body).toBe(form);
    expect(new Headers(init?.headers).has("content-type")).toBe(false);
  });

  it("returns text responses and exposes a checked raw response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("plain result", { status: 200 }))
      .mockResolvedValueOnce(new Response("download", { status: 200 }));
    const client = new MobApiClient({
      server: "https://mob.example.test",
      fetch: fetchMock as typeof fetch,
    });

    await expect(client.request<string>("api/plain")).resolves.toBe("plain result");
    await expect((await client.response("api/download")).text()).resolves.toBe("download");
  });

  it("reports structured HTTP errors without revealing the token", async () => {
    const token = "never-print-this-token";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "forbidden", message: `Rejected ${token}` }), {
        status: 403,
        statusText: "Forbidden",
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new MobApiClient({
      server: "https://mob.example.test",
      token,
      fetch: fetchMock as typeof fetch,
    });

    let error: unknown;
    try {
      await client.request("api/private");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(MobApiError);
    expect(error).toMatchObject({ status: 403, code: "forbidden", method: "GET", path: "/api/private" });
    expect((error as Error).message).toContain("[REDACTED]");
    expect((error as Error).message).not.toContain(token);
    expect(JSON.stringify(error)).not.toContain(token);
  });

  it("redacts tokens from transport errors", async () => {
    const token = "never-print-this-token";
    const client = new MobApiClient({
      server: "https://mob.example.test",
      token,
      fetch: vi.fn(async () => {
        throw new Error(`connection failed for ${token}`);
      }) as typeof fetch,
    });

    await expect(client.request("api/tasks")).rejects.toThrow(
      "connection failed for [REDACTED]",
    );
    await expect(client.request("api/tasks")).rejects.not.toThrow(token);
  });

  it("does not expose a token repeated by the server as an error code or path", async () => {
    const token = "never-print-this-token";
    const client = new MobApiClient({
      server: "https://mob.example.test",
      token,
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({ error: token }), {
          status: 400,
          statusText: token,
          headers: { "content-type": "application/json" },
        }),
      ) as typeof fetch,
    });

    let error: unknown;
    try {
      await client.request(`api/${token}`);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(MobApiError);
    expect((error as MobApiError).code).toBe("[REDACTED]");
    expect((error as MobApiError).path).toBe("/api/[REDACTED]");
    expect((error as MobApiError).message).not.toContain(token);
    expect(JSON.stringify(error)).not.toContain(token);
  });
});
