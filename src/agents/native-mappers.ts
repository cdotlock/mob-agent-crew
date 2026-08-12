import type {
  AgentEventDraft,
  NativeEventMapping,
  NativeTerminal,
} from "./types.js";

export type NativeMapper = (frame: unknown) => NativeEventMapping;

export function mapCodexEvent(frame: unknown): NativeEventMapping {
  const record = asRecord(frame);
  const type = stringValue(record.type) ?? "unknown";

  switch (type) {
    case "thread.started": {
      return mapping(
        draft("runtime.ready", type, undefined, pick(record, ["thread_id"])),
      );
    }
    case "turn.started":
      return mapping(draft("turn.started", type));
    case "item.started":
    case "item.updated":
    case "item.completed":
      return mapCodexItem(type, asRecord(record.item));
    case "turn.completed": {
      const usage = asRecord(record.usage);
      return mapping(
        draft(
          "turn.completed",
          type,
          undefined,
          Object.keys(usage).length > 0 ? usage : undefined,
        ),
        { outcome: "completed" },
      );
    }
    case "turn.failed": {
      const error = errorText(record.error) ?? "Codex turn failed";
      return mapping(
        draft("turn.failed", type, error, pick(record, ["error"])),
        { outcome: "failed", error },
      );
    }
    case "error":
      return mapping(
        draft(
          "error",
          type,
          errorText(record.message ?? record.error) ?? "Codex stream error",
          pick(record, ["message", "error"]),
        ),
      );
    default:
      return { events: [] };
  }
}

export function mapClaudeEvent(frame: unknown): NativeEventMapping {
  const record = asRecord(frame);
  const type = stringValue(record.type) ?? "unknown";
  const subtype = stringValue(record.subtype);

  if (type === "system" && subtype === "init") {
    return mapping(
      draft(
        "runtime.ready",
        "system.init",
        undefined,
        pick(record, ["session_id", "model", "tools"]),
      ),
    );
  }

  if (type === "assistant") {
    const text = textFromClaudeMessage(record.message);
    return text === undefined
      ? { events: [] }
      : mapping(draft("message.completed", type, text));
  }

  if (type === "stream_event") {
    return mapClaudeStreamEvent(asRecord(record.event));
  }

  if (type === "result") {
    const isError = record.is_error === true || (subtype !== undefined && subtype !== "success");
    const finalMessage = stringValue(record.result);
    const error = isError
      ? finalMessage ?? subtype ?? "Claude result reported an error"
      : undefined;
    const terminal: NativeTerminal = isError
      ? { outcome: "failed", ...(error ? { error } : {}) }
      : {
          outcome: "completed",
          ...(finalMessage ? { finalMessage } : {}),
          ...(stringValue(record.session_id)
            ? { sessionId: stringValue(record.session_id) as string }
            : {}),
        };
    return mapping(
      draft(
        isError ? "turn.failed" : "turn.completed",
        subtype ? `result.${subtype}` : type,
        isError ? error : finalMessage,
        pick(record, [
          "duration_ms",
          "duration_api_ms",
          "num_turns",
          "total_cost_usd",
          "usage",
          "session_id",
          "is_error",
        ]),
      ),
      terminal,
    );
  }

  return { events: [] };
}

