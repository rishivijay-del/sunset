/**
 * Salesforce adapter (via the official `sf` CLI). Used for things Copado
 * doesn't own: usage queries, Tooling API, check-only validation (the
 * Blocker Oracle), bulk data backup/restore, and last-resort destructive deploys.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runJson } from '../core/runner.js'
import { ensureDir } from '../util/index.js'

export interface DeployOutcome {
  success: boolean
  failures: { fullName: string; componentType: string; problem: string }[]
  testFailures: { name: string; methodName: string; message: string }[]
  raw: any
}

/** Salesforce picks the right default test level when none is given (production orgs reject NoTestRun). */
const testLevelArgs = (level?: string) => (level ? ['--test-level', level] : [])

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v])

export function parseDeployResult(data: any): DeployOutcome {
  const result = data?.result ?? data?.data ?? {}
  const details = result.details ?? result
  const failures = asArray<any>(details.componentFailures)
    .map((f) => ({ fullName: String(f.fullName ?? ''), componentType: String(f.componentType ?? ''), problem: String(f.problem ?? '') }))
    .filter((f) => f.problem)
  const tests = details.runTestResult ?? {}
  const testFailures = asArray<any>(tests.failures).map((t) => ({ name: String(t.name ?? ''), methodName: String(t.methodName ?? ''), message: String(t.message ?? '') }))
  const success = Boolean(result.success ?? (data?.status === 0 && failures.length === 0))
  // Some errors come back only at the top level (e.g. auth problems)
  if (!success && failures.length === 0 && data?.message) failures.push({ fullName: '', componentType: '', problem: String(data.message) })
  return { success, failures, testFailures, raw: data }
}

export class Salesforce {
  constructor(private readonly bin = 'sf') {}

  query(alias: string, soql: string, tooling = false): { totalSize: number; records: any[] } {
    const args = ['data', 'query', '-q', soql, '-o', alias, '--json']
    if (tooling) args.push('--use-tooling-api')
    const { data } = runJson(this.bin, args)
    return { totalSize: Number(data?.result?.totalSize ?? 0), records: data?.result?.records ?? [] }
  }

  count(alias: string, soqlCount: string): number {
    return this.query(alias, soqlCount).totalSize
  }

  describe(alias: string, object: string): any {
    return runJson(this.bin, ['sobject', 'describe', '-s', object, '-o', alias, '--json']).data?.result
  }

  /** Bulk export to CSV (proven backup source). */
  exportCsv(alias: string, soql: string, outFile: string): void {
    runJson(this.bin, ['data', 'export', 'bulk', '-q', soql, '-o', alias, '--output-file', outFile, '--result-format', 'csv', '--wait', '30', '--json'], {
      timeoutMs: 45 * 60_000,
    })
  }

  /** Bulk upsert on Id (used by restore). */
  upsertCsv(alias: string, object: string, file: string): any {
    return runJson(this.bin, ['data', 'upsert', 'bulk', '-s', object, '-f', file, '-i', 'Id', '-o', alias, '--wait', '30', '--json'], {
      timeoutMs: 45 * 60_000,
    }).data
  }

  /** Check-only deploy with a post-destructive manifest: Salesforce tells us every blocker. */
  validateDestructive(alias: string, members: { type: string; name: string }[], apiVersion: string, testLevel = ''): DeployOutcome {
    const dir = writeDestructiveManifests(members, apiVersion)
    const { data } = runJson(
      this.bin,
      ['project', 'deploy', 'validate', '--manifest', join(dir, 'package.xml'), '--post-destructive-changes', join(dir, 'destructiveChangesPost.xml'), '-o', alias, ...testLevelArgs(testLevel), '--wait', '60', '--json'],
      { cwd: dir, allowFail: true, timeoutMs: 70 * 60_000 },
    )
    return parseDeployResult(data)
  }

  /** Deletion path C: real destructive deploy (only after every gate has passed). */
  deployDestructive(alias: string, members: { type: string; name: string }[], apiVersion: string, testLevel = ''): DeployOutcome {
    const dir = writeDestructiveManifests(members, apiVersion)
    const { data } = runJson(
      this.bin,
      ['project', 'deploy', 'start', '--manifest', join(dir, 'package.xml'), '--post-destructive-changes', join(dir, 'destructiveChangesPost.xml'), '-o', alias, ...testLevelArgs(testLevel), '--wait', '60', '--json'],
      { cwd: dir, allowFail: true, timeoutMs: 70 * 60_000 },
    )
    return parseDeployResult(data)
  }

  /** Check-only deploy of specific source paths from the project (proves edits compile). */
  validateSource(projectRoot: string, alias: string, paths: string[], testLevel = ''): DeployOutcome {
    const args = ['project', 'deploy', 'validate', '-o', alias, ...testLevelArgs(testLevel), '--wait', '60', '--json']
    for (const p of paths) args.push('--source-dir', p)
    const { data } = runJson(this.bin, args, { cwd: projectRoot, allowFail: true, timeoutMs: 70 * 60_000 })
    return parseDeployResult(data)
  }

  /** Validate a standalone field definition from a capsule (proves it can be redeployed). */
  validateFieldDefinition(alias: string, object: string, field: string, fieldXml: string, apiVersion: string): DeployOutcome {
    const dir = mkdtempSync(join(tmpdir(), 'sunset-proof-'))
    writeFileSync(join(dir, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: apiVersion }))
    const fieldDir = join(dir, 'force-app', 'main', 'default', 'objects', object, 'fields')
    ensureDir(fieldDir)
    writeFileSync(join(fieldDir, `${field}.field-meta.xml`), fieldXml)
    const { data } = runJson(this.bin, ['project', 'deploy', 'validate', '--source-dir', 'force-app', '-o', alias, '--wait', '30', '--json'], {
      cwd: dir,
      allowFail: true,
    })
    return parseDeployResult(data)
  }

  deleteToolingRecord(alias: string, sobject: string, id: string): void {
    runJson(this.bin, ['data', 'delete', 'record', '--use-tooling-api', '-s', sobject, '-i', id, '-o', alias, '--json'])
  }

  runApexTests(alias: string, classNames: string[]): { passed: boolean; raw: any } {
    const args = ['apex', 'run', 'test', '-o', alias, '--wait', '30', '--result-format', 'json', '--json']
    for (const c of classNames) args.push('--class-names', c)
    const { data } = runJson(this.bin, args, { allowFail: true, timeoutMs: 40 * 60_000 })
    const outcome = String(data?.result?.summary?.outcome ?? '')
    return { passed: outcome.toLowerCase() === 'passed', raw: data }
  }
}

export { testLevelArgs }

export function writeDestructiveManifests(members: { type: string; name: string }[], apiVersion: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sunset-destructive-'))
  writeFileSync(join(dir, 'package.xml'), packageXml([], apiVersion))
  writeFileSync(join(dir, 'destructiveChangesPost.xml'), packageXml(members, apiVersion))
  writeFileSync(join(dir, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: '.', default: true }], sourceApiVersion: apiVersion }))
  return dir
}

export function packageXml(members: { type: string; name: string }[], apiVersion: string): string {
  const byType = new Map<string, string[]>()
  for (const m of members) byType.set(m.type, [...(byType.get(m.type) ?? []), m.name])
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const types = [...byType.entries()]
    .map(([type, names]) => `    <types>\n${names.map((n) => `        <members>${esc(n)}</members>`).join('\n')}\n        <name>${esc(type)}</name>\n    </types>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${types ? types + '\n' : ''}    <version>${apiVersion}</version>\n</Package>\n`
}
