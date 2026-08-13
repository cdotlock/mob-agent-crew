import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('declares the official DSH bundle manifest and ships its patch', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  await access(resolve(root, manifest.dsh.bundle.patch))
  assert.ok(manifest.keywords.includes('dsh-plugin'))
})

test('bundle patch inserts the package and does not contain credentials', async () => {
  const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /name: mob-agent-crew-dsh-plugin/u)
  assert.match(patch, /fileApiTokenEnv: MOB_DSH_TOKEN/u)
  assert.doesNotMatch(patch, /Bearer\s+\S+/u)
  assert.doesNotMatch(patch, /sk-[A-Za-z0-9]/u)
})

test('skill is packaged as on-demand instructions rather than repository prompt content', async () => {
  const skill = await readFile(resolve(root, 'skills/mob-agent-crew.md'), 'utf8')
  assert.match(skill, /thin DeepSeek Harness adapter/u)
  assert.match(skill, /call done exactly once/u)
  assert.ok(Buffer.byteLength(skill) < 8_192)
})