export function mapPiEvent(frame: unknown): NativeEventMapping {
  const record = asRecord(frame);
  const type = stringValue(record.type) ??
    (typeof record.success === "boolean" && record.id !== undefined
      ? "response"
      : "unknown");

  if (type === "response") return mapRpcResponse(record, "pi.response");
  if (type === "agent_start" || type === "turn_start") {
    return mapping(draft("turn.started", type));
  }
  if (type === "message_update") {
    const update = asRecord(record.assistantMessageEvent ?? record.event);
    const updateType = stringValue(update.type);
    if (updateType === "text_delta") {
      return mapping(
        draft("message.delta", `${type}.text_delta`, stringValue(update.delta) ?? ""),
      );
    }
    return { events: [] };
  }
  if (type === "tool_execution_start") {
    return mapping(
      draft(
        "tool.started",
        type,
        stringValue(record.toolName ?? record.tool_name),
        pick(record, ["toolCallId", "toolName", "args"]),
      ),
    );
  }
  if (type === "tool_execution_update") {
    return mapping(
      draft("tool.progress", type, undefined, pick(record, ["toolCallId", "partialResult"])),
    );
  }
  if (type === "tool_execution_end") {
    return mapping(
      draft(
        "tool.completed",
        type,
        undefined,
        pick(record, ["toolCallId", "result", "isError"]),
      ),
    );
  }
  if (type === "agent_settled") {
    const finalMessage = lastAssistantText(record.messages);
    return mapping(
      draft("turn.completed", type, finalMessage),
      {
        outcome: "completed",
        ...(finalMessage ? { finalMessage } : {}),
      },
    );
  }
  if (type === "extension_error" || type === "auto_retry_start") {
    return mapping(
      draft(
        "warning",
        type,
        errorText(record.error ?? record.message) ?? type,
        pick(record, ["extensionPath", "error", "attempt", "delayMs"]),
      ),
    );
  }

  // `agent_end` is intentionally not terminal in Pi: retry/compaction may follow.
  return { events: [] };
}

export function mapOmpEvent(frame: unknown): NativeEventMapping {
  const record = asRecord(frame);
  const type = stringValue(record.type) ??
    (typeof record.success === "boolean" && record.id !== undefined
      ? "response"
      : "unknown");

  if (type === "ready") {
    return mapping(
      draft(
        "runtime.ready",
        type,
        undefined,
        pick(record, [
          "protocolVersion",
          "supportedProtocolVersions",
          "maxFrameBytes",
          "maxReassembledFrameBytes",
        ]),
      ),
    );
  }
  if (type === "response") {
    const response = mapRpcResponse(record, "omp.response");
    const data = asRecord(record.data);
    if (
      record.success === true &&
      stringValue(record.command) === "prompt" &&
      data.agentInvoked === false
    ) {
      return {
        events: [
          ...response.events,
          draft("turn.completed", "prompt.local_only"),
        ],
        terminal: { outcome: "completed" },
      };
    }
    return response;
  }
  if (type === "prompt_result" && record.agentInvoked === false) {
    return mapping(
      draft("turn.completed", type),
      { outcome: "completed" },
    );
  }
  if (type === "agent_start" || type === "turn_start") {
    return mapping(draft("turn.started", type));
  }
  if (type === "message_update") {
    const update = asRecord(record.assistantMessageEvent ?? record.event);
    if (stringValue(update.type) === "text_delta") {
      return mapping(
        draft("message.delta", `${type}.text_delta`, stringValue(update.delta) ?? ""),
      );
    }
    return { events: [] };
  }
  if (type === "tool_execution_start") {
    return mapping(
      draft(
        "tool.started",
        type,
        stringValue(record.toolName ?? record.tool_name),
        pick(record, ["toolCallId", "toolName", "args"]),
      ),
    );
  }
  if (type === "tool_execution_update") {
    return mapping(
      draft("tool.progress", type, undefined, pick(record, ["toolCallId", "partialResult"])),
    );
  }
  if (type === "tool_execution_end") {
    return mapping(
      draft(
        "tool.completed",
        type,
        undefined,
        pick(record, ["toolCallId", "result", "isError"]),
      ),
    );
  }
  if (type === "agent_end") {
    if (record.isTerminal === false) return { events: [] };
    const finalMessage = lastAssistantText(record.messages);
    return mapping(
      draft("turn.completed", type, finalMessage),
      {
        outcome: "completed",
        ...(finalMessage ? { finalMessage } : {}),
      },
    );
  }
  if (type === "error") {
    const error = errorText(record.error ?? record.message) ?? "OMP RPC error";
    return mapping(draft("error", type, error, pick(record, ["error", "message"])));
  }
  return { events: [] };
}

