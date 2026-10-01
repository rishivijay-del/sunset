/**
 * Sunset — Reference Finder (repo scan)
 *
 * Deterministic scan of a Salesforce source-format repository for every
 * reference to a custom field. No network, no AI: this is the fast, exact
 * first layer. Org-side sources (agentia cicd metadata dependency list,
 * Tooling API) are merged in later by the investigator.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** What deleting the field means for this reference. */
export type Impact =
  | 'definition' // the field's own metadata file
  | 'blocker' // Salesforce refuses to delete the field while this exists
  | 'repoHazard' // org allows the delete, but this file breaks future deploys
  | 'warning' // not blocking, but someone relies on it (reports, dashboards)
  | 'unknown' // mentions the name in a file type we don't classify

export type Confidence = 'exact' | 'likely' | 'possible'

export interface Reference {
  file: string // repo-relative path, forward slashes
  kind: string // human-readable metadata kind, e.g. "Apex class"
  impact: Impact
  confidence: Confidence
  lines: number[] // 1-based line numbers of matches
  snippet: string // first matching line, trimmed
}

export interface ScanResult {
  target: { object: string; field: string; qualified: string }
  filesScanned: number
  references: Reference[]
  summary: Record<Impact, number>
}

interface KindRule {
  test: (path: string) => boolean
  kind: string
  impact: Impact
}

const ends = (...suffixes: string[]) => (p: string) => suffixes.some((s) => p.endsWith(s))
const has = (fragment: string) => (p: string) => p.includes(fragment)

/**
 * Ordered rules: first match wins. Field-level files under objects/ are
 * refined further in refineObjectFile() because a field file can be a
 * formula, a roll-up summary, or a lookup filter.
 */
const RULES: KindRule[] = [
  { test: ends('.cls'), kind: 'Apex class', impact: 'blocker' },
  { test: ends('.trigger'), kind: 'Apex trigger', impact: 'blocker' },
  { test: ends('.flow-meta.xml'), kind: 'Flow', impact: 'blocker' },
  { test: ends('.page'), kind: 'Visualforce page', impact: 'blocker' },
  { test: ends('.component'), kind: 'Visualforce component', impact: 'blocker' },
  { test: (p) => has('/lwc/')(p) && ends('.js', '.html', '.ts')(p), kind: 'Lightning web component', impact: 'blocker' },
  { test: (p) => has('/aura/')(p) && ends('.cmp', '.js', '.app', '.evt')(p), kind: 'Aura component', impact: 'blocker' },
  { test: ends('.workflow-meta.xml'), kind: 'Workflow rule / field update', impact: 'blocker' },
  { test: ends('.validationRule-meta.xml'), kind: 'Validation rule', impact: 'blocker' },
  { test: ends('.field-meta.xml'), kind: 'Custom field', impact: 'blocker' }, // refined below
  { test: ends('.layout-meta.xml'), kind: 'Page layout', impact: 'repoHazard' },
  { test: ends('.permissionset-meta.xml'), kind: 'Permission set', impact: 'repoHazard' },
  { test: ends('.profile-meta.xml'), kind: 'Profile', impact: 'repoHazard' },
  { test: ends('.listView-meta.xml'), kind: 'List view', impact: 'repoHazard' },
  { test: ends('.compactLayout-meta.xml'), kind: 'Compact layout', impact: 'repoHazard' },
  { test: ends('.recordType-meta.xml'), kind: 'Record type', impact: 'repoHazard' },
  { test: ends('.fieldSet-meta.xml'), kind: 'Field set', impact: 'repoHazard' },
  { test: ends('.flexipage-meta.xml'), kind: 'Lightning page', impact: 'repoHazard' },
  { test: ends('.quickAction-meta.xml'), kind: 'Quick action', impact: 'repoHazard' },
  { test: ends('.report-meta.xml'), kind: 'Report', impact: 'warning' },
  { test: ends('.reportType-meta.xml'), kind: 'Report type', impact: 'warning' },
  { test: ends('.dashboard-meta.xml'), kind: 'Dashboard', impact: 'warning' },
]

