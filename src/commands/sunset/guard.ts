import { Flags } from '@oclif/core'
import { Git } from '../../adapters/git.js'
import { loadTombstones } from '../../engine/capsule.js'
import { color, icon } from '../../util/index.js'
import { SunsetCommand } from '../../util/command.js'

export default class Guard extends SunsetCommand {
  static override description = 'Tombstone guard: block changes that bring a retired field back'
  static override examples = [
    '<%= config.bin %> sunset guard --story US-0000456   # check a story feature branch',
    '<%= config.bin %> sunset guard --staged             # use as a git pre-commit hook',
  ]
  static override flags = {
    story: Flags.string({ description: 'User story whose feature branch to check' }),
    ref: Flags.string({ description: 'Any git ref to check' }),
    staged: Flags.boolean({ description: 'Check staged changes (pre-commit hook)', default: false }),
  }

  async run() {
    const { flags } = await this.parse(Guard)
    const cfg = this.init0(flags)
    const tombstones = loadTombstones(cfg.stateDir)
    if (!tombstones.length) return this.log('No retired fields recorded yet.')
    const git = new Git(cfg.root, cfg.gitRemote)
    let ref = flags.ref
    if (flags.story) {
      git.fetch()
      const b = `${cfg.featureBranchPrefix}${flags.story}`
      ref = git.refExists(`${cfg.gitRemote}/${b}`) ? `${cfg.gitRemote}/${b}` : b
    }
    if (!ref && !flags.staged) this.error('Use --story, --ref or --staged')
    const base = cfg.environments[0].branch ?? 'main'
    const baseRef = git.refExists(`${cfg.gitRemote}/${base}`) ? `${cfg.gitRemote}/${base}` : base
    let violations = 0
    for (const t of tombstones) {
      const hits = flags.staged
        ? git.grepStaged(t.field)
        : git.changedFiles(baseRef, ref!, cfg.packageDir).flatMap((f) => git.grepFileAtRef(ref!, t.field, f))
      if (hits.length) {
        violations += hits.length
        this.log(color.red(`${icon.stop} ${t.qualified} was retired on ${t.retiredAt.slice(0, 10)} (plan ${t.planId}) but appears again:`))
        for (const h of hits.slice(0, 10)) this.log(`    ${h.file}:${h.line}  ${h.text.slice(0, 100)}`)
      }
    }
    if (violations) {
      this.log(`\nIf this is intentional, restore it properly: ${color.cyan('agentia sunset restore <plan>')}`)
      this.exit(2)
    }
    this.log(color.green(`${icon.ok} No retired fields reintroduced (${tombstones.length} tombstone(s) checked).`))
  }
}
