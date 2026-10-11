import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import test from 'node:test'
import { main } from '../scripts/prepare-config.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-config-'))
  const builder = join(root, '.dsh-build', 'desktop-builder-update')
  const desktop = join(root, 'apps', 'desktop')
  mkdirSync(builder, { recursive: true })
  mkdirSync(desktop, { recursive: true })
  return { root, builder, desktop, output: join(desktop, '.env.windows') }
}

function run(root, args = [], env = {}) {
  const source = join(root, '.dsh-build', 'desktop-builder-update', '.env.windows')
  const input = existsSync(source) ? ['--source', source] : []
  return JSON.stringify(main([root, '--policy', 'configured', ...input, ...args], env))
}

test('round trips spaces, quotes, JSON, and source precedence', () => {
  const copy = fixture()
  writeFileSync(join(copy.builder, '.env.windows'), "DSH_DESKTOP_APP_ID='com.from.source'\nDSH_DESKTOP_MANDATORY_UPDATE_CONFIG='{" +
    '"allowedAuthOrigins":["https://login.example.com"]}' + "'\n")
  const result = JSON.parse(run(copy.root, ['--mode', 'unsigned'], {
    DSH_DESKTOP_APP_ID: 'com.from.environment', DSH_DESKTOP_NPM_REGISTRY: 'https://registry.example.com',
  }))
  const settings = parseEnv(readFileSync(copy.output, 'utf8'))
  assert.equal(settings.DSH_DESKTOP_APP_ID, 'com.from.source')
  assert.equal(settings.DSH_DESKTOP_MANDATORY_UPDATE_CONFIG, '{"allowedAuthOrigins":["https://login.example.com"]}')
  assert.equal(settings.DSH_DESKTOP_NPM_REGISTRY, 'https://registry.example.com')
  assert.equal(result.mode, 'unsigned')
  if (process.platform !== 'win32') assert.equal(statSync(copy.output).mode & 0o777, 0o600)
})

test('explicit unsigned strips partial signing and refuses replacing a custom dotenv', () => {
  const copy = fixture()
  run(copy.root, ['--mode', 'unsigned', '--policy', 'disabled'], { DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'synthetic # secret' })
  assert.equal(parseEnv(readFileSync(copy.output, 'utf8')).DSH_DESKTOP_WINDOWS_TOKEN_PIN, undefined)
  writeFileSync(copy.output, 'DSH_DESKTOP_APP_ID=com.custom\n')
  assert.throws(() => run(copy.root, ['--mode', 'unsigned']), /refusing to overwrite custom/u)
  assert.equal(readFileSync(copy.output, 'utf8'), 'DSH_DESKTOP_APP_ID=com.custom\n')
})

test('rejects unsupported source settings and leaves custom output untouched', () => {
  const copy = fixture()
  writeFileSync(join(copy.builder, '.env.windows'), 'UNSUPPORTED_SECRET=hidden\n')
  assert.throws(() => run(copy.root), /unsupported setting UNSUPPORTED_SECRET/u)
  writeFileSync(copy.output, 'custom configuration\n')
  assert.throws(() => run(copy.root, ['--source', join(copy.root, 'missing.env')]), /cannot read source/u)
  assert.equal(readFileSync(copy.output, 'utf8'), 'custom configuration\n')
})

test('disabled policy refuses signed mode and partial signing fails', () => {
  const copy = fixture()
  const certificate = join(copy.builder, 'certificate.cer')
  const signtool = join(copy.builder, 'signtool.exe')
  writeFileSync(certificate, 'certificate')
  writeFileSync(signtool, 'signtool')
  writeFileSync(join(copy.builder, '.env.windows'), `DSH_DESKTOP_WINDOWS_CER_FILE=${certificate}\nDSH_DESKTOP_WINDOWS_SIGNTOOL=${signtool}\nDSH_DESKTOP_WINDOWS_KEY_CONTAINER=container\nDSH_DESKTOP_WINDOWS_TOKEN_PIN=pin\n`)
  assert.throws(() => run(copy.root, ['--policy', 'disabled']), /disabled policy requires unsigned/u)
  const partial = fixture()
  writeFileSync(join(partial.builder, '.env.windows'), 'DSH_DESKTOP_WINDOWS_TOKEN_PIN=pin\n')
  assert.throws(() => run(partial.root), /partial Windows signing configuration/u)
})

test('explicit unsigned mode strips complete signing settings', () => {
  const copy = fixture()
  const certificate = join(copy.builder, 'certificate.cer')
  const signtool = join(copy.builder, 'signtool.exe')
  writeFileSync(certificate, 'certificate')
  writeFileSync(signtool, 'signtool')
  writeFileSync(join(copy.builder, '.env.windows'), `DSH_DESKTOP_WINDOWS_CER_FILE=${certificate}\nDSH_DESKTOP_WINDOWS_SIGNTOOL=${signtool}\nDSH_DESKTOP_WINDOWS_KEY_CONTAINER=container\nDSH_DESKTOP_WINDOWS_TOKEN_PIN=pin\n`)
  run(copy.root, ['--mode', 'unsigned', '--policy', 'disabled'])
  const settings = parseEnv(readFileSync(copy.output, 'utf8'))
  assert.equal(settings.DSH_DESKTOP_LOCAL_UNSIGNED, '1')
  for (const name of ['DSH_DESKTOP_WINDOWS_CER_FILE', 'DSH_DESKTOP_WINDOWS_SIGNTOOL', 'DSH_DESKTOP_WINDOWS_KEY_CONTAINER', 'DSH_DESKTOP_WINDOWS_TOKEN_PIN']) assert.equal(settings[name], undefined)
  chmodSync(copy.output, 0o600)
})
