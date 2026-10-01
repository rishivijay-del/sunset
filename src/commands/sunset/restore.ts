import { Args, Flags } from '@oclif/core'
import { loadPlan } from '../../core/plan.js'
import { runRestore } from '../../engine/phases.js'
import { color, icon } from '../../util/index.js'
import { SunsetCommand } from '../../util/command.js'

export default class Restore extends SunsetCommand {
  static override description = 'Undo a retirement from its capsule: definition, every removed reference, and the data'
  static override args = { plan: Args.string({ required: true }) }
  static override flags = {
    'data-only': Flags.boolean({ description: 'Only reload data (e.g. after undeleting the field in Setup)', default: false }),
    story: Flags.string({ description: 'Use this existing user story for the restore instead of creating one' }),
    'no-commit': Flags.boolean({ description: 'Restore files locally only', default: false }),
    yes: Flags.boolean({ default: false }),
    confirm: Flags.string({ description: 'Confirmation phrase for production steps' }),
  }

  async run() {
    const { args, flags } = await this.parse(Restore)
    const cfg = this.init0(flags)
    const plan = loadPlan(cfg.stateDir, args.plan)
    this.log(`\n${color.bold(`${icon.sun}  Restoring ${plan.targets.map((t) => t.qualified).join(', ')}`)}\n`)
    await runRestore(this.deps(), plan, { dataOnly: flags['data-only'], storyName: flags.story, noCommit: flags['no-commit'], yes: flags.yes, confirm: flags.confirm })
    this.log(color.green(`\n${icon.ok} Restore finished.`))
  }
}
