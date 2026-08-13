import { spawn } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

const SAFE_ENVIRONMENT_KEYS = Object.freeze([
  'PATH',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'COMSPEC',
  'PATHEXT',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'NO_COLOR',
  'XDG_CONFIG_HOME',
  'MOB_CONFIG_PATH',
  'MOB_RUN_TOKEN',
  'MOB_API_URL',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
])

export const MOB_READ_COMMAND_HELP = [
  'Read-only Mob commands:',
  '  /mob task list',
  '  /mob task show <task-id>',
  '  /mob agent list',
  '  /mob conversation list',
  '  /mob conversation show <conversation-id>',
  '  /mob run status <run-id>',
  '  /mob knowledge list [raw|wiki]',
  '  /mob knowledge search <query>',
  '  /mob knowledge retrieve <query>',
  '  /mob knowledge read <path>',
  '  /mob knowledge lint',
].join('\n')

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`)
  }
  return value.trim()
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return value
}

export function createMobEnvironment(source = process.env) {
  const environment = {}
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = source[key]
    if (value !== undefined) environment[key] = value
  }
  return environment
}

export async function resolveWorkspaceFile(file, workspaceRoot) {
  const requested = requiredString(file, 'file')
  const root = await realpath(requiredString(workspaceRoot, 'workspace root'))
  const target = await realpath(resolve(root, requested))
  const relation = relative(root, target)
  if (relation === '..' || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || resolve(root, relation) !== target) {
    throw new Error('file must resolve inside the current Harness workspace')
  }
  if (!(await stat(target)).isFile()) throw new Error('file must be a regular file')
  return target
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason
  return new Error(typeof signal?.reason === 'string' ? signal.reason : 'Mob command aborted')
}

export async function runMob(executable, args, options = {}) {
  const command = requiredString(executable, 'Mob executable')
  const timeoutMs = positiveInteger(options.timeoutMs ?? 30_000, 'timeoutMs')
  const maxOutputBytes = positiveInteger(options.maxOutputBytes ?? 1_048_576, 'maxOutputBytes')
  const signal = options.signal
  if (signal?.aborted) throw abortError(signal)

  return new Promise((resolve, reject) => {
    let settled = false
    let outputBytes = 0
    const stdout = []
    const stderr = []
    const child = spawn(command, [...args], {
      env: createMobEnvironment(options.environment),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const terminate = (error) => {
      child.kill('SIGTERM')
      fail(error)
    }
    const collect = (chunks, chunk) => {
      if (settled) return
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      outputBytes += bytes.length
      if (outputBytes > maxOutputBytes) {
        terminate(new Error(`Mob command output exceeded ${maxOutputBytes} bytes`))
        return
      }
      chunks.push(bytes)
    }
    const onAbort = () => terminate(abortError(signal))
    const timer = setTimeout(
      () => terminate(new Error(`Mob command timed out after ${timeoutMs} ms`)),
      timeoutMs,
    )

    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', chunk => collect(stdout, chunk))
    child.stderr.on('data', chunk => collect(stderr, chunk))
    child.once('error', error => fail(new Error(`Unable to start the Mob CLI: ${error.message}`)))
    child.once('close', (code, terminationSignal) => {
      if (settled) return
      settled = true
      cleanup()
      const out = Buffer.concat(stdout).toString('utf8').trimEnd()
      const err = Buffer.concat(stderr).toString('utf8').trimEnd()
      if (code !== 0) {
        const reason = err || out || (terminationSignal === null
          ? `exit code ${String(code)}`
          : `terminated by ${terminationSignal}`)
        reject(new Error(`Mob command failed: ${reason}`))
        return
      }
      resolve(out.length === 0 ? '(Mob command completed with no output)' : out)
    })
  })
}

export function taskArgs(input) {
  if (input.action === 'list') return ['task', 'list']
  if (input.action === 'show') return ['task', 'show', requiredString(input.taskId, 'taskId')]
  throw new Error(`Unsupported task action: ${String(input.action)}`)
}

export function chatArgs(input) {
  const id = requiredString(input.id, 'id')
  const message = requiredString(input.message, 'message')
  if (input.target === 'task') {
    if (input.invokeAgent !== undefined && input.invokeAgent.trim().length > 0) {
      return ['agent', 'invoke', id, input.invokeAgent.trim(), message]
    }
    return ['chat', 'send', id, message]
  }
  if (input.target === 'conversation') {
    return [
      'conversation',
      'send',
      id,
      ...(input.invokeAgent === undefined || input.invokeAgent.trim().length === 0
        ? []
        : ['--invoke', input.invokeAgent.trim()]),
      message,
    ]
  }
  throw new Error(`Unsupported chat target: ${String(input.target)}`)
}

export function conversationArgs(input) {
  if (input.action === 'list') return ['conversation', 'list']
  if (input.action === 'show') {
    return ['conversation', 'show', requiredString(input.conversationId, 'conversationId')]
  }
  if (input.action === 'create') {
    const kind = input.kind
    if (kind !== 'direct' && kind !== 'group') throw new Error('kind must be direct or group')
    const members = Array.isArray(input.members)
      ? input.members.map(member => requiredString(member, 'member'))
      : []
    return [
      'conversation',
      'create',
      requiredString(input.taskId, 'taskId'),
      '--kind',
      kind,
      ...(input.title === undefined || input.title.trim().length === 0 ? [] : ['--title', input.title.trim()]),
      ...(members.length === 0 ? [] : ['--member', ...members]),
    ]
  }
  throw new Error(`Unsupported conversation action: ${String(input.action)}`)
}

export function agentArgs(input) {
  if (input.action === 'list') return ['agent', 'list']
  if (input.action === 'invoke') {
    return [
      'agent',
      'invoke',
      requiredString(input.taskId, 'taskId'),
      requiredString(input.agent, 'agent'),
      requiredString(input.request, 'request'),
    ]
  }
  throw new Error(`Unsupported agent action: ${String(input.action)}`)
}

export function runArgs(input) {
  const runId = requiredString(input.runId, 'runId')
  if (input.action === 'status' || input.action === 'cancel') return ['run', input.action, runId]
  if (input.action === 'steer') {
    return ['run', 'steer', runId, requiredString(input.message, 'message')]
  }
  if (input.action === 'follow_up') {
    return ['run', 'follow-up', runId, requiredString(input.message, 'message')]
  }
  throw new Error(`Unsupported run action: ${String(input.action)}`)
}

export function knowledgeArgs(input) {
  switch (input.action) {
    case 'list':
      if (input.area === undefined || input.area === '') return ['knowledge', 'list']
      if (input.area !== 'raw' && input.area !== 'wiki') throw new Error('area must be raw or wiki')
      return ['knowledge', 'list', '--area', input.area]
    case 'search':
    case 'retrieve':
      return ['knowledge', input.action, requiredString(input.query, 'query')]
    case 'read':
      return ['knowledge', 'read', requiredString(input.path, 'path')]
    case 'add_raw':
      return [
        'knowledge',
        'add-raw',
        requiredString(input.path, 'path'),
        requiredString(input.file, 'file'),
      ]
    case 'curate':
      return [
        'knowledge',
        'curate',
        requiredString(input.path, 'path'),
        requiredString(input.file, 'file'),
      ]
    case 'lint':
      return ['knowledge', 'lint']
    default:
      throw new Error(`Unsupported knowledge action: ${String(input.action)}`)
  }
}

export function collaborateArgs(input) {
  switch (input.action) {
    case 'context':
      return ['context']
    case 'say':
      return ['say', requiredString(input.message, 'message')]
    case 'delegate':
      return [
        'delegate',
        requiredString(input.agent, 'agent'),
        requiredString(input.deliverable, 'deliverable'),
        ...(input.readOnly === true ? ['--read-only'] : []),
      ]
    case 'artifact_add':
      return ['artifact', 'add', requiredString(input.file, 'file')]
    case 'done':
      return ['done', requiredString(input.summary, 'summary')]
    default:
      throw new Error(`Unsupported collaboration action: ${String(input.action)}`)
  }
}

function splitCommand(input) {
  const match = /^(\S+)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/u.exec(input.trim())
  return match === null ? [] : [match[1], match[2], match[3]]
}

export function parseMobReadCommand(rawInput) {
  const input = rawInput.trim()
  if (input.length === 0 || input === 'help') return { help: MOB_READ_COMMAND_HELP }
  const [resource, action, rest] = splitCommand(input)
  if (resource === 'task' && action === 'list' && rest === undefined) return { args: ['task', 'list'] }
  if (resource === 'task' && action === 'show') return { args: ['task', 'show', requiredString(rest, 'task-id')] }
  if (resource === 'agent' && action === 'list' && rest === undefined) return { args: ['agent', 'list'] }
  if (resource === 'conversation' && action === 'list' && rest === undefined) return { args: ['conversation', 'list'] }
  if (resource === 'conversation' && action === 'show') {
    return { args: ['conversation', 'show', requiredString(rest, 'conversation-id')] }
  }
  if (resource === 'run' && action === 'status') return { args: ['run', 'status', requiredString(rest, 'run-id')] }
  if (resource === 'knowledge' && action === 'lint' && rest === undefined) return { args: ['knowledge', 'lint'] }
  if (resource === 'knowledge' && action === 'list') {
    if (rest === undefined) return { args: ['knowledge', 'list'] }
    const area = rest.trim()
    if (area !== 'raw' && area !== 'wiki') throw new Error('knowledge list area must be raw or wiki')
    return { args: ['knowledge', 'list', '--area', area] }
  }
  if (resource === 'knowledge' && (action === 'search' || action === 'retrieve' || action === 'read')) {
    return { args: ['knowledge', action, requiredString(rest, action === 'read' ? 'path' : 'query')] }
  }
  throw new Error(`Unsupported /mob command.\n${MOB_READ_COMMAND_HELP}`)
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

function resolveFileApi(config, environment) {
  const configured = typeof config.fileApiBaseUrl === 'string' ? config.fileApiBaseUrl.trim() : ''
  const rawUrl = configured || environment.MOB_DSH_API_URL
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    throw new Error('Mob file API is not configured; set fileApiBaseUrl or MOB_DSH_API_URL')
  }
  const baseUrl = new URL(rawUrl)
  if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:'
    && (config.allowInsecureFileApi === true || isLoopback(baseUrl.hostname)))) {
    throw new Error('Mob file API requires HTTPS (HTTP is allowed only for loopback unless explicitly enabled)')
  }
  const tokenEnv = requiredString(config.fileApiTokenEnv, 'fileApiTokenEnv')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(tokenEnv)) throw new Error('fileApiTokenEnv is not a valid environment variable name')
  const token = environment[tokenEnv]
  if (typeof token !== 'string' || token.length === 0 || token.trim() !== token) {
    throw new Error(`Mob file API credential is missing from environment variable ${tokenEnv}`)
  }
  return { baseUrl, token }
}

export function hasMobFileApi(config, environment = process.env) {
  const configured = typeof config.fileApiBaseUrl === 'string' ? config.fileApiBaseUrl.trim() : ''
  return configured.length > 0
    || (typeof environment.MOB_DSH_API_URL === 'string' && environment.MOB_DSH_API_URL.trim().length > 0)
}

export function validateMobFileApi(config, environment = process.env) {
  resolveFileApi(config, environment)
}

async function readResponse(response, maxOutputBytes) {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > maxOutputBytes) {
      await reader.cancel()
      throw new Error(`Mob API response exceeded ${maxOutputBytes} bytes`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
}

export async function callMobFileApi(config, input, options = {}) {
  const environment = options.environment ?? process.env
  const { baseUrl, token } = resolveFileApi(config, environment)
  const timeoutMs = positiveInteger(config.timeoutMs ?? 30_000, 'timeoutMs')
  const maxOutputBytes = positiveInteger(config.maxOutputBytes ?? 1_048_576, 'maxOutputBytes')
  const action = input.action
  if (action !== 'list' && action !== 'read') throw new Error(`Unsupported file action: ${String(action)}`)
  if (input.scope !== 'repository' && input.scope !== 'workspace') {
    throw new Error('scope must be repository or workspace')
  }
  const url = new URL(action === 'list' ? '/api/files' : '/api/files/content', baseUrl)
  url.searchParams.set('scope', input.scope)
  url.searchParams.set('taskId', requiredString(input.taskId, 'taskId'))
  const path = typeof input.path === 'string' ? input.path : ''
  if (action === 'read') url.searchParams.set('path', requiredString(path, 'path'))
  else if (path.length > 0) url.searchParams.set('path', path)

  const controller = new AbortController()
  const onAbort = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) throw abortError(options.signal)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error(`Mob API timed out after ${timeoutMs} ms`)), timeoutMs)
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    const body = await readResponse(response, maxOutputBytes)
    if (!response.ok) throw new Error(`Mob API ${response.status}: ${body || response.statusText}`)
    if (body.length === 0) return '(Mob API returned no content)'
    try {
      return JSON.stringify(JSON.parse(body), null, 2)
    } catch {
      return body
    }
  } catch (error) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason
      throw reason instanceof Error ? reason : new Error('Mob API request aborted')
    }
    throw error
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}
