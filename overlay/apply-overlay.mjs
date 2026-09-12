/**
 * Anchor-based overlay for upstream sources that this builder must adjust.
 *
 * A line-context patch cannot survive upstream refactoring: the lines surrounding the branding
 * keys changed between the dsh-v0.1.5-rc.2 tag and master. Matching anchors instead keeps each
 * edit valid across revisions and fails loudly when an anchor disappears.
 *
 * build.ps1 resets the checkout to the pinned commit before running this, so every edit starts
 * from a pristine file. The `applied` predicate only makes a repeated run on an already overlaid
 * tree a no-op instead of an error.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CONFIG = 'apps/desktop/electron-builder.config.mjs'
const SMOKE = 'apps/desktop/tests/fixtures/runtime-payload-smoke.mjs'

const EDITS = [
  {
    file: CONFIG,
    id: 'productName',
    pattern: /^([ \t]*)productName: 'DeepSeek Harness',$/mu,
    replace: (_match, indent) => `${indent}productName: env.DSH_DESKTOP_PRODUCT_NAME ?? 'DeepSeek Harness',`,
    applied: text => text.includes('productName: env.DSH_DESKTOP_PRODUCT_NAME'),
  },
  {
    file: CONFIG,
    id: 'win.icon',
    pattern: /^([ \t]*)win: \{$/mu,
    replace: (_match, indent) => `${indent}win: {\n${indent}  icon: env.DSH_DESKTOP_ICON,`,
    applied: text => text.includes('icon: env.DSH_DESKTOP_ICON,'),
  },
  {
    // The runtime payload smoke requires fs-ext, which left the dependency graph when the session
    // write lock moved to @deepseek-ai/node-addon-system/flock. The module is absent from the
    // lockfile and from every package.json, so prepare:dsh can never satisfy this check.
    file: SMOKE,
    id: 'drop-stale-fs-ext-check',
    pattern: /\/\*\* fs-ext implements[\s\S]*?\n\}\n\n/u,
    replace: () => '',
    applied: text => !text.includes('checkFsExt'),
  },
  {
    file: SMOKE,
    id: 'drop-stale-fs-ext-call',
    pattern: /^  checkFsExt\(\)\n/mu,
    replace: () => '',
    applied: text => !text.includes('checkFsExt'),
  },
  {
    file: SMOKE,
    id: 'drop-stale-fs-ext-report',
    pattern: /^([ \t]*)fsExt: true, /mu,
    replace: (_match, indent) => indent,
    applied: text => !text.includes('fsExt: true'),
  },
  {
    file: SMOKE,
    id: 'drop-unused-fs-imports',
    pattern: /^import \{ closeSync, mkdtempSync, openSync, readFileSync, readSync, writeFileSync \} from 'node:fs'$/mu,
    replace: () => "import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'",
    applied: text => text.includes("import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'"),
  },
]

/**
 * Apply one edit to its file.
 * @param {string} root - Harness checkout root.
 * @param {{ file: string, id: string, pattern: RegExp, replace: Function, applied: Function }} edit - Edit to apply.
 * @returns {string | undefined} The applied edit id, or undefined when it was already in place.
 */
function applyEdit(root, edit) {
  const target = resolve(root, edit.file)
  const original = readFileSync(target, 'utf8')
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const normalized = original.replace(/\r\n/gu, '\n')
  if (edit.applied(normalized)) return undefined
  const matches = [...normalized.matchAll(new RegExp(edit.pattern.source, 'gmu'))]
  if (matches.length !== 1) {
    throw new Error(
      `overlay: ${edit.id} matched ${String(matches.length)} times in ${edit.file}; expected exactly 1. `
      + 'Upstream changed this file, so the overlay needs a new anchor.',
    )
  }
  const next = normalized.replace(edit.pattern, (...args) => edit.replace(...args))
  writeFileSync(target, eol === '\n' ? next : next.replace(/\n/gu, eol))
  return edit.id
}

const root = process.argv[2]
if (root === undefined) {
  console.error('usage: node apply-overlay.mjs <harness checkout root>')
  process.exit(2)
}
try {
  const applied = EDITS.map(edit => applyEdit(resolve(root), edit)).filter(Boolean)
  console.log(applied.length === 0
    ? 'overlay: already applied'
    : `overlay: applied ${applied.join(', ')}`)
}
catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
