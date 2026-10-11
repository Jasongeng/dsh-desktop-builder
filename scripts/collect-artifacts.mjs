import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const INSTALLER_FILES = new Set(['.exe', '.blockmap'])
const SIGNED_METADATA = new Set(['nightly.yml', 'win-x64-release.json'])

async function exists(path) {
  try { await access(path); return true } catch { return false }
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function hashFiles(files, root) {
  const hashes = {}
  for (const path of files) hashes[relativeNames([path], root)[0]] = await sha256(path)
  return hashes
}

async function filesUnder(root) {
  const result = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) result.push(path)
    }
  }
  await visit(root)
  return result
}

function relativeNames(paths, root) {
  return paths.map(path => relative(root, path).split(sep).join('/')).sort()
}

/**
 * Rewrite electron-builder metadata and stage its payload under the public update prefixes.
 * @param {object} options - Feed metadata and staging options.
 * @param {string} options.metadataPath - Source nightly.yml path.
 * @param {string} options.outputRoot - Collection output directory.
 * @param {{ origin: string, keyPrefix: string, binaryKeyPrefix: string }} options.update - Resolved upstream update configuration.
 * @param {(text: string) => object} options.parse - YAML parser.
 * @param {(value: object) => string} options.dump - YAML serializer.
 * @param {string[]} options.payloads - Installer and blockmap paths.
 * @returns {Promise<{feedPath: string, feedUrl: string, payloadPaths: string[]}>} Staged feed summary.
 */
export async function stageFeed({ metadataPath, outputRoot, update, parse, dump, payloads }) {
  const metadata = parse(await readFile(metadataPath, 'utf8'))
  if (!metadata || !Array.isArray(metadata.files) || metadata.files.length === 0) {
    throw new Error('signed artifact collection: nightly.yml must contain files')
  }
  const binaryBase = `${update.origin}/${update.binaryKeyPrefix}`
  const names = new Set(payloads.map(path => basename(path)))
  for (const file of metadata.files) {
    if (typeof file.url !== 'string' || !names.has(basename(file.url))) throw new Error('signed artifact collection: feed references a missing payload')
    const payload = payloads.find(path => basename(path) === basename(file.url))
    if ((await stat(payload)).size !== file.size) throw new Error('signed artifact collection: payload size mismatch')
    const digest = createHash('sha512')
    for await (const chunk of createReadStream(payload)) digest.update(chunk)
    if (digest.digest('base64') !== file.sha512) throw new Error('signed artifact collection: payload SHA512 mismatch')
  }
  const payloadRoot = join(outputRoot, 'feed', update.binaryKeyPrefix)
  await mkdir(payloadRoot, { recursive: true })
  const payloadPaths = []
  for (const source of payloads) {
    const destination = join(payloadRoot, basename(source))
    await cp(source, destination)
    payloadPaths.push(destination)
  }
  metadata.files = metadata.files.map(file => ({ ...file, url: `${binaryBase}/${basename(file.url ?? file.path ?? '')}` }))
  if (metadata.path !== undefined) metadata.path = `${binaryBase}/${basename(metadata.path)}`
  const feedPath = join(outputRoot, 'feed', update.keyPrefix, 'nightly.yml')
  await mkdir(dirname(feedPath), { recursive: true })
  await writeFile(feedPath, dump(metadata), 'utf8')
  return { feedPath, feedUrl: `${update.origin}/${update.keyPrefix}/nightly.yml`, payloadPaths }
}

/**
 * Collect electron-builder output for the desktop update workflow.
 * @param {string} harnessRoot - Upstream repository root.
 * @param {string} outputRoot - Destination directory.
 * @param {'signed' | 'unsigned'} mode - Installer signing mode.
 * @param {{ directory?: boolean, environment?: object, updateConfig?: object, loadEnvironment?: Function, yaml?: object }} options - Test seams and directory mode.
 * @returns {Promise<object>} JSON-safe collection summary.
 */
