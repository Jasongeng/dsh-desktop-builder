/**
 * Anchor-based branding overlay for the upstream Electron packaging configuration.
 *
 * A line-context patch cannot survive upstream refactoring: the lines surrounding the branding
 * keys changed between the dsh-v0.1.5-rc.2 tag and master. Matching the two branding anchors
 * instead keeps this overlay valid across revisions, and fails loudly when an anchor disappears.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const EDITS = [
  {
    id: 'productName',
    marker: 'productName: env.DSH_DESKTOP_PRODUCT_NAME',
    pattern: /^([ \t]*)productName: 'DeepSeek Harness',$/mu,
    replace: indent => `${indent}productName: env.DSH_DESKTOP_PRODUCT_NAME ?? 'DeepSeek Harness',`,
  },
  {
    id: 'win.icon',
    marker: 'icon: env.DSH_DESKTOP_ICON,',
    pattern: /^([ \t]*)win: \{$/mu,
    replace: indent => `${indent}win: {\n${indent}  icon: env.DSH_DESKTOP_ICON,`,
  },
]

/**
 * Apply every branding edit to one configuration file.
 * @param {string} target - Absolute path of apps/desktop/electron-builder.config.mjs.
 * @returns {string} Identifiers of the edits that changed the file.
 */
function applyBranding(target) {
  const original = readFileSync(target, 'utf8')
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  let source = original.replace(/\r\n/gu, '\n')
  const changed = []
  for (const edit of EDITS) {
    if (source.includes(edit.marker)) continue
    const matches = [...source.matchAll(new RegExp(edit.pattern.source, 'gmu'))]
    if (matches.length !== 1) {
      throw new Error(
        `branding overlay: anchor "${edit.id}" matched ${String(matches.length)} times in ${target}; expected exactly 1. `
        + 'Upstream changed this file, so the overlay needs a new anchor.',
      )
    }
    source = source.replace(edit.pattern, (_match, indent) => edit.replace(indent))
    changed.push(edit.id)
  }
  if (changed.length > 0) writeFileSync(target, eol === '\n' ? source : source.replace(/\n/gu, eol))
  return changed
}

const target = process.argv[2]
if (target === undefined) {
  console.error('usage: node apply-branding.mjs <path to apps/desktop/electron-builder.config.mjs>')
  process.exit(2)
}
try {
  const changed = applyBranding(resolve(target))
  console.log(changed.length === 0
    ? `branding overlay: ${target} already branded`
    : `branding overlay: applied ${changed.join(', ')} to ${target}`)
}
catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