const SKIP_DIRS = new Set(['.git', 'node_modules', '.sfdx', '.sf', '.sunset', 'dist'])
const TEXT_EXT = /\.(cls|trigger|xml|js|ts|html|cmp|app|evt|page|component|json|yaml|yml|md)$/i

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (TEXT_EXT.test(name)) out.push(full)
  }
  return out
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Object name if the path lives under objects/<Object>/..., else undefined. */
function objectOfPath(p: string): string | undefined {
  const m = /(?:^|\/)objects\/([^/]+)\//.exec(p)
  return m?.[1]
}

/** A field file can be a formula, a roll-up summary, or a lookup filter. */
function refineObjectFile(p: string, text: string, field: string): { kind: string; impact: Impact } {
  if (new RegExp(`/fields/${escapeRe(field)}\\.field-meta\\.xml$`, 'i').test(p)) {
    return { kind: 'Field definition', impact: 'definition' }
  }
  if (/<summarizedField>/i.test(text) || /<summaryForeignKey>/i.test(text)) {
    return { kind: 'Roll-up summary field', impact: 'blocker' }
  }
  if (/<lookupFilter>/i.test(text)) return { kind: 'Lookup filter', impact: 'blocker' }
  if (/<formula>/i.test(text)) return { kind: 'Formula field', impact: 'blocker' }
  return { kind: 'Custom field', impact: 'blocker' }
}

function confidenceFor(p: string, text: string, object: string, field: string): Confidence {
  const qualified = new RegExp(`\\b${escapeRe(object)}\\.${escapeRe(field)}\\b`, 'i')
  const schemaImport = new RegExp(`@salesforce/schema/${escapeRe(object)}\\.${escapeRe(field)}\\b`, 'i')
  if (qualified.test(text) || schemaImport.test(text)) return 'exact'
  const pathObject = objectOfPath(p)
  if (pathObject && pathObject.toLowerCase() === object.toLowerCase()) return 'exact'
  const fileName = p.split('/').pop() ?? ''
  if (fileName.toLowerCase().startsWith(`${object.toLowerCase()}-`)) return 'exact' // Account-Layout.layout-meta.xml
  if (p.endsWith('.flow-meta.xml') && new RegExp(`<object>${escapeRe(object)}</object>`, 'i').test(text)) return 'likely'
  if (/\bFROM\s+/i.test(text) && new RegExp(`\\bFROM\\s+${escapeRe(object)}\\b`, 'i').test(text)) return 'likely'
  return 'possible'
}

/**
 * Scan a source-format repo for references to Object.Field__c.
 * Salesforce API names are case-insensitive, so matching is too.
 */
export function scanRepo(repoRoot: string, qualifiedField: string): ScanResult {
  const [object, field] = qualifiedField.split('.')
  if (!object || !field) {
    throw new Error(`Expected Object.Field__c, got "${qualifiedField}"`)
  }
  const nameRe = new RegExp(`\\b${escapeRe(field)}\\b`, 'i')
  const files = walk(repoRoot)
  const references: Reference[] = []

  for (const full of files) {
    const p = relative(repoRoot, full).split(sep).join('/')
    const text = readFileSync(full, 'utf8')
    const isOwnDefinition = new RegExp(`objects/${escapeRe(object)}/fields/${escapeRe(field)}\\.field-meta\\.xml$`, 'i').test(p)
    if (!isOwnDefinition && !nameRe.test(text)) continue

    // A field with the same API name on a different object is not our field.
    const pathObject = objectOfPath(p)
    if (pathObject && pathObject.toLowerCase() !== object.toLowerCase() && p.endsWith('.field-meta.xml')) {
      const crossObject = new RegExp(`\\b\\w+(?:__r)?\\.${escapeRe(field)}\\b`, 'i').test(text)
      if (!crossObject) continue // e.g. Contact.Legacy_Region__c definition, unrelated
    }

    const rule = RULES.find((r) => r.test(p))
    let kind = rule?.kind ?? 'Other file'
    let impact: Impact = rule?.impact ?? 'unknown'
    if (p.endsWith('.field-meta.xml')) ({ kind, impact } = refineObjectFile(p, text, field))

    const lines: number[] = []
    let snippet = ''
    text.split(/\r?\n/).forEach((line, i) => {
      if (nameRe.test(line)) {
        lines.push(i + 1)
        if (!snippet) snippet = line.trim().slice(0, 160)
      }
    })

    references.push({
      file: p,
      kind,
      impact,
      confidence: impact === 'definition' ? 'exact' : confidenceFor(p, text, object, field),
      lines,
      snippet,
    })
  }

  const order: Impact[] = ['definition', 'blocker', 'repoHazard', 'warning', 'unknown']
  references.sort((a, b) => order.indexOf(a.impact) - order.indexOf(b.impact) || a.file.localeCompare(b.file))
  const summary = Object.fromEntries(order.map((k) => [k, references.filter((r) => r.impact === k).length])) as Record<Impact, number>

  return { target: { object, field, qualified: `${object}.${field}` }, filesScanned: files.length, references, summary }
}