export async function collectArtifacts(harnessRoot, outputRoot, mode, options = {}) {
  if (mode !== 'signed' && mode !== 'unsigned') throw new Error(`artifact collection: mode must be signed or unsigned, got ${mode}`)
  const directory = options.directory === true
  const targetRoot = join(harnessRoot, 'apps', 'desktop', '.desktop-build', 'targets', 'win-x64')
  const artifactDir = join(targetRoot, mode === 'unsigned' ? 'unsigned-artifacts' : 'artifacts')
  if (!await exists(artifactDir)) throw new Error(`artifact collection: missing artifacts directory ${artifactDir}`)
  await mkdir(outputRoot, { recursive: true })
  const sourceDirectory = join(artifactDir, 'win-unpacked')
  if (directory) {
    const exe = (await readdir(sourceDirectory, { withFileTypes: true })).find(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
    if (!exe) throw new Error(`artifact collection: directory output has no .exe in ${sourceDirectory}`)
    const destination = join(outputRoot, 'win-unpacked')
    await cp(sourceDirectory, destination, { recursive: true })
    const files = await filesUnder(outputRoot)
    return { mode, directory: true, files: relativeNames(files, outputRoot), hashes: await hashFiles(files, outputRoot) }
  }
  const candidates = (await readdir(artifactDir, { withFileTypes: true }))
    .filter(entry => entry.isFile() && (INSTALLER_FILES.has(entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase()) || (mode === 'signed' && SIGNED_METADATA.has(entry.name))))
    .map(entry => join(artifactDir, entry.name))
  const executables = candidates.filter(path => path.toLowerCase().endsWith('.exe'))
  if (executables.length === 0) throw new Error('artifact collection: installer output has no .exe')
  if (executables.length !== 1) throw new Error('artifact collection: multiple installers found; use a fresh artifact directory')
  if (mode === 'signed' && !candidates.includes(executables[0] + '.blockmap')) throw new Error('artifact collection: missing installer blockmap')
  const selected = candidates
  const staged = []
  for (const source of selected) {
    const destination = join(outputRoot, basename(source))
    await cp(source, destination)
    staged.push(destination)
  }
  let feed
  if (mode === 'signed') {
    const metadata = staged.find(path => path.toLowerCase().endsWith('nightly.yml'))
    const releaseRecord = staged.find(path => path.toLowerCase().endsWith('win-x64-release.json'))
    if (!metadata || !releaseRecord) throw new Error('artifact collection: signed installer requires nightly.yml and win-x64-release.json')
    const root = resolve(harnessRoot)
    const autoUpdate = options.updateConfig
      ? { resolveDesktopAutoUpdateConfig: () => options.updateConfig }
      : await import(pathToFileURL(join(root, 'apps/desktop/scripts/desktop-auto-update-environment.mjs')).href)
    const packageEnvironment = options.environment ?? (options.loadEnvironment
      ? options.loadEnvironment()
      : (await import(pathToFileURL(join(root, 'apps/desktop/scripts/desktop-package-environment.mjs')).href)).loadDesktopPackageEnvironment('win32'))
    const update = options.updateConfig ?? autoUpdate.resolveDesktopAutoUpdateConfig(packageEnvironment, 'win32', 'x64')
    const require = createRequire(pathToFileURL(join(root, 'apps/desktop/package.json')).href)
    const yaml = options.yaml ?? require('js-yaml')
    const record = JSON.parse(await readFile(releaseRecord, 'utf8'))
    if (yaml.load(await readFile(metadata, 'utf8')).version !== record.version) throw new Error('artifact collection: feed version differs from release record')
    feed = await stageFeed({ metadataPath: metadata, outputRoot, update, parse: yaml.load, dump: value => yaml.dump(value), payloads: staged.filter(path => path.toLowerCase().endsWith('.exe') || path.toLowerCase().endsWith('.blockmap')) })
  }
  const files = await filesUnder(outputRoot)
  const hashes = await hashFiles(files, outputRoot)
  return { mode, directory: false, files: relativeNames(files, outputRoot), hashes, ...(feed ? { feedUrl: feed.feedUrl } : {}) }
}

async function main() {
  const [, , harnessRoot, outputRoot, mode, ...flags] = process.argv
  if (!harnessRoot || !outputRoot || !mode) throw new Error('usage: node scripts/collect-artifacts.mjs <harnessRoot> <outputRoot> <signed|unsigned> [--dir]')
  const summary = await collectArtifacts(harnessRoot, outputRoot, mode, { directory: flags.includes('--dir') })
  process.stdout.write(`${JSON.stringify(summary)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
