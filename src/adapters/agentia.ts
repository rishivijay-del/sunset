/**
 * Copado (Agentia CLI) adapter. Every call Sunset makes to Copado goes
 * through here, using the command templates from .sunset.json.
 * Covers all three Copado API surfaces: CI/CD, AI, and Robotic Testing.
 */
import { fillTemplate, type SunsetConfig } from '../core/config.js'
import { runJson, run } from '../core/runner.js'
import { pick, resultOf, rowsOf } from '../util/index.js'

export type AgentId = 'plan' | 'build' | 'test' | 'release' | 'operate'

export interface Story {
  id: string // record ID or name, whatever the CLI accepts
  name: string // e.g. US-0000123
  title: string
  status: string
  owner?: string
  description?: string
  raw: any
}

export function normalizeStory(raw: any): Story {
  return {
    id: String(pick(raw, ['Id', 'id', 'recordId', 'workId']) ?? pick(raw, ['Name', 'name']) ?? ''),
    name: String(pick(raw, ['Name', 'name', 'userStoryName', 'reference', 'key']) ?? ''),
    title: String(pick(raw, ['copado__User_Story_Title__c', 'title', 'Title', 'subject', 'summary']) ?? ''),
    status: String(pick(raw, ['copado__Status__c', 'status', 'Status', 'state']) ?? ''),
    owner: pick(raw, ['ownerName', 'Owner.Name', 'owner', 'assignee', 'developer']),
    description: pick(raw, ['copado__Functional_Specifications__c', 'description', 'Description']),
    raw,
  }
}

export class Agentia {
  constructor(private readonly cfg: SunsetConfig, private readonly bin = 'agentia') {}

  private cmd(key: string, values: Record<string, string | number | undefined> = {}, opts: { input?: string; allowFail?: boolean; timeoutMs?: number } = {}) {
    const template = this.cfg.commands[key]
    if (!template) throw new Error(`No command template "${key}" in config`)
    const args = fillTemplate(template, { pipelineId: this.cfg.pipelineId, ...values })
    // Retry transient Copado gateway errors (HTTP 5xx) a few times before giving up.
    for (let attempt = 1; ; attempt++) {
      try {
        return runJson(this.bin, args, { cwd: (this.cfg as any).root, ...opts })
      } catch (err) {
        const msg = (err as Error).message
        if (attempt >= 3 || !/Gateway request failed \(5\d\d\)|statusCode"?\s*:\s*5\d\d|ECONNRESET|ETIMEDOUT/i.test(msg)) throw err
        const waitMs = attempt * 15_000
        process.stderr.write(`Copado returned a temporary error; retrying in ${waitMs / 1000}s (attempt ${attempt + 1}/3)\n`)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs)
      }
    }
  }

  // ---------- setup ----------
  auth(): any {
    return this.cmd('authGet', {}, { allowFail: true }).data
  }

  // ---------- CI/CD ----------
  listStories(): Story[] {
    return rowsOf(this.cmd('workList').data).map(normalizeStory)
  }

  /** Resolve a story name (US-0000123) to its record ID; record IDs pass through. */
  resolveStoryId(story: string): string {
    if (!/^US-\d+/i.test(story)) return story
    const rows = rowsOf(this.cmd('workFindByName', { story }).data).map(normalizeStory)
    const hit = rows.find((r) => r.name.toLowerCase() === story.toLowerCase()) ?? rows[0]
    if (!hit?.id || /^US-/i.test(hit.id)) throw new Error(`Could not find user story ${story} in Copado`)
    return hit.id
  }

  getStory(story: string): Story {
    return normalizeStory(resultOf(this.cmd('workGet', { story: this.resolveStoryId(story) }).data))
  }

  createStory(title: string, description: string): Story {
    const src = this.cfg.environments[0]
    const data = resultOf(this.cmd('workCreate', { title, description, credentialId: src?.credentialId, orgId: src?.orgId, copadoProjectId: (this.cfg as any).copadoProjectId }).data)
    const s = normalizeStory(Array.isArray(data) ? data[0] : data)
    if (!s.title) s.title = title
    return s
  }

  updateStoryStatus(story: string, status: string) {
    return this.cmd('workUpdate', { story, status }, { allowFail: true }).data
  }

  dependencies(type: string, name: string, env: { credentialId?: string; orgId?: string }): any[] {
    const { data } = this.cmd('dependencyList', { type, name, credentialId: env.credentialId, orgId: env.orgId })
    return rowsOf(data)
  }

  metadataContent(type: string, name: string): string {
    const { data } = this.cmd('metadataContentGet', { type, name })
    const r = resultOf(data)
    return String(pick(r, ['content', 'body', 'source', 'xml']) ?? JSON.stringify(r))
  }