/** All custom fields defined in the repo for an object (objects/<Object>/fields/*__c). */
export function listCustomFields(repoRoot: string, object: string): { field: string; file: string; xml: string }[] {
  const out: { field: string; file: string; xml: string }[] = []
  for (const full of walk(repoRoot)) {
    const p = relative(repoRoot, full).split(sep).join('/')
    const m = new RegExp(`(?:^|/)objects/${escapeRe(object)}/fields/([^/]+__c)\\.field-meta\\.xml$`, 'i').exec(p)
    if (m) out.push({ field: m[1], file: p, xml: readFileSync(full, 'utf8') })
  }
  return out.sort((a, b) => a.field.localeCompare(b.field))
}

/** Path of the field definition file in the repo, if present. */
export function findFieldFile(repoRoot: string, object: string, field: string): string | undefined {
  return listCustomFields(repoRoot, object).find((f) => f.field.toLowerCase() === field.toLowerCase())?.file
}

/** Metadata type + full name for a reference file, used for commits and manifests. */
export function metadataMemberOf(path: string): { type: string; name: string } | undefined {
  const file = path.split('/').pop() ?? ''
  const objectOf = /(?:^|\/)objects\/([^/]+)\//.exec(path)?.[1]
  const strip = (suffix: string) => file.slice(0, -suffix.length)
  const table: [string, string, (base: string) => string][] = [
    ['.cls', 'ApexClass', (b) => b],
    ['.trigger', 'ApexTrigger', (b) => b],
    ['.flow-meta.xml', 'Flow', (b) => b],
    ['.page', 'ApexPage', (b) => b],
    ['.component', 'ApexComponent', (b) => b],
    ['.layout-meta.xml', 'Layout', (b) => b],
    ['.permissionset-meta.xml', 'PermissionSet', (b) => b],
    ['.profile-meta.xml', 'Profile', (b) => b],
    ['.field-meta.xml', 'CustomField', (b) => `${objectOf}.${b}`],
    ['.validationRule-meta.xml', 'ValidationRule', (b) => `${objectOf}.${b}`],
    ['.listView-meta.xml', 'ListView', (b) => `${objectOf}.${b}`],
    ['.compactLayout-meta.xml', 'CompactLayout', (b) => `${objectOf}.${b}`],
    ['.recordType-meta.xml', 'RecordType', (b) => `${objectOf}.${b}`],
    ['.fieldSet-meta.xml', 'FieldSet', (b) => `${objectOf}.${b}`],
    ['.quickAction-meta.xml', 'QuickAction', (b) => b],
    ['.flexipage-meta.xml', 'FlexiPage', (b) => b],
    ['.workflow-meta.xml', 'Workflow', (b) => b],
  ]
  for (const [suffix, type, name] of table) {
    if (file.endsWith(suffix)) {
      const base = strip(suffix).replace(/\.(cls|trigger|page|component)$/, '')
      return { type, name: name(base) }
    }
  }
  const lwc = /\/lwc\/([^/]+)\//.exec(path)
  if (lwc) return { type: 'LightningComponentBundle', name: lwc[1] }
  const aura = /\/aura\/([^/]+)\//.exec(path)
  if (aura) return { type: 'AuraDefinitionBundle', name: aura[1] }
  const report = /\/reports\/(.+)\.report-meta\.xml$/.exec(path)
  if (report) return { type: 'Report', name: report[1] }
  return undefined
}
