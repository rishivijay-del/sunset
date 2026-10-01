/**
 * Archaeologist: why does this field exist?
 * Collision Guard: is a teammate's in-flight user story still using it?
 */
import type { Agentia, Story } from '../adapters/agentia.js'
import { Git, storyIdsFrom, type CommitInfo } from '../adapters/git.js'

export interface Origin {
  createdIn?: CommitInfo
  commits: CommitInfo[]
  stories: { name: string; title?: string; status?: string; owner?: string }[]
  summary: string
  aiSummary?: string
}

export function investigateOrigin(git: Git, agentia: Agentia | undefined, fieldFile: string | undefined, fieldName: string, packageDir: string, notes: string[]): Origin {
  const fileCommits = fieldFile ? git.fileHistory(fieldFile) : []
  const refCommits = git.stringHistory(fieldName, packageDir)
  const all = new Map<string, CommitInfo>()
  for (const c of [...fileCommits, ...refCommits]) all.set(c.sha, c)
  const commits = [...all.values()].sort((a, b) => a.date.localeCompare(b.date))
  const createdIn = fileCommits[fileCommits.length - 1] ?? commits[0]

  // Story IDs from commit messages and from the branches that contain the commits (Copado: feature/US-xxxxxxx)
  const texts = commits.map((c) => c.subject)
  for (const c of commits.slice(0, 15)) texts.push(...git.branchesContaining(c.sha))
  const ids = storyIdsFrom(texts)

  const stories: Origin['stories'] = []
  for (const id of ids.slice(0, 10)) {
    if (!agentia) {
      stories.push({ name: id })
      continue
    }
    try {
      const s = agentia.getStory(id)
      stories.push({ name: s.name || id, title: s.title, status: s.status, owner: s.owner })
    } catch {
      stories.push({ name: id })
      notes.push(`Could not load story ${id} from Copado.`)
    }
  }

  const first = stories[0]
  const summary = createdIn
    ? `Created ${createdIn.date} by ${createdIn.author}${first ? ` in ${first.name}${first.title ? ` ("${first.title}")` : ''}` : ''}. ${commits.length} commit(s) touched it or its references.`
    : 'No Git history found for this field (it may have been created directly in an org).'

  let aiSummary: string | undefined
  if (agentia && (commits.length || stories.length)) {
    try {
      aiSummary = agentia.ask(
        'operate',
        `In two short sentences for a Salesforce developer, explain why the field ${fieldName} probably exists and whether the work it supported still looks active. ` +
          `Commits: ${JSON.stringify(commits.slice(-12).map((c) => ({ date: c.date, author: c.author, subject: c.subject })))} ` +
          `Stories: ${JSON.stringify(stories)}`,
      ).trim()
    } catch (err) {
      notes.push(`Operate agent summary unavailable: ${(err as Error).message.split('\n')[0]}`)
    }
  }
  return { createdIn, commits, stories, summary, aiSummary }
}

export interface Collision {
  story: string
  title: string
  owner?: string
  branch: string
  hits: { file: string; line: number; text: string }[]
}

export function inFlightStories(stories: Story[], excluded: string[], ownStoryNames: string[] = []): Story[] {
  const ex = excluded.map((s) => s.toLowerCase())
  return stories.filter((s) => s.name && !ex.includes(s.status.toLowerCase()) && !ownStoryNames.includes(s.name))
}

/**
 * A collision is an in-flight story whose own changes (relative to the base
 * branch) touch a file that references the field. Deploying that story after
 * retirement would bring the reference back or fail.
 */
export function findCollisions(git: Git, stories: Story[], prefix: string, remote: string, baseBranch: string, fieldName: string, packageDir: string): Collision[] {
  git.fetch()
  const base = git.refExists(`${remote}/${baseBranch}`) ? `${remote}/${baseBranch}` : baseBranch
  const out: Collision[] = []
  for (const s of stories) {
    const branch = `${prefix}${s.name}`
    const ref = git.refExists(`${remote}/${branch}`) ? `${remote}/${branch}` : git.refExists(branch) ? branch : undefined
    if (!ref) continue
    const hits = git.changedFiles(base, ref, packageDir).flatMap((file) => git.grepFileAtRef(ref, fieldName, file))
    if (hits.length) out.push({ story: s.name, title: s.title, owner: s.owner, branch: ref, hits })
  }
  return out
}
