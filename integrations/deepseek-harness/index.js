import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  agentArgs,
  callMobFileApi,
  chatArgs,
  collaborateArgs,
  conversationArgs,
  hasMobFileApi,
  knowledgeArgs,
  parseMobReadCommand,
  resolveWorkspaceFile,
  runArgs,
  runMob,
  taskArgs,
  validateMobFileApi,
} from './bridge.js'

export const name = 'mob-agent-crew'
export const inject = ['tools', 'skills', 'commands']

export const Config = Schema.object({
  executable: Schema.string().min(1).default('mob'),
  timeoutMs: Schema.number().step(1).min(1).max(2_147_483_647).default(30_000),
  maxOutputBytes: Schema.number().step(1).min(1).max(67_108_864).default(1_048_576),
  fileApiBaseUrl: Schema.string().default(''),
  fileApiTokenEnv: Schema.string().min(1).pattern(/^[A-Za-z_][A-Za-z0-9_]*$/u).default('MOB_DSH_TOKEN'),
  allowInsecureFileApi: Schema.boolean().default(false),
})

const skillUrl = new URL('./skills/mob-agent-crew.md', import.meta.url)

function textOutput() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  }
}

function runner(config) {
  return (args, signal) => runMob(config.executable, args, {
    signal,
    timeoutMs: config.timeoutMs,
    maxOutputBytes: config.maxOutputBytes,
  })
}