function mapCodexItem(nativeType: string, item: Record<string, unknown>): NativeEventMapping {
  const itemType = stringValue(item.type) ?? "unknown";
  const phase = nativeType.split(".")[1];
  if (itemType === "agent_message") {
    if (phase !== "completed") return { events: [] };
    const text = stringValue(item.text);
    return mapping(
      draft("message.completed", `${nativeType}.${itemType}`, text, pick(item, ["id"])),
    );
  }

  const isTool = [
    "command_execution",
    "file_change",
    "mcp_tool_call",
    "web_search",
    "todo_list",
  ].includes(itemType);
  if (!isTool) return { events: [] };

  const kind =
    phase === "started"
      ? "tool.started"
      : phase === "completed"
        ? "tool.completed"
        : "tool.progress";
  const message =
    stringValue(item.command) ?? stringValue(item.query) ?? stringValue(item.name);
  return mapping(draft(kind, `${nativeType}.${itemType}`, message, item));
}

function mapClaudeStreamEvent(event: Record<string, unknown>): NativeEventMapping {
  const type = stringValue(event.type) ?? "stream_event.unknown";
  if (type === "message_start") return mapping(draft("turn.started", type));
  if (type === "content_block_delta") {
    const delta = asRecord(event.delta);
    if (stringValue(delta.type) === "text_delta") {
      return mapping(draft("message.delta", `${type}.text_delta`, stringValue(delta.text) ?? ""));
    }
    return mapping(draft("tool.progress", type, undefined, pick(delta, ["type", "partial_json"] )));
  }
  if (type === "content_block_start") {
    const block = asRecord(event.content_block);
    if (stringValue(block.type) === "tool_use") {
      return mapping(
        draft("tool.started", `${type}.tool_use`, stringValue(block.name), pick(block, ["id", "name", "input"])),
      );
    }
  }
  if (type === "message_delta") {
    const usage = asRecord(event.usage);
    return Object.keys(usage).length === 0
      ? { events: [] }
      : mapping(draft("usage.updated", type, undefined, usage));
  }
  return { events: [] };
}

function mapRpcResponse(
  record: Record<string, unknown>,
  nativeType: string,
): NativeEventMapping {
  const accepted = record.success === true;
  const command = stringValue(record.command ?? record.requestType ?? record.type);
  const error = accepted ? undefined : errorText(record.error) ?? "RPC command rejected";
  return mapping(
    draft(
      accepted ? "command.accepted" : "command.rejected",
      nativeType,
      error,
      pick(record, ["id", "success", "command", "data", "error"]),
    ),
  );
}

function mapping(
  event: AgentEventDraft,
  terminal?: NativeTerminal,
): NativeEventMapping {
  if (terminal) return { events: [event], terminal };
  return { events: [event] };
}

function draft(
  kind: AgentEventDraft["kind"],
  nativeType: string,
  message?: string,
  data?: Readonly<Record<string, unknown>>,
): AgentEventDraft {
  return {
    kind,
    nativeType,
    ...(message !== undefined && message.length > 0 ? { message } : {}),
    ...(data !== undefined && Object.keys(data).length > 0 ? { data } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return stringValue(record.message) ?? stringValue(record.error);
}

function pick(
  record: Record<string, unknown>,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  const selected: Record<string, unknown> = {};
  for (const key of keys) {
    if (record[key] !== undefined) selected[key] = record[key];
  }
  return Object.keys(selected).length > 0 ? selected : undefined;
}

function textFromClaudeMessage(value: unknown): string | undefined {
  const message = asRecord(value);
  const content = message.content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((part) => {
      const block = asRecord(part);
      return stringValue(block.type) === "text" ? stringValue(block.text) : undefined;
    })
    .filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join("") : undefined;
}

function lastAssistantText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const message = asRecord(value[index]);
    if (stringValue(message.role) !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((block) => stringValue(asRecord(block).text))
        .filter((part): part is string => part !== undefined)
        .join("");
      if (text.length > 0) return text;
    }
  }
  return undefined;
}
