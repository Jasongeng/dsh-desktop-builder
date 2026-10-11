import { accessSync, constants, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseArgs, parseEnv } from 'node:util'

const HEADER = '# Managed by dsh-desktop-builder; configure the builder input instead.'
const OUTPUT_NAME = '.env.windows'
const SIGNING_FIELDS = [
  'DSH_DESKTOP_WINDOWS_CER_FILE',
  'DSH_DESKTOP_WINDOWS_SIGNTOOL',
  'DSH_DESKTOP_WINDOWS_KEY_CONTAINER',
  'DSH_DESKTOP_WINDOWS_TOKEN_PIN',
]
const ALLOWED = new Set([
  'DSH_DESKTOP_APP_ID', 'DSH_DESKTOP_AUTO_UPDATE_ENV', 'DSH_DESKTOP_NPM_REGISTRY',
  'DSH_DESKTOP_MANDATORY_UPDATE_CONFIG', 'DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN',
  'DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN', 'DOWNLOAD_TEST_RELEASE_ID',
  'DOWNLOAD_TEST_ORIGIN', 'DOWNLOAD_TEST_COS_BUCKET', 'DOWNLOAD_TEST_COS_SECRET_ID',
  'DOWNLOAD_TEST_COS_SECRET_KEY', 'DOWNLOAD_PROD_COS_BUCKET', 'DOWNLOAD_PROD_COS_SECRET_ID',
  'DOWNLOAD_PROD_COS_SECRET_KEY', ...SIGNING_FIELDS,
  'DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_DIR', 'DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY',
])

function fail(message) { throw new Error(`prepare-config: ${message}`) }

function readDotenv(path) {
  let text
  try { text = readFileSync(path, 'utf8').replace(/^\uFEFF/u, '') }
  catch { fail(`cannot read source ${path}`) }
  try { return parseEnv(text) }
  catch { fail(`invalid dotenv syntax in source ${path}`) }
}

function checkSettings(settings, source) {
  for (const [name, value] of Object.entries(settings)) {
    if (!ALLOWED.has(name)) fail(`unsupported setting ${name} in source ${source}`)
    if (value.includes('\0') || value.includes('\r') || value.includes('\n')) fail(`${name} contains a forbidden character`)
  }
}

function validFile(path) {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.R_OK)
    return true
  } catch { return false }
}

function resolveSigningPaths(settings, sourceDirectory) {
  for (const name of ['DSH_DESKTOP_WINDOWS_CER_FILE', 'DSH_DESKTOP_WINDOWS_SIGNTOOL']) {
    const value = settings[name]?.trim()
    if (value !== undefined && value !== '') settings[name] = isAbsolute(value) ? value : resolve(sourceDirectory, value)
  }
}

function determineMode(settings, requestedMode) {
  if (requestedMode === 'unsigned') return 'unsigned'
  const present = SIGNING_FIELDS.filter(name => (settings[name] ?? '').trim() !== '')
  if (present.length !== 0 && present.length !== SIGNING_FIELDS.length) fail('partial Windows signing configuration')
  const complete = present.length === SIGNING_FIELDS.length
  if (requestedMode === 'signed' && !complete) fail('signed mode requires all Windows signing fields')
  if (!complete) return 'unsigned'
  if (!validFile(settings.DSH_DESKTOP_WINDOWS_CER_FILE) || !validFile(settings.DSH_DESKTOP_WINDOWS_SIGNTOOL)) {
    fail('Windows signing certificate and SignTool must be readable files')
  }
  return 'signed'
}

function serialize(settings) {
  const lines = [HEADER]
  for (const name of Object.keys(settings).sort()) {
    const value = settings[name]
    if (value.includes('\0') || value.includes('\r') || value.includes('\n')) fail(`${name} contains a forbidden character`)
    const quote = value.includes("'") ? value.includes('"') ? value.includes('`') ? undefined : '`' : '"' : "'"
    if (quote === undefined) fail(`${name} contains unsupported quote characters`)
    lines.push(`${name}=${quote}${value}${quote}`)
  }
  const text = `${lines.join('\n')}\n`
  try {
    const parsed = parseEnv(text)
    for (const [name, value] of Object.entries(settings)) if (parsed[name] !== value) fail(`cannot safely serialize ${name}`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('prepare-config:')) throw error
    fail('generated dotenv failed validation')
  }
  return text
}

function parseCli(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    policy: { type: 'string', default: 'configured' }, source: { type: 'string' }, mode: { type: 'string', default: 'auto' },
  } })
  if (positionals.length !== 1) fail('usage: prepare-config.mjs <harnessRoot> --policy configured|disabled [--source path] [--mode auto|signed|unsigned]')
  if (!['configured', 'disabled'].includes(values.policy) || !['auto', 'signed', 'unsigned'].includes(values.mode)) fail('invalid policy or mode')
  return { harnessRoot: resolve(positionals[0]), policy: values.policy, source: values.source, mode: values.mode }
}

function main(argv = process.argv.slice(2), parentEnvironment = process.env) {
  const options = parseCli(argv)
  const builderRoot = resolve(import.meta.dirname, '..')
  const outputPath = join(options.harnessRoot, 'apps', 'desktop', OUTPUT_NAME)
  const sourcePath = options.source === undefined ? join(builderRoot, OUTPUT_NAME) : resolve(options.source)
  const sourceSettings = (() => {
    try { statSync(sourcePath) } catch (error) {
      if (options.source === undefined && error.code === 'ENOENT') return {}
      fail(`cannot read source ${sourcePath}`)
    }
    return readDotenv(sourcePath)
  })()
  checkSettings(sourceSettings, sourcePath)
  resolveSigningPaths(sourceSettings, dirname(sourcePath))
  const settings = Object.fromEntries([...ALLOWED].filter(name => parentEnvironment[name] !== undefined).map(name => [name, parentEnvironment[name]]))
  Object.assign(settings, sourceSettings)
  settings.DSH_DESKTOP_APP_ID ||= 'com.example.dsh-desktop'
  settings.DSH_DESKTOP_AUTO_UPDATE_ENV ||= 'test'
  const selectedMode = determineMode(settings, options.mode)
  if (selectedMode === 'unsigned') for (const name of SIGNING_FIELDS) delete settings[name]
  if (options.policy === 'disabled') {
    if (selectedMode !== 'unsigned') fail('disabled policy requires unsigned mode')
    settings.DSH_DESKTOP_LOCAL_UNSIGNED = '1'
  }
  const desired = serialize(settings)
  mkdirSync(dirname(outputPath), { recursive: true })
  let existing
  try { existing = readFileSync(outputPath, 'utf8') } catch (error) {
    if (error.code !== 'ENOENT') fail(`cannot read existing ${outputPath}`)
  }
  if (existing !== undefined && existing !== desired && !existing.startsWith(`${HEADER}\n`)) fail(`refusing to overwrite custom ${outputPath}`)
  writeFileSync(outputPath, desired, { encoding: 'utf8', mode: 0o600 })
  chmodSync(outputPath, 0o600)
  const result = { mode: selectedMode, appId: settings.DSH_DESKTOP_APP_ID, policyMode: options.policy, releaseEnvironment: settings.DSH_DESKTOP_AUTO_UPDATE_ENV, configPath: outputPath }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  return result
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  try { main() } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'prepare-config failed'}\n`); process.exitCode = 1 }
}

export { main }
