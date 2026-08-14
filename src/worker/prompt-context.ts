import type {
  ConversationThread,
  Message,
  Run,
  TaskThread,
} from "../domain/model.js";

export interface RunConversationContext {
  run: Run;
  messages: Message[];
  currentInstruction: string;
}

/** Keeps old task descriptions as background once a concrete invocation exists. */
export function runConversationContext(
  thread: TaskThread,
  runId: string,
): RunConversationContext {
  const run = thread.runs.find((candidate) => candidate.id === runId);
  if (!run) throw new Error(`Run ${runId} was not found in its task thread`);
  const messages = thread.messages.filter(
    (message) => message.conversationId === run.conversationId,
  );
  const triggerMessage = run.triggerMessageId
    ? messages.find((message) => message.id === run.triggerMessageId)
    : undefined;
  const delegation = run.delegationId
    ? thread.delegations.find((candidate) => candidate.id === run.delegationId)
    : undefined;
  return {
    run,
    messages,
    currentInstruction: delegation?.deliverable ?? triggerMessage?.body ?? thread.task.description,
  };
}

/**
 * Conversation-first runs keep their transcript outside the hidden execution
 * Task. The Task thread is consulted only for delegation and legacy background.
 */
export function runChatContext(
  conversation: ConversationThread,
  execution: TaskThread,
  runId: string,
): RunConversationContext {
  const run = conversation.runs.find((candidate) => candidate.id === runId);
  if (!run) throw new Error(`Run ${runId} was not found in its conversation`);
  const triggerMessage = run.triggerMessageId
    ? conversation.messages.find((message) => message.id === run.triggerMessageId)
    : undefined;
  const delegation = run.delegationId
    ? execution.delegations.find((candidate) => candidate.id === run.delegationId)
    : undefined;
  return {
    run,
    messages: conversation.messages,
    currentInstruction: delegation?.deliverable ?? triggerMessage?.body ?? execution.task.description,
  };
}
