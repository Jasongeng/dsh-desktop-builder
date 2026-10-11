import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const overlay = join(here, '..', 'overlay', 'apply-overlay.mjs')

function fixture(config, smoke = 'smoke fixture\n') {
  const root = mkdtempSync(join(tmpdir(), 'dsh-overlay-'))
  const configPath = join(root, 'apps', 'desktop', 'scripts', 'electron-builder-config.mjs')
  const smokePath = join(root, 'apps', 'desktop', 'tests', 'fixtures', 'runtime-payload-smoke.mjs')
  mkdirSync(dirname(configPath), { recursive: true })
  mkdirSync(dirname(smokePath), { recursive: true })
  writeFileSync(configPath, config)
  const environmentPath = join(dirname(configPath), 'desktop-package-environment.mjs')
  writeFileSync(environmentPath, environmentFixture)
  writeFileSync(smokePath, smoke)
  return { root, configPath, smokePath, environmentPath }
}

function run(root, expected = 0) {
  try {
    return execFileSync(process.execPath, [overlay, root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    assert.equal(error.status, expected)
    return error
  }
}

const environmentFixture = `const SHARED_SETTING = /^(?:DSH_DESKTOP_(?:APP_ID|AUTO_UPDATE_ENV))$/u
const AMBIENT_RELEASE_SETTING = /^(?:DSH_DESKTOP_(?:APP_ID|AUTO_UPDATE_ENV))$/u
function resolveDesktopPolicyEnvironment() { throw new Error('policy service required') }
export function validateDesktopPackageEnvironment(environment, target, options = {}) {
  resolveDesktopPolicyEnvironment(environment)
  if (options.unsigned) return
}
`
const modern = `  const policy = resolveDesktopPolicyEnvironment(env)
export default {
  productName: 'DeepSeek Harness',
  mac: {
    icon: fileURLToPath(new URL('../resources/icon-macos.png', import.meta.url)),
  },
  win: {
    icon: fileURLToPath(new URL('../resources/icon-windows.png', import.meta.url)),
  },
}
`

test('updates the current config path and is idempotent', () => {
  const copy = fixture(modern)
  run(copy.root)
  const first = readFileSync(copy.configPath, 'utf8')
  assert.match(first, /productName: env\.DSH_DESKTOP_PRODUCT_NAME \?\? 'DeepSeek Harness'/u)
  assert.match(first, /icon: env\.DSH_DESKTOP_ICON \?\? fileURLToPath\(/u)
  run(copy.root)
  assert.equal(readFileSync(copy.configPath, 'utf8'), first)
})

test('rejects duplicate or missing anchors without partial edits', () => {
  for (const config of [
    modern.replace("productName: 'DeepSeek Harness',", "productName: 'DeepSeek Harness',\n  productName: 'DeepSeek Harness',"),
    modern.replace("productName: 'DeepSeek Harness',", "productLabel: 'DeepSeek Harness',"),
  ]) {
    const copy = fixture(config, 'unchanged smoke\n')
    const before = readFileSync(copy.configPath, 'utf8')
    const result = run(copy.root, 1)
    assert.match(result.stderr, /productName/u)
    assert.equal(readFileSync(copy.configPath, 'utf8'), before)
    assert.equal(readFileSync(copy.smokePath, 'utf8'), 'unchanged smoke\n')
  }
})

test('replaces the existing Windows icon exactly once and leaves smoke untouched', () => {
  const copy = fixture(modern, 'fs-ext smoke marker\n')
  run(copy.root)
  const config = readFileSync(copy.configPath, 'utf8')
  assert.equal((config.match(/\bicon:/gu) ?? []).length, 2)
  assert.match(config, /executableName: 'DeepSeek Harness'/u)
  assert.match(config, /icon: fileURLToPath\(new URL\('\.\.\/resources\/icon-macos.png'/u)
  assert.equal(readFileSync(copy.smokePath, 'utf8'), 'fs-ext smoke marker\n')
})

test('late anchor failure preserves all files, and CRLF survives multiple edits', () => {
  const copy = fixture(modern)
  writeFileSync(copy.environmentPath, 'missing environment anchors\n')
  run(copy.root, 1)
  assert.equal(readFileSync(copy.configPath, 'utf8'), modern)
  const crlf = fixture(modern.replaceAll('\n', '\r\n'))
  run(crlf.root)
  const updated = readFileSync(crlf.configPath, 'utf8')
  assert.ok(updated.includes('\r\n'))
  assert.ok(!updated.replaceAll('\r\n', '').includes('\n'))
})

test('local policy omission requires explicit unsigned mode and rejects invalid values', async () => {
  const copy = fixture(modern)
  run(copy.root)
  const { validateDesktopPackageEnvironment: validate } = await import(pathToFileURL(copy.environmentPath))
  assert.throws(() => validate({}, {}, { unsigned: true }), /policy service required/u)
  assert.doesNotThrow(() => validate({ DSH_DESKTOP_LOCAL_UNSIGNED: '1' }, {}, { unsigned: true }))
  assert.throws(() => validate({ DSH_DESKTOP_LOCAL_UNSIGNED: '1' }, {}, {}), /requires --unsigned/u)
  assert.throws(() => validate({ DSH_DESKTOP_LOCAL_UNSIGNED: '0' }, {}, { unsigned: true }), /must be 1/u)
})
