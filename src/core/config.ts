/**
 * Sunset configuration (.sunset.json in the project root).
 *
 * Every external command Sunset runs is a template here, so if your Agentia
 * CLI version uses different flag names you fix it in .sunset.json, not in code.
 * Placeholders like {story} are filled in at run time.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface EnvironmentConfig {
  name: string // e.g. DEV, UAT, PROD (as named in your Copado pipeline)
  sfAlias: string // Salesforce CLI alias for this org (sf org login web --alias ...)
  credentialId?: string // Copado credential ID for this environment
  orgId?: string // Salesforce org ID (00D...)
  branch?: string // Git branch Copado uses for this environment (e.g. dev, uat, main)
  isProduction?: boolean
}

export type CommitMode = 'cli' | 'agent' | 'git'
export type DeletionPath = 'auto' | 'A' | 'B' | 'C'

export interface SunsetConfig {
  repo: string
  packageDir: string
  pipelineId: string
  copadoProjectId?: string // Copado Project record ID, if `cicd work create` needs it ({copadoProjectId})
  apiVersion: string
  environments: EnvironmentConfig[]
  crt: { projectId: string; jobId: string; enabled: boolean }
  commitMode: CommitMode
  deletionPath: DeletionPath
  featureBranchPrefix: string
  gitRemote: string
  quarantineDays: number
  usage: { recentDays: number; cautionFillRatePct: number; staleDays: number; ignoreWritesBefore?: string }
  fieldLimit: number
  testLevelNonProd: string
  testLevelProd: string
  slackWebhookEnvVar: string
  inFlightExcludedStatuses: string[]
  commands: Record<string, string[]>
}

/** Default command templates. [verify] ones: confirm with `agentia <topic> --help`. */
export const DEFAULT_COMMANDS: Record<string, string[]> = {
  // All verified against the agentia CLI's own command manifest (beta, Oct 2026).
  // {?key} = optional: if the value is empty, the flag before it is dropped too.
  authGet: ['auth', 'get', '--json'],
  workList: ['cicd', 'work', 'list', '--page-size', '200', '--json'],
  workFindByName: ['cicd', 'work', 'list', '--name', '{story}', '--json'],
  workGet: ['cicd', 'work', 'get', '{story}', '--json'], // takes the record ID (a0...)
  workCreate: ['cicd', 'work', 'create', '--title', '{title}', '--functional-requirements', '{description}', '--project', '{?copadoProjectId}', '--source-credential', '{?credentialId}', '--json'],
  workUpdate: ['cicd', 'work', 'update', '{story}', '--status', '{status}', '--json'],
  // Body on stdin: {"message": "...", "changes": [{"a": "Add|Delete", "c": "SFDX", "n": "<name>", "t": "<type>"}]}
  commitCreate: ['cicd', 'work', 'commit', '{story}', '--cloud', '--stdin', '--wait', '--json'],
  // Promotes the story to the next environment and deploys
  workPromote: ['cicd', 'work', 'promote', '{story}', '--cloud', '--deploy', '--wait', '--json'],
  promotionList: ['cicd', 'promotion', 'list', '--work-id', '{story}', '--json'],
  promotionRun: ['cicd', 'promotion', 'run', '{promotionId}', '--operation', 'merge_and_deploy', '--wait', '--json'],
  dependencyList: [
    'cicd', 'metadata', 'dependency', 'list', '--metadata-type', '{type}', '--metadata-name', '{name}',
    '--source-credential-id', '{credentialId}', '--source-org-id', '{orgId}', '--pipeline-id', '{pipelineId}', '--json',
  ],
  metadataContentGet: ['cicd', 'metadata', 'content', 'get', '--api-name', '{name}', '--metadata-type', '{type}', '--pipeline-id', '{pipelineId}', '--json'],
  aiAsk: ['ai', 'agent', 'ask', '-p', '{prompt}', '--agent', '{agent}', '--json'],
  deploymentStepList: ['cicd', 'work', 'deployment-step', 'list', '--user-story', '{story}', '--json'],
  testingJobList: ['testing', 'job', 'list', '-p', '{projectId}', '--json'],
  // Waits for the CRT result in one call
  testingRun: ['testing', 'job', 'run', '{jobId}', '-p', '{projectId}', '--wait-for-result', '--timeout', '30', '--no-exit-code', '--json'],
  testingGet: ['testing', 'build', 'get', '{buildId}', '-p', '{projectId}', '-j', '{jobId}', '--json'],
  testingLogs: ['testing', 'build', 'logs', '{buildId}', '-p', '{projectId}', '-j', '{jobId}', '-o', '{outputDir}'],
}

