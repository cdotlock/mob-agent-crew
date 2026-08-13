# Mob Agent Crew

Use this skill to operate the existing Mob Agent Crew environment. Mob remains the authority for tasks, actors, conversations, runs, writer leases, artifacts, knowledge and human publication. This plugin is only a thin DeepSeek Harness adapter: it calls the external `mob` executable or the documented read-only file API and does not reproduce Mob orchestration.

## Choose the correct surface

- Use `mob_task` to discover tasks and inspect a task thread. A task detail includes its primary messages, runs and artifacts.
- Use `mob_conversation` to list/show additional direct or group conversations. Use `mob_chat` to send text; set `invokeAgent` only when the user intends work to start.
- Use `mob_agent` to discover or invoke a named Mob Agent. Do not invoke another vendor CLI directly.
- Use `mob_run` to poll a run, steer it, follow up, or cancel. A rejected steer/follow-up is a connector or lifecycle limitation; do not create a hidden replacement process.
- Use `mob_knowledge` for raw imports and curated Wiki pages. Search/retrieve before loading broad material.
- Use `mob_collaborate` only when this Harness is itself running as a Mob Agent and has the short-lived run credential. Read context first, post only meaningful progress, use delegate only for a bounded handoff, add deliverables as artifacts, and call done exactly once.
- Use `mob_files`, when present, only for the human-session file browser. Inside a Mob Agent task checkout, use the Harness filesystem tools for working files; a run token is intentionally not accepted by Mob's human-only file endpoints.

## Workflow

1. Discover stable ids with list/show operations. Never guess task, conversation, Agent or run ids.
2. Read the smallest task/chat/knowledge context needed.
3. Distinguish discussion from execution. Sending ordinary chat text does not imply Agent invocation.
4. Observe the returned run id and poll `mob_run` status. Steer only when new information materially changes the active work.
5. Report results and artifacts in the same task or conversation where the work was requested.

## Security and authority

- Never put a Mob password, session/run token, model/provider key or SCM token in a prompt, tool argument, chat message, artifact, Wiki file or repository URL.
- The file API token is supplied only by the configured environment-variable reference. Never ask the user to paste it into chat.
- This plugin deliberately exposes no task review, SCM publish, Agent creation, repository import, server start, worker, login/logout or database-rebuild tool. Those remain explicit human or administrator actions.
- Local files uploaded through knowledge or artifact actions must resolve inside the current Harness session workspace. The adapter rejects host files outside that root.
- One Mob task has one writable lease. Do not work around lease, conversation membership or run-lifecycle rejections.
- Do not treat an available Agent identity as proof that its model path is healthy; use an actual bounded invocation when a real check is needed.
