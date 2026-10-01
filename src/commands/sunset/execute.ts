import { Args, Flags } from '@oclif/core'
import { loadPlan, type PhaseName } from '../../core/plan.js'
import { runArchive, runDetach, runMigrate, runQuarantine, runRetire } from '../../engine/phases.js'
import { color, icon } from '../../util/index.js'
import { SunsetCommand } from '../../util/command.js'

export default class Execute extends SunsetCommand {
  static override description = 'Run one phase of a plan: migrate, detach, quarantine, archive, or retire (with human gates)'
  static override examples = [
    '<%= config.bin %> sunset execute <plan> --phase detach',
    '<%= config.bin %> sunset execute <plan> --phase detach --no-commit     # local changes only, review with git diff',
    '<%= config.bin %> sunset execute <plan> --phase retire --purge-flow-versions',
  ]
  static override args = { plan: Args.string({ description: 'Plan id (or unique part of it)', required: true }) }
  static override flags = {
    phase: Flags.string({ required: true, options: ['migrate', 'detach', 'quarantine', 'archive', 'retire'] }),
    yes: Flags.boolean({ description: 'Approve NON-production prompts non-interactively (never applies to production)', default: false }),
    confirm: Flags.string({ description: 'Exact confirmation phrase for production or deletion steps (for non-interactive runs)' }),
    'until-env': Flags.string({ description: 'Stop after promoting to this environment' }),
    'no-commit': Flags.boolean({ description: 'Make local changes only; no deploy, commit or promotion', default: false }),
    'override-quarantine': Flags.boolean({ description: 'Retire before the quarantine period ends (typed confirmation required)', default: false }),
    'purge-flow-versions': Flags.boolean({ description: 'Delete obsolete (inactive) Flow versions that still reference the field', default: false }),
    envs: Flags.string({ description: 'Archive only: comma-separated environments to back up (default: all)' }),
  }

  async run() {
    const { args, flags } = await this.parse(Execute)
    const cfg = this.init0(flags)
    const d = this.deps()
    const plan = loadPlan(cfg.stateDir, args.plan)
    const opts = {
      yes: flags.yes,
      confirm: flags.confirm,
      untilEnv: flags['until-env'],
      noCommit: flags['no-commit'],
      overrideQuarantine: flags['override-quarantine'],
    }
    this.log(`\n${color.bold(`${icon.sun}  ${plan.id}`)} ${icon.arrow} ${flags.phase}\n`)
    switch (flags.phase as PhaseName) {
      case 'migrate':
        await runMigrate(d, plan, opts)
        break
      case 'detach':
        await runDetach(d, plan, opts)
        break
      case 'quarantine':
        await runQuarantine(d, plan, opts)
        break
      case 'archive':
        await runArchive(d, plan, { ...opts, envs: flags.envs?.split(',').map((s) => s.trim()) })
        break
      case 'retire':
        await runRetire(d, plan, { ...opts, purgeFlowVersions: flags['purge-flow-versions'] })
        break
    }
    this.log(`\nStatus: ${color.cyan(`agentia sunset status ${plan.id}`)}`)
  }
}
