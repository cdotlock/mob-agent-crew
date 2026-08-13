import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  agentArgs,
  callMobFileApi,
  chatArgs,
  collaborateArgs,
  conversationArgs,
  createMobEnvironment,
  knowledgeArgs,
  parseMobReadCommand,
  resolveWorkspaceFile,
  runArgs,
  runMob,
  taskArgs,
} from '../bridge.js'

test('builds fixed Mob CLI argument arrays for every exposed surface', () => {
  assert.deepEqual(taskArgs({ action: 'show', taskId: 'task-1' }), ['task', 'show', 'task-1'])
  assert.deepEqual(chatArgs({ target: 'task', id: 'task-1', message: 'hello' }), ['chat', 'send', 'task-1', 'hello'])
  assert.deepEqual(
    chatArgs({ target: 'conversation', id: 'chat-1', message: 'review', invokeAgent: '@reviewer' }),
    ['conversation', 'send', 'chat-1', '--invoke', '@reviewer', 'review'],
  )
  assert.deepEqual(
    conversationArgs({ action: 'create', taskId: 'task-1', kind: 'group', title: 'Review', members: ['@a', '@b'] }),
    ['conversation', 'create', 'task-1', '--kind', 'group', '--title', 'Review', '--member', '@a', '@b'],
  )
  assert.deepEqual(
    agentArgs({ action: 'invoke', taskId: 'task-1', agent: '@builder', request: 'fix it' }),
    ['agent', 'invoke', 'task-1', '@builder', 'fix it'],
  )
  assert.deepEqual(
    runArgs({ action: 'follow_up', runId: 'run-1', message: 'verify' }),
    ['run', 'follow-up', 'run-1', 'verify'],
  )
  assert.deepEqual(
    knowledgeArgs({ action: 'curate', path: 'decisions/a.md', file: '/tmp/a.md' }),
    ['knowledge', 'curate', 'decisions/a.md', '/tmp/a.md'],
  )
  assert.deepEqual(
    collaborateArgs({ action: 'delegate', agent: '@reviewer', deliverable: 'review diff', readOnly: true }),
    ['delegate', '@reviewer', 'review diff', '--read-only'],
  )
})

test('the /mob command parser admits only documented read operations', () => {
  assert.deepEqual(parseMobReadCommand('task list'), { args: ['task', 'list'] })
  assert.deepEqual(parseMobReadCommand('knowledge search writer lease'), {
    args: ['knowledge', 'search', 'writer lease'],
  })
  assert.throws(() => parseMobReadCommand('task publish task-1'), /Unsupported \/mob command/u)
  assert.throws(() => parseMobReadCommand('run cancel run-1'), /Unsupported \/mob command/u)
})

test('CLI subprocesses receive Mob auth but not provider or SCM credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mob-dsh-plugin-'))
  const executable = join(directory, 'fake-mob')
  await writeFile(executable, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), env: process.env }))
`)
  await chmod(executable, 0o700)
  const environment = {
    PATH: process.env.PATH,
    HOME: directory,
    MOB_RUN_TOKEN: 'run-secret',
    MOB_API_URL: 'http://127.0.0.1:4310',
    DEEPSEEK_API_KEY: 'provider-secret',
    GH_TOKEN: 'scm-secret',
  }
  const output = JSON.parse(await runMob(executable, ['chat', 'send', 'task-1', '$(touch nope)'], {
    environment,
    timeoutMs: 5_000,
    maxOutputBytes: 64_000,
  }))
  assert.deepEqual(output.args, ['chat', 'send', 'task-1', '$(touch nope)'])
  assert.equal(output.env.MOB_RUN_TOKEN, 'run-secret')
  assert.equal(output.env.MOB_API_URL, 'http://127.0.0.1:4310')
  assert.equal(output.env.DEEPSEEK_API_KEY, undefined)
  assert.equal(output.env.GH_TOKEN, undefined)
})

test('environment projection excludes unknown keys', () => {
  assert.deepEqual(createMobEnvironment({ PATH: '/bin', MOB_CONFIG_PATH: '/safe/config', SECRET: 'no' }), {
    PATH: '/bin',
    MOB_CONFIG_PATH: '/safe/config',
  })
})

test('uploaded files must resolve inside the Harness workspace', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'mob-dsh-workspace-'))
  const outside = await mkdtemp(join(tmpdir(), 'mob-dsh-outside-'))
  await mkdir(join(workspace, 'reports'))
  await writeFile(join(workspace, 'reports', 'result.md'), '# Result\n')
  await writeFile(join(outside, 'secret.txt'), 'secret')
  await symlink(join(outside, 'secret.txt'), join(workspace, 'reports', 'escape.txt'))
  assert.equal(
    await resolveWorkspaceFile('reports/result.md', workspace),
    await realpath(join(workspace, 'reports', 'result.md')),
  )
  await assert.rejects(() => resolveWorkspaceFile(join(outside, 'secret.txt'), workspace), /inside the current Harness workspace/u)
  await assert.rejects(() => resolveWorkspaceFile('reports/escape.txt', workspace), /inside the current Harness workspace/u)
})

test('file API sends a bearer header without putting the token in the URL', async () => {
  let observed
  const result = await callMobFileApi({
    timeoutMs: 5_000,
    maxOutputBytes: 64_000,
    fileApiBaseUrl: 'https://mob.example',
    fileApiTokenEnv: 'MOB_DSH_TOKEN',
    allowInsecureFileApi: false,
  }, {
    action: 'read',
    scope: 'repository',
    taskId: '00000000-0000-4000-8000-000000000001',
    path: 'docs/architecture.md',
  }, {
    environment: { MOB_DSH_TOKEN: 'session-secret' },
    fetchImpl: async (url, init) => {
      observed = { url: String(url), authorization: init.headers.authorization }
      return new Response(JSON.stringify({ content: '# Architecture' }), {
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  assert.equal(observed.authorization, 'Bearer session-secret')
  assert.doesNotMatch(observed.url, /session-secret/u)
  assert.match(observed.url, /\/api\/files\/content/u)
  assert.equal(JSON.parse(result).content, '# Architecture')
})

test('file API rejects plaintext remote bearer transport', async () => {
  await assert.rejects(() => callMobFileApi({
    timeoutMs: 5_000,
    maxOutputBytes: 64_000,
    fileApiBaseUrl: 'http://mob.example',
    fileApiTokenEnv: 'MOB_DSH_TOKEN',
    allowInsecureFileApi: false,
  }, {
    action: 'list',
    scope: 'repository',
    taskId: '00000000-0000-4000-8000-000000000001',
  }, {
    environment: { MOB_DSH_TOKEN: 'session-secret' },
  }), /requires HTTPS/u)
})