export function apply(ctx, config) {
  const executeMob = runner(config)
  const fileApiEnabled = hasMobFileApi(config)
  if (fileApiEnabled) validateMobFileApi(config)

  ctx.skills.register({
    name: 'mob-agent-crew',
    description: 'Operate a Mob Agent Crew collaboration workspace: inspect tasks and chats, invoke agents, observe or steer runs, use workspace knowledge, and collaborate from inside a Mob Agent run. Use when the user mentions Mob, shared agent tasks, Mob conversations, Mob runs, delegation, Mob Wiki, or Mob artifacts.',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'custom',
    resourceBase: {
      kind: 'directory',
      path: fileURLToPath(new URL('./skills/', import.meta.url)),
    },
    content: readFileSync(skillUrl, 'utf8'),
  })

  ctx.tools.register(defineTool({
    name: 'mob_task',
    description: 'List Mob tasks or show one task thread. The detailed task view includes primary-chat messages, runs, and artifact metadata/content. Discover ids instead of guessing them.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'show'] },
      taskId: { type: 'string', description: 'Required for show.' },
    },
    output: textOutput(),
    execute: (args, exec) => executeMob(taskArgs(args), exec.signal),
  }))

  ctx.tools.register(defineTool({
    name: 'mob_chat',
    description: 'Send a message to a Mob task chat or an additional conversation. Text alone does not start an Agent; set invokeAgent only when work should begin. This is a collaboration write.',
    parameters: {
      target: { type: 'string', required: true, enum: ['task', 'conversation'] },
      id: { type: 'string', required: true, description: 'Task or conversation id selected by target.' },
      message: { type: 'string', required: true },
      invokeAgent: { type: 'string', description: 'Optional Agent id or @handle to explicitly invoke.' },
    },
    output: textOutput(),
    execute: (args, exec) => executeMob(chatArgs(args), exec.signal),
  }))

  ctx.tools.register(defineTool({
    name: 'mob_conversation',
    description: 'List, show, or create direct/group Mob conversations. Create requires a task id and kind; direct conversations require exactly one human and one Agent under Mob rules.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'show', 'create'] },
      conversationId: { type: 'string', description: 'Required for show.' },
      taskId: { type: 'string', description: 'Required for create.' },
      kind: { type: 'string', enum: ['direct', 'group'], description: 'Required for create.' },
      title: { type: 'string', description: 'Optional group title.' },
      members: { type: 'array', items: { type: 'string' }, description: 'Agent/human ids or @handles for create.' },
    },
    output: textOutput(),
    execute: (args, exec) => executeMob(conversationArgs(args), exec.signal),
  }))

  ctx.tools.register(defineTool({
    name: 'mob_agent',
    description: 'List Mob Agents or explicitly invoke one Agent on a task. Invoke starts work in Mob; it does not launch another vendor CLI directly from this Harness.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'invoke'] },
      taskId: { type: 'string', description: 'Required for invoke.' },
      agent: { type: 'string', description: 'Agent id or @handle; required for invoke.' },
      request: { type: 'string', description: 'Bounded work request; required for invoke.' },
    },
    output: textOutput(),
    execute: (args, exec) => executeMob(agentArgs(args), exec.signal),
  }))

  ctx.tools.register(defineTool({
    name: 'mob_run',
    description: 'Inspect or control an existing Mob Agent run. Poll status for observation. Steer/follow-up work only while the connector and active worker accept them; cancel stops the Mob run.',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'steer', 'follow_up', 'cancel'] },
      runId: { type: 'string', required: true },
      message: { type: 'string', description: 'Required for steer and follow_up.' },
    },
    output: textOutput(),
    execute: (args, exec) => executeMob(runArgs(args), exec.signal),
  }))

  ctx.tools.register(defineTool({
    name: 'mob_knowledge',
    description: 'Read or maintain Mob workspace knowledge (raw imports and curated Wiki). add_raw and curate read a local UTF-8 Markdown file and write through the existing Mob CLI; other actions are read-only.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'search', 'retrieve', 'read', 'add_raw', 'curate', 'lint'],
      },
      area: { type: 'string', enum: ['raw', 'wiki'], description: 'Optional list filter.' },
      query: { type: 'string', description: 'Required for search/retrieve.' },
      path: { type: 'string', description: 'Knowledge path for read/add_raw/curate.' },
      file: { type: 'string', description: 'Local Markdown file for add_raw/curate.' },
    },
    output: textOutput(),
    async execute(args, exec) {
      const command = knowledgeArgs(args)
      if (args.action === 'add_raw' || args.action === 'curate') {
        const workspaceRoot = exec.agent?.session.header.cwd
        command[3] = await resolveWorkspaceFile(command[3], workspaceRoot)
      }
      return executeMob(command, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mob_collaborate',
    description: 'Use the short-lived Mob run-token surface from inside a Mob Agent run: read context, post progress, delegate a bounded deliverable, add an artifact, or post the final summary. done must be called exactly once. This tool fails outside an active Mob run.',
    parameters: {
      action: { type: 'string', required: true, enum: ['context', 'say', 'delegate', 'artifact_add', 'done'] },
      message: { type: 'string', description: 'Required for say.' },
      agent: { type: 'string', description: 'Agent id or @handle; required for delegate.' },
      deliverable: { type: 'string', description: 'Bounded deliverable; required for delegate.' },
      readOnly: { type: 'boolean', description: 'Delegate without requesting the task writer lease.' },
      file: { type: 'string', description: 'Local file path; required for artifact_add.' },
      summary: { type: 'string', description: 'Final result; required for done.' },
    },
    output: textOutput(),
    async execute(args, exec) {
      const command = collaborateArgs(args)
      if (args.action === 'artifact_add') {
        const workspaceRoot = exec.agent?.session.header.cwd
        command[2] = await resolveWorkspaceFile(command[2], workspaceRoot)
      }
      return executeMob(command, exec.signal)
    },
  }))

  if (fileApiEnabled) {
    ctx.tools.register(defineTool({
      name: 'mob_files',
      description: 'List or read Mob repository/workspace files through the human-only, path-contained Mob file API. This read-only bridge uses a scoped human token from the configured environment variable; it never accepts a token as a tool argument.',
      parameters: {
        action: { type: 'string', required: true, enum: ['list', 'read'] },
        scope: { type: 'string', required: true, enum: ['repository', 'workspace'] },
        taskId: { type: 'string', required: true },
        path: { type: 'string', description: 'Directory for list; required file path for read.' },
      },
      output: textOutput(),
      execute: (args, exec) => callMobFileApi(config, args, { signal: exec.signal }),
    }))
  }

  ctx.commands.register({
    name: 'mob',
    description: 'run a read-only Mob discovery command',
    input: { hint: 'task|agent|conversation|run|knowledge ...' },
    async handler(invocation) {
      try {
        const parsed = parseMobReadCommand(invocation.rawInput)
        if ('help' in parsed) return { kind: 'success', text: parsed.help }
        return { kind: 'success', text: await executeMob(parsed.args, invocation.signal) }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}
