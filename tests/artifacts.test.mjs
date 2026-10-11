import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectArtifacts, stageFeed } from '../scripts/collect-artifacts.mjs'
import { createHash } from 'node:crypto'

async function fixture(mode = 'unsigned') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-artifacts-'))
  const artifact = join(root, 'apps/desktop/.desktop-build/targets/win-x64', mode === 'unsigned' ? 'unsigned-artifacts' : 'artifacts')
  await mkdir(artifact, { recursive: true })
  return { root, artifact, output: join(root, 'out') }
}

test('installer collection requires an exe and excludes builder debug files', async () => {
  const f = await fixture()
  await writeFile(join(f.artifact, 'builder-debug.yml'), 'secret')
  await assert.rejects(collectArtifacts(f.root, f.output, 'unsigned'), /no \.exe/u)
  await writeFile(join(f.artifact, 'app.exe'), 'exe')
  await writeFile(join(f.artifact, 'app.blockmap'), 'map')
  const result = await collectArtifacts(f.root, f.output, 'unsigned')
  assert.deepEqual(result.files, ['app.blockmap', 'app.exe'])
  assert.ok(!result.files.includes('builder-debug.yml'))
})

test('directory collection preserves win-unpacked contents', async () => {
  const f = await fixture()
  const directory = join(f.artifact, 'win-unpacked')
  await mkdir(join(directory, 'resources'), { recursive: true })
  await writeFile(join(directory, 'app.exe'), 'exe')
  await writeFile(join(directory, 'resources', 'app.asar'), 'asar')
  const result = await collectArtifacts(f.root, f.output, 'unsigned', { directory: true })
  assert.deepEqual(result.files, ['win-unpacked/app.exe', 'win-unpacked/resources/app.asar'])
})

test('stageFeed routes payloads and nightly metadata to public prefixes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-feed-'))
  const metadata = join(root, 'nightly.yml')
  await writeFile(metadata, 'version: 1.2.3\nfiles:\n  - url: app.exe\n    size: 3\npath: app.exe\n')
  const payload = join(root, 'app.exe')
  await writeFile(payload, 'exe')
  const output = join(root, 'out')
  const update = { origin: 'https://updates.example.test', keyPrefix: 'dsh-desk/feeds/win-x64', binaryKeyPrefix: 'dsh-desk/bin/win-x64' }
  const feed = await stageFeed({ metadataPath: metadata, outputRoot: output, update, parse: text => ({ version: '1.2.3', files: [{ url: 'app.exe', size: 3, sha512: createHash('sha512').update('exe').digest('base64') }], path: 'app.exe' }), dump: value => JSON.stringify(value), payloads: [payload] })
  const text = await readFile(join(output, 'feed', update.keyPrefix, 'nightly.yml'), 'utf8')
  assert.equal(feed.feedUrl, 'https://updates.example.test/dsh-desk/feeds/win-x64/nightly.yml')
  assert.match(text, /https:\/\/updates\.example\.test\/dsh-desk\/bin\/win-x64\/app\.exe/u)
  assert.equal(await readFile(join(output, 'feed', update.binaryKeyPrefix, 'app.exe'), 'utf8'), 'exe')
})

test('signed directory uses signed artifacts and nested helper executables are insufficient', async () => {
  const f = await fixture('signed')
  const directory = join(f.artifact, 'win-unpacked')
  await mkdir(join(directory, 'resources'), { recursive: true })
  await writeFile(join(directory, 'resources', 'helper.exe'), 'helper')
  await assert.rejects(collectArtifacts(f.root, f.output, 'signed', { directory: true }), /no .exe/u)
  await writeFile(join(directory, 'app.exe'), 'exe')
  const result = await collectArtifacts(f.root, f.output, 'signed', { directory: true })
  assert.ok(result.files.includes('win-unpacked/app.exe'))
})

test('multiple installers cannot be mistaken for one successful build', async () => {
  const f = await fixture()
  await writeFile(join(f.artifact, 'old.exe'), 'old')
  await writeFile(join(f.artifact, 'new.exe'), 'new')
  await assert.rejects(collectArtifacts(f.root, f.output, 'unsigned'), /multiple installers/u)
})