const DEFAULTS: SunsetConfig = {
  repo: '.',
  packageDir: 'force-app',
  pipelineId: '',
  apiVersion: '62.0',
  environments: [
    { name: 'DEV', sfAlias: 'sunset-dev', branch: 'dev' },
    { name: 'UAT', sfAlias: 'sunset-uat', branch: 'uat' },
    { name: 'PROD', sfAlias: 'sunset-prod', branch: 'main', isProduction: true },
  ],
  crt: { projectId: '', jobId: '', enabled: false },
  commitMode: 'cli',
  deletionPath: 'auto',
  featureBranchPrefix: 'feature/',
  gitRemote: 'origin',
  quarantineDays: 14,
  usage: { recentDays: 30, cautionFillRatePct: 5, staleDays: 365 },
  fieldLimit: 500,
  testLevelNonProd: '', // empty = let Salesforce choose (required for Developer Edition / production orgs)
  testLevelProd: '',
  slackWebhookEnvVar: 'SUNSET_SLACK_WEBHOOK',
  inFlightExcludedStatuses: ['Completed', 'Cancelled', 'Canceled', 'Done', 'Closed', 'Rejected'],
  commands: {},
}

export interface LoadedConfig extends SunsetConfig {
  root: string // absolute project root
  stateDir: string // absolute .sunset directory
  configPath?: string
}

export function loadConfig(cwd = process.cwd(), explicitPath?: string): LoadedConfig {
  const path = explicitPath ? resolve(explicitPath) : join(resolve(cwd), '.sunset.json')
  let user: Partial<SunsetConfig> = {}
  if (existsSync(path)) {
    try {
      user = JSON.parse(readFileSync(path, 'utf8'))
    } catch (err) {
      throw new Error(`Could not parse ${path}: ${(err as Error).message}`)
    }
  }
  const merged: SunsetConfig = {
    ...DEFAULTS,
    ...user,
    crt: { ...DEFAULTS.crt, ...(user.crt ?? {}) },
    usage: { ...DEFAULTS.usage, ...(user.usage ?? {}) },
    commands: { ...DEFAULT_COMMANDS, ...(user.commands ?? {}) },
    environments: user.environments?.length ? user.environments : DEFAULTS.environments,
  }
  const root = resolve(existsSync(path) ? join(path, '..') : cwd, merged.repo)
  return { ...merged, root, stateDir: join(root, '.sunset'), configPath: existsSync(path) ? path : undefined }
}

export function envByName(cfg: SunsetConfig, name: string): EnvironmentConfig {
  const env = cfg.environments.find((e) => e.name.toLowerCase() === name.toLowerCase())
  if (!env) throw new Error(`Environment "${name}" is not in .sunset.json (known: ${cfg.environments.map((e) => e.name).join(', ')})`)
  return env
}

export const sourceEnv = (cfg: SunsetConfig) => cfg.environments[0]
export const prodEnv = (cfg: SunsetConfig) => cfg.environments.find((e) => e.isProduction) ?? cfg.environments[cfg.environments.length - 1]

/** Fill {placeholders} in a command template. Missing values fail loudly (never guess IDs). */
export function fillTemplate(template: string[], values: Record<string, string | number | undefined>): string[] {
  const out: string[] = []
  for (const part of template) {
    const opt = /^\{\?(\w+)\}$/.exec(part)
    if (opt) {
      const v = values[opt[1]]
      if (v === undefined || v === '') {
        if (out.length && out[out.length - 1].startsWith('-')) out.pop() // drop the flag too
      } else out.push(String(v))
      continue
    }
    out.push(
      part.replace(/\{(\w+)\}/g, (_, key: string) => {
        const v = values[key]
        if (v === undefined || v === '') throw new Error(`Missing value for {${key}} in command: ${template.join(' ')}`)
        return String(v)
      }),
    )
  }
  return out
}
