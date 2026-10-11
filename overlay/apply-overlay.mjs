/** Apply branding and the explicit local unsigned policy option to an upstream checkout. */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CONFIG = 'apps/desktop/scripts/electron-builder-config.mjs'
const ENVIRONMENT = 'apps/desktop/scripts/desktop-package-environment.mjs'

const EDITS = [
  {
    file: CONFIG,
    id: 'productName',
    pattern: /^([ \t]*)productName: 'DeepSeek Harness',$/mu,
    applied: /^([ \t]*)productName: env\.DSH_DESKTOP_PRODUCT_NAME \?\? 'DeepSeek Harness',$/mu,
    replace: (_match, indent) => `${indent}productName: env.DSH_DESKTOP_PRODUCT_NAME ?? 'DeepSeek Harness',`,
  },
  {
    file: CONFIG,
    id: 'win.icon',
    pattern: /^([ \t]*)icon: (fileURLToPath\(new URL\('\.\.\/resources\/icon-windows\.png', import\.meta\.url\)\)),$/mu,
    applied: /^([ \t]*)icon: env\.DSH_DESKTOP_ICON \?\? fileURLToPath\(new URL\('\.\.\/resources\/icon-windows\.png', import\.meta\.url\)\),$/mu,
    replace: (_match, indent, expression) => `${indent}icon: env.DSH_DESKTOP_ICON ?? ${expression},`,
  },
  {
    file: CONFIG,
    id: 'win.executableName',
    pattern: /^([ \t]*)win: \{\n(?![ \t]*executableName:)/mu,
    applied: /^[ \t]*win: \{\n[ \t]*executableName: 'DeepSeek Harness',$/mu,
    replace: (_match, indent) => `${indent}win: {\n${indent}  executableName: 'DeepSeek Harness',\n`,
  },
  {
    file: CONFIG,
    id: 'local-unsigned-policy',
    pattern: /^  const policy = resolveDesktopPolicyEnvironment\(env\)$/mu,
    applied: /^  const policy = env\.DSH_DESKTOP_LOCAL_UNSIGNED === '1' && env\.DSH_DESKTOP_UNSIGNED === '1'/mu,
    replace: () => "  const policy = env.DSH_DESKTOP_LOCAL_UNSIGNED === '1' && env.DSH_DESKTOP_UNSIGNED === '1'\n    ? undefined : resolveDesktopPolicyEnvironment(env)",
  },
  ...['SHARED_SETTING', 'AMBIENT_RELEASE_SETTING'].map(name => ({
    file: ENVIRONMENT,
    id: `${name}.local-unsigned`,
    pattern: new RegExp(`^const ${name} = (?!.*LOCAL_UNSIGNED).+$`, 'mu'),
    applied: new RegExp(`^const ${name} = .*APP_ID\\|LOCAL_UNSIGNED\\|AUTO_UPDATE_ENV.*$`, 'mu'),
    replace: line => {
      if (!line.includes('APP_ID|AUTO_UPDATE_ENV')) throw new Error(`overlay: ${name} no longer declares expected release fields`)
      return line.replace('APP_ID|AUTO_UPDATE_ENV', 'APP_ID|LOCAL_UNSIGNED|AUTO_UPDATE_ENV')
    },
  })),
  {
    file: ENVIRONMENT,
    id: 'validate-local-unsigned',
    pattern: /^  resolveDesktopPolicyEnvironment\(environment\)$/mu,
    applied: /^  const localUnsigned = environment\.DSH_DESKTOP_LOCAL_UNSIGNED === '1'$/mu,
    replace: () => `  const localUnsigned = environment.DSH_DESKTOP_LOCAL_UNSIGNED === '1'
  if (environment.DSH_DESKTOP_LOCAL_UNSIGNED !== undefined && !localUnsigned) {
    throw new Error('desktop package: DSH_DESKTOP_LOCAL_UNSIGNED must be 1 or absent')
  }
  if (localUnsigned && options.unsigned !== true) {
    throw new Error('desktop package: local unsigned policy mode requires --unsigned')
  }
  if (!localUnsigned) resolveDesktopPolicyEnvironment(environment)`,
  },
]

/**
 * Validate every anchor before writing any source file.
 * @param {string} root - Harness checkout root.
 * @returns {{ files: Map<string, {content: string, eol: string}>, ids: string[] }} Validated source replacements.
 */
function prepareEdits(root) {
  const sourceByFile = new Map()
  const changed = new Map()
  const ids = []
  for (const edit of EDITS) {
    const target = resolve(root, edit.file)
    let source = sourceByFile.get(target)
    if (source === undefined) {
      const original = readFileSync(target, 'utf8')
      source = { content: original.replace(/\r\n/gu, '\n'), eol: original.includes('\r\n') ? '\r\n' : '\n' }
      sourceByFile.set(target, source)
    }
    const normalized = source.content
    const matches = [...normalized.matchAll(new RegExp(edit.pattern.source, 'gmu'))]
    const appliedMatches = [...normalized.matchAll(new RegExp(edit.applied.source, 'gmu'))]
    if (matches.length === 0 && appliedMatches.length === 1) continue
    if (matches.length !== 1 || appliedMatches.length !== 0) {
      throw new Error(`overlay: ${edit.id} matched ${String(matches.length)} source and ${String(appliedMatches.length)} applied anchors in ${edit.file}; expected exactly one source anchor.`)
    }
    source.content = normalized.replace(edit.pattern, (...args) => edit.replace(...args))
    changed.set(target, source)
    ids.push(edit.id)
  }
  return { files: changed, ids }
}

const root = process.argv[2]
if (root === undefined) {
  console.error('usage: node apply-overlay.mjs <harness checkout root>')
  process.exit(2)
}
try {
  const pending = prepareEdits(resolve(root))
  for (const [target, source] of pending.files) {
    writeFileSync(target, source.eol === '\n' ? source.content : source.content.replace(/\n/gu, source.eol))
  }
  console.log(pending.ids.length === 0
    ? 'overlay: already applied'
    : `overlay: applied ${pending.ids.join(', ')}`)
}
catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