  /** Copado cloud commit: retrieves the components from the story's source org into its feature branch. */
  commit(story: string, message: string, changes: { type: string; name: string; action: 'add' | 'delete' }[]) {
    const body = JSON.stringify({
      message,
      changes: changes.map((ch) => ({ a: ch.action === 'delete' ? 'Delete' : 'Add', c: 'SFDX', n: ch.name, t: ch.type })),
    })
    return this.cmd('commitCreate', { story: this.resolveStoryId(story), message }, { input: body, timeoutMs: 45 * 60_000 }).data
  }

  /** Promote the story to its next environment (used only if submit is unavailable). */
  promoteStory(story: string): any {
    return resultOf(this.cmd('workPromote', { story: this.resolveStoryId(story) }, { timeoutMs: 90 * 60_000 }).data)
  }

  /** Make the story the active work item (checks out feature/<story> locally). */
  setActiveStory(story: string) {
    return this.cmd('workSet', { story }, { timeoutMs: 10 * 60_000 }).data
  }

  /** Copado UI "Submit" (promote): creates the next promotion, merges and deploys. Returns immediately. */
  submitDone() {
    return this.cmd('workSubmitDone', {}, { timeoutMs: 20 * 60_000 }).data
  }

  /** The story's promotions, newest first, normalised. */
  storyPromotions(story: string): { id: string; name: string; status: string; from: string; to: string; promotionStatus: string; deployStatus: string }[] {
    return rowsOf(this.cmd('promotionList', { story: this.resolveStoryId(story) }).data)
      .map((p: any) => ({
        id: String(pick(p, ['id', 'Id']) ?? ''),
        name: String(pick(p, ['name', 'Name']) ?? ''),
        status: String(pick(p, ['status', 'Status']) ?? ''),
        from: String(pick(p, ['sourceEnvironmentName']) ?? ''),
        to: String(pick(p, ['destinationEnvironmentName']) ?? ''),
        promotionStatus: String(pick(p, ['lastPromotionExecutionStatus']) ?? ''),
        deployStatus: String(pick(p, ['lastDeploymentExecutionStatus']) ?? ''),
      }))
      .sort((x, y) => y.name.localeCompare(x.name))
  }

  promotions(story: string): any[] {
    return rowsOf(this.cmd('promotionList', { story }).data)
  }

  runPromotion(promotionId: string): any {
    return resultOf(this.cmd('promotionRun', { promotionId }, { timeoutMs: 60 * 60_000 }).data)
  }

  // ---------- AI (Plan, Build, Test, Release, Operate) ----------
  ask(agent: AgentId, prompt: string, timeoutMs = 5 * 60_000): string {
    const { data } = this.cmd('aiAsk', { agent, prompt }, { timeoutMs })
    const r = resultOf(data)
    if (typeof r === 'string') return r
    return String(pick(r, ['answer', 'response', 'message', 'text', 'content', 'output']) ?? JSON.stringify(r))
  }

  /** Ask an agent for JSON and parse it; returns undefined if the agent didn't comply. */
  askJson<T>(agent: AgentId, prompt: string): T | undefined {
    const text = this.ask(agent, `${prompt}\n\nRespond with ONLY valid JSON, no prose, no markdown fences.`)
    const cleaned = text.replace(/```(?:json)?/g, '').trim()
    const start = cleaned.search(/[{[]/)
    if (start < 0) return undefined
    try {
      return JSON.parse(cleaned.slice(start)) as T
    } catch {
      return undefined
    }
  }

  // ---------- Robotic Testing ----------
  /** Run the CRT smoke job and wait for its result in one call. */
  runTests(): { buildId: string; passed?: boolean; status: string; raw: any } {
    const { data } = this.cmd('testingRun', { projectId: this.cfg.crt.projectId, jobId: this.cfg.crt.jobId }, { timeoutMs: 40 * 60_000 })
    const r = resultOf(data)
    const status = String(pick(r, ['result', 'status', 'state', 'testResult', 'buildStatus']) ?? 'unknown')
    const s = status.toLowerCase()
    const passed = /pass|success|succeeded|finished/.test(s) ? true : /fail|error|abort/.test(s) ? false : undefined
    return { buildId: String(pick(r, ['buildId', 'id', 'runId', 'executionId', 'build']) ?? ''), passed, status, raw: r }
  }

  testStatus(buildId: string): { status: string; passed?: boolean; raw: any } {
    const { data } = this.cmd('testingGet', { buildId, projectId: this.cfg.crt.projectId, jobId: this.cfg.crt.jobId })
    const r = resultOf(data)
    const status = String(pick(r, ['status', 'state', 'result', 'testResult']) ?? 'unknown')
    const s = status.toLowerCase()
    const passed = /pass|success|succeeded/.test(s) ? true : /fail|error/.test(s) ? false : undefined
    return { status, passed, raw: r }
  }

  saveTestLogs(buildId: string, outputDir: string) {
    const args = fillTemplate(this.cfg.commands.testingLogs, { buildId, outputDir, projectId: this.cfg.crt.projectId, jobId: this.cfg.crt.jobId })
    return run(this.bin, args, { allowFail: true })
  }
}
