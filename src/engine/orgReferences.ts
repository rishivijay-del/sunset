/**
 * Org-side references: things that use the field but may not be in Git
 * (reports, dashboards, flows built directly in an org).
 * Source 1: Copado `cicd metadata dependency list`.
 * Source 2: Tooling API MetadataComponentDependency (cross-check).
 */
import type { Agentia } from '../adapters/agentia.js'
import type { Salesforce } from '../adapters/salesforce.js'
import type { EnvironmentConfig } from '../core/config.js'
import { pick } from '../util/index.js'

export interface OrgReference {
  source: 'copado' | 'tooling'
  type: string
  name: string
  direction: 'uses-target' | 'used-by-target'
}

export function copadoReferences(agentia: Agentia, env: EnvironmentConfig, object: string, field: string, notes: string[]): OrgReference[] {
  try {
    const rows = agentia.dependencies('CustomField', `${object}.${field}`, env)
    return rows.map((r: any) => {
      const dir = String(pick(r, ['direction', 'relation', 'kind']) ?? '').toLowerCase()
      return {
        source: 'copado' as const,
        type: String(pick(r, ['metadataComponentType', 'type', 'componentType', 'MetadataComponentType']) ?? 'Unknown'),
        name: String(pick(r, ['metadataComponentName', 'name', 'componentName', 'MetadataComponentName']) ?? ''),
        direction: dir.includes('up') || dir.includes('used-by-target') ? ('used-by-target' as const) : ('uses-target' as const),
      }
    })
  } catch (err) {
    notes.push(`Copado dependency lookup unavailable: ${(err as Error).message.split('\n')[0]}`)
    return []
  }
}

/** Resolve the CustomField Id (TableEnumOrId is the object name for standard objects, the object Id for custom ones). */
function customFieldId(sf: Salesforce, alias: string, object: string, field: string): string | undefined {
  const devName = field.replace(/__c$/i, '')
  let table = object
  if (object.endsWith('__c')) {
    const ent = sf.query(alias, `SELECT DurableId FROM EntityDefinition WHERE QualifiedApiName = '${object}'`, true)
    table = ent.records[0]?.DurableId ?? object
  }
  const r = sf.query(alias, `SELECT Id FROM CustomField WHERE DeveloperName = '${devName}' AND TableEnumOrId = '${table}'`, true)
  return r.records[0]?.Id
}

export function toolingReferences(sf: Salesforce, env: EnvironmentConfig, object: string, field: string, notes: string[]): OrgReference[] {
  try {
    const id = customFieldId(sf, env.sfAlias, object, field)
    if (!id) {
      notes.push(`Tooling API: ${object}.${field} not found in ${env.name}.`)
      return []
    }
    const r = sf.query(
      env.sfAlias,
      `SELECT MetadataComponentName, MetadataComponentType FROM MetadataComponentDependency WHERE RefMetadataComponentId = '${id}' LIMIT 2000`,
      true,
    )
    return r.records.map((rec: any) => ({
      source: 'tooling' as const,
      type: String(rec.MetadataComponentType),
      name: String(rec.MetadataComponentName),
      direction: 'uses-target' as const,
    }))
  } catch (err) {
    notes.push(`Tooling dependency query unavailable: ${(err as Error).message.split('\n')[0]}`)
    return []
  }
}

/** Obsolete (inactive) flow versions that still reference the field block deletion and live only in the org. */
export function inactiveFlowVersions(sf: Salesforce, alias: string, flowApiNames: string[]): { id: string; flow: string; version: number; status: string }[] {
  if (!flowApiNames.length) return []
  const list = flowApiNames.map((n) => `'${n}'`).join(',')
  const r = sf.query(alias, `SELECT Id, VersionNumber, Status, Definition.DeveloperName FROM Flow WHERE Definition.DeveloperName IN (${list}) AND Status != 'Active'`, true)
  return r.records.map((x: any) => ({ id: x.Id, flow: x.Definition?.DeveloperName, version: x.VersionNumber, status: x.Status }))
}

/** Salesforce's delete validation names flow versions by record Id (301...). Return only those that are not active. */
export function inactiveFlowVersionsByIds(sf: Salesforce, alias: string, ids: string[]): { id: string; flow: string; version: number; status: string }[] {
  if (!ids.length) return []
  const list = ids.map((n) => `'${n}'`).join(',')
  const r = sf.query(alias, `SELECT Id, VersionNumber, Status, Definition.DeveloperName FROM Flow WHERE Id IN (${list}) AND Status != 'Active'`, true)
  return r.records.map((x: any) => ({ id: x.Id, flow: x.Definition?.DeveloperName, version: x.VersionNumber, status: x.Status }))
}

export function mergeOrgReferences(...lists: OrgReference[][]): OrgReference[] {
  const seen = new Map<string, OrgReference>()
  for (const list of lists) for (const r of list) {
    const k = `${r.type}|${r.name}`.toLowerCase()
    if (!seen.has(k)) seen.set(k, r)
  }
  return [...seen.values()].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
}
