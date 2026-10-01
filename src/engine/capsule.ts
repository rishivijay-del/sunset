/**
 * Restore Capsule: everything needed to bring a retired field back.
 *   .sunset/capsules/<id>/
 *     manifest.json        what's inside + checksums + proof results
 *     field/<Field>.field-meta.xml
 *     originals/<path>     original copy of every file Sunset changed
 *     data/<ENV>.csv       Id + value export, per environment
 *
 * "Proven backup": Sunset refuses to delete until
 *   1. exported row count == live COUNT() of populated records,
 *   2. checksums are recorded,
 *   3. the field definition validates as deployable.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ensureDir, readJson, sha256, writeJson } from '../util/index.js'

export interface CapsuleData {
  env: string
  file: string // relative to capsule dir
  rows: number
  expectedRows: number
  sha256: string
}

export interface CapsuleManifest {
  id: string
  planId: string
  createdAt: string
  target: { object: string; field: string; qualified: string }
  fieldFile?: string // repo-relative path of the definition
  originals: { path: string; sha256: string }[]
  data: CapsuleData[]
  proof: { rowCountsMatch: boolean; checksumsRecorded: boolean; definitionValid: boolean | 'skipped'; verifiedAt?: string; notes: string[] }
}

export const capsuleDir = (stateDir: string, id: string) => join(stateDir, 'capsules', id)

export function createCapsule(stateDir: string, id: string, planId: string, target: CapsuleManifest['target']): CapsuleManifest {
  const m: CapsuleManifest = {
    id,
    planId,
    createdAt: new Date().toISOString(),
    target,
    originals: [],
    data: [],
    proof: { rowCountsMatch: false, checksumsRecorded: false, definitionValid: 'skipped', notes: [] },
  }
  saveCapsule(stateDir, m)
  return m
}

export const saveCapsule = (stateDir: string, m: CapsuleManifest) => writeJson(join(capsuleDir(stateDir, m.id), 'manifest.json'), m)
export function loadCapsule(stateDir: string, id: string): CapsuleManifest {
  const p = join(capsuleDir(stateDir, id), 'manifest.json')
  if (!existsSync(p)) throw new Error(`Capsule ${id} not found at ${p}`)
  return readJson<CapsuleManifest>(p, undefined as unknown as CapsuleManifest)
}

/** Save the original copy of a repo file before Sunset changes it (idempotent: first copy wins). */
export function preserveOriginal(stateDir: string, m: CapsuleManifest, repoRoot: string, relPath: string) {
  if (m.originals.some((o) => o.path === relPath)) return
  const src = join(repoRoot, relPath)
  if (!existsSync(src)) return
  const dest = join(capsuleDir(stateDir, m.id), 'originals', relPath)
  ensureDir(dirname(dest))
  copyFileSync(src, dest)
  m.originals.push({ path: relPath, sha256: sha256(readFileSync(src)) })
}

export function preserveFieldDefinition(stateDir: string, m: CapsuleManifest, repoRoot: string, fieldFile: string) {
  const dest = join(capsuleDir(stateDir, m.id), 'field', `${m.target.field}.field-meta.xml`)
  ensureDir(dirname(dest))
  copyFileSync(join(repoRoot, fieldFile), dest)
  m.fieldFile = fieldFile
}

export const fieldDefinitionXml = (stateDir: string, m: CapsuleManifest) => readFileSync(join(capsuleDir(stateDir, m.id), 'field', `${m.target.field}.field-meta.xml`), 'utf8')

/** Count data rows in a CSV (handles quoted newlines). */
export function csvRowCount(text: string): number {
  let rows = 0
  let inQuotes = false
  let sawContent = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') i++
      else inQuotes = !inQuotes
      sawContent = true
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && text[i + 1] === '\n') i++
      if (sawContent) rows++
      sawContent = false
    } else sawContent = true
  }
  if (sawContent) rows++
  return Math.max(0, rows - 1) // minus header
}

export function recordDataFile(stateDir: string, m: CapsuleManifest, env: string, relFile: string, expectedRows: number): CapsuleData {
  const full = join(capsuleDir(stateDir, m.id), relFile)
  const text = existsSync(full) ? readFileSync(full, 'utf8') : ''
  const entry: CapsuleData = { env, file: relFile, rows: csvRowCount(text), expectedRows, sha256: sha256(text) }
  m.data = m.data.filter((d) => d.env !== env).concat(entry)
  return entry
}

/** Pure proof check, unit-tested. */
export function evaluateProof(m: CapsuleManifest): { proven: boolean; problems: string[] } {
  const problems: string[] = []
  if (!m.fieldFile) problems.push('Field definition is not in the capsule.')
  if (m.data.length === 0) problems.push('No data export in the capsule.')
  for (const d of m.data) {
    if (d.rows !== d.expectedRows) problems.push(`${d.env}: exported ${d.rows} rows but the org has ${d.expectedRows} populated records.`)
    if (!d.sha256) problems.push(`${d.env}: missing checksum.`)
  }
  if (m.proof.definitionValid === false) problems.push('The saved field definition did not validate as deployable.')
  return { proven: problems.length === 0, problems }
}

export function verifyChecksums(stateDir: string, m: CapsuleManifest): string[] {
  const bad: string[] = []
  for (const d of m.data) {
    const full = join(capsuleDir(stateDir, m.id), d.file)
    if (!existsSync(full) || sha256(readFileSync(full, 'utf8')) !== d.sha256) bad.push(d.file)
  }
  for (const o of m.originals) {
    const full = join(capsuleDir(stateDir, m.id), 'originals', o.path)
    if (!existsSync(full) || sha256(readFileSync(full)) !== o.sha256) bad.push(`originals/${o.path}`)
  }
  return bad
}

/** Put original files back into the repo (restore). */
export function restoreOriginals(stateDir: string, m: CapsuleManifest, repoRoot: string): string[] {
  const restored: string[] = []
  for (const o of m.originals) {
    const src = join(capsuleDir(stateDir, m.id), 'originals', o.path)
    const dest = join(repoRoot, o.path)
    ensureDir(dirname(dest))
    copyFileSync(src, dest)
    restored.push(o.path)
  }
  if (m.fieldFile) {
    const dest = join(repoRoot, m.fieldFile)
    ensureDir(dirname(dest))
    writeFileSync(dest, fieldDefinitionXml(stateDir, m))
    if (!restored.includes(m.fieldFile)) restored.push(m.fieldFile)
  }
  return restored
}

// ---------------- Tombstones ----------------
export interface Tombstone {
  qualified: string
  field: string
  retiredAt: string
  planId: string
  capsuleId?: string
}

const tombstonePath = (stateDir: string) => join(stateDir, 'tombstones.json')
export const loadTombstones = (stateDir: string) => readJson<Tombstone[]>(tombstonePath(stateDir), [])
export function addTombstone(stateDir: string, t: Tombstone) {
  const list = loadTombstones(stateDir).filter((x) => x.qualified.toLowerCase() !== t.qualified.toLowerCase())
  list.push(t)
  writeJson(tombstonePath(stateDir), list)
}
export function removeTombstone(stateDir: string, qualified: string) {
  writeJson(
    tombstonePath(stateDir),
    loadTombstones(stateDir).filter((x) => x.qualified.toLowerCase() !== qualified.toLowerCase()),
  )
}
