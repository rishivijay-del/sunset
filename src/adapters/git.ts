/** Git adapter: history (Archaeologist), branch search (Collision/Guard), commits (git commit mode). */
import { run } from '../core/runner.js'

export interface CommitInfo {
  sha: string
  author: string
  date: string
  subject: string
}

export class Git {
  constructor(private readonly root: string, private readonly remote = 'origin') {}

  private git(args: string[], allowFail = false) {
    return run('git', args, { cwd: this.root, allowFail })
  }

  isRepo(): boolean {
    return this.git(['rev-parse', '--is-inside-work-tree'], true).code === 0
  }

  currentBranch(): string {
    return this.git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
  }

  isClean(): boolean {
    return this.git(['status', '--porcelain'], true).stdout.trim() === ''
  }

  private parseLog(out: string): CommitInfo[] {
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, author, date, ...rest] = line.split('\x1f')
        return { sha, author, date, subject: rest.join('\x1f') }
      })
  }

  /** Commits that touched a file (following renames). */
  fileHistory(path: string): CommitInfo[] {
    const r = this.git(['log', '--all', '--follow', '--format=%H%x1f%an%x1f%ad%x1f%s', '--date=short', '--', path], true)
    return r.code === 0 ? this.parseLog(r.stdout) : []
  }

  /** Commits that added or removed a string anywhere (git pickaxe). */
  stringHistory(needle: string, pathspec: string): CommitInfo[] {
    const r = this.git(['log', '--all', '-i', `-S${needle}`, '--format=%H%x1f%an%x1f%ad%x1f%s', '--date=short', '--', pathspec], true)
    return r.code === 0 ? this.parseLog(r.stdout) : []
  }

  /** Branches (local and remote) containing a commit: reveals feature/US-xxxx names. */
  branchesContaining(sha: string): string[] {
    const r = this.git(['branch', '-a', '--contains', sha, '--format=%(refname:short)'], true)
    return r.code === 0 ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : []
  }

  fetch(branch?: string): boolean {
    const args = branch ? ['fetch', this.remote, branch] : ['fetch', this.remote, '--prune']
    return this.git(args, true).code === 0
  }

  remoteBranches(prefix: string): string[] {
    const r = this.git(['branch', '-r', '--format=%(refname:short)'], true)
    return r.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((b) => b.startsWith(`${this.remote}/${prefix}`))
  }

  refExists(ref: string): boolean {
    return this.git(['rev-parse', '--verify', '--quiet', ref], true).code === 0
  }

  /** Search a branch's content without checking it out. Returns "path:line:text" hits. */
  grepRef(ref: string, needle: string, pathspec: string): { file: string; line: number; text: string }[] {
    const r = this.git(['grep', '-i', '-n', '-w', '-F', needle, ref, '--', pathspec], true)
    if (r.code !== 0) return []
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const withoutRef = l.startsWith(`${ref}:`) ? l.slice(ref.length + 1) : l
        const m = /^(.*?):(\d+):(.*)$/.exec(withoutRef)
        return m ? { file: m[1], line: Number(m[2]), text: m[3].trim() } : { file: withoutRef, line: 0, text: '' }
      })
  }

  /** Files a branch changed relative to a base (three-dot: only the branch's own work). */
  changedFiles(base: string, ref: string, pathspec: string): string[] {
    const r = this.git(['diff', '--name-only', `${base}...${ref}`, '--', pathspec], true)
    return r.code === 0 ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : []
  }

  /** Search one file's content at a ref. */
  grepFileAtRef(ref: string, needle: string, file: string): { file: string; line: number; text: string }[] {
    const r = this.git(['show', `${ref}:${file}`], true)
    if (r.code !== 0) return []
    const re = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    return r.stdout
      .split('\n')
      .map((text, i) => ({ file, line: i + 1, text: text.trim() }))
      .filter((l) => re.test(l.text))
  }

  /** Search staged changes (used by the pre-commit tombstone guard). */
  grepStaged(needle: string): { file: string; line: number; text: string }[] {
    const r = this.git(['grep', '--cached', '-i', '-n', '-w', '-F', needle], true)
    if (r.code !== 0) return []
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const m = /^(.*?):(\d+):(.*)$/.exec(l)
        return m ? { file: m[1], line: Number(m[2]), text: m[3].trim() } : { file: l, line: 0, text: '' }
      })
  }

  /** True if tracked files have uncommitted changes (Agentia `work set` needs them clean). */
  hasTrackedChanges(): boolean {
    return this.git(['diff', '--quiet'], true).code !== 0 || this.git(['diff', '--cached', '--quiet'], true).code !== 0
  }

  stashPush(message: string): boolean {
    return this.git(['stash', 'push', '-m', message], true).code === 0
  }

  stashPop(): boolean {
    return this.git(['stash', 'pop'], true).code === 0
  }

  checkoutNew(branch: string, from: string) {
    this.git(['checkout', '-B', branch, from])
  }

  checkout(branch: string) {
    this.git(['checkout', branch])
  }

  addAll(paths: string[]) {
    if (paths.length) this.git(['add', '-A', '--', ...paths])
  }

  remove(paths: string[]) {
    if (paths.length) this.git(['rm', '-q', '--', ...paths], true)
  }

  commit(message: string): string {
    this.git(['commit', '-q', '-m', message])
    return this.git(['rev-parse', 'HEAD']).stdout.trim()
  }

  push(branch: string) {
    this.git(['push', '-u', this.remote, branch])
  }

  diffForPaths(paths: string[]): string {
    return this.git(['diff', 'HEAD', '--', ...paths], true).stdout
  }
}

export const STORY_ID_RE = /\bUS-\d{4,}\b/g

export function storyIdsFrom(texts: string[]): string[] {
  const found = new Set<string>()
  for (const t of texts) for (const m of t.match(STORY_ID_RE) ?? []) found.add(m)
  return [...found]
}
