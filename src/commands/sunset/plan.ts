import { Args, Flags } from '@oclif/core'
import { Agentia } from '../../adapters/agentia.js'
import { listPlans, loadPlan, log, phase, savePlan, type PhaseName } from '../../core/plan.js'
import { investigate } from '../../engine/investigator.js'
import { createPlan } from '../../engine/phases.js'
import { color, icon } from '../../util/index.js'
import { SunsetCommand } from '../../util/command.js'

export default class PlanCmd extends SunsetCommand {
  static override description = 'Create a phased retirement plan (and its Copado user stories) for one or more fields'
  static override strict = false
  static override examples = [
    '<%= config.bin %> sunset plan Account.Legacy_Region__c',
    '<%= config.bin %> sunset plan Account.Old_A__c Account.Old_B__c   # a cleanup campaign',
    '<%= config.bin %> sunset plan --attach sunset-account-legacy... --phase detach --story US-0000123',
    '<%= config.bin %> sunset plan --list',
  ]
  static override args = { fields: Args.string({ description: 'One or more Object.Field__c' }) }
  static override flags = {
    'merge-into': Flags.string({ description: 'Merge plan: move data and references into this surviving field first' }),
    'no-stories': Flags.boolean({ description: 'Do not create Copado user stories automatically', default: false }),
    offline: Flags.boolean({ description: 'Plan from the repo only (no org checks)', default: false }),
    attach: Flags.string({ description: 'Attach an existing user story to a plan phase (plan id)' }),
    phase: Flags.string({ description: 'Phase for --attach', options: ['migrate', 'detach', 'quarantine', 'archive', 'retire'] }),
    story: Flags.string({ description: 'User story (e.g. US-0000123) for --attach' }),
    list: Flags.boolean({ description: 'List plans', default: false }),
  }

  async run() {
    const { argv, flags } = await this.parse(PlanCmd)
    const cfg = this.init0(flags)

    if (flags.list) {
      for (const p of listPlans(cfg.stateDir)) this.log(`${p.id}  ${p.kind}  ${p.targets.map((t) => t.qualified).join(', ')}  [${p.phases.map((x) => `${x.name}:${x.status}`).join(' ')}]`)
      return
    }
    if (flags.attach) {
      if (!flags.phase || !flags.story) this.error('--attach needs --phase and --story')
      const plan = loadPlan(cfg.stateDir, flags.attach)
      const p = phase(plan, flags.phase as PhaseName)
      p.storyId = flags.story
      p.storyName = flags.story
      log(plan, `Attached ${flags.story} to ${p.name}`)
      savePlan(cfg.stateDir, plan)
      return this.log(`${icon.ok} ${flags.story} attached to ${p.name} of ${plan.id}`)
    }

    const fields = argv as string[]
    if (!fields.length) this.error('Give at least one Object.Field__c')
    if (flags['merge-into'] && fields.length !== 1) this.error('A merge plan takes exactly one field to retire')

    const invs = fields.map((f) => {
      this.log(`${icon.arrow} Investigating ${f}...`)
      return investigate(cfg, f, { offline: flags.offline, skipCollisions: false })
    })
    for (const i of invs) {
      const v = i.verdict.verdict
      this.log(`  ${i.target.qualified}: ${v === 'SAFE' ? color.green(v) : v === 'CAUTION' ? color.yellow(v) : color.red(v)}, ${i.repo.summary.blocker} blocker(s), ${i.repo.summary.repoHazard} hazard(s)`)
      if (i.collisions.length) this.log(color.red(`  ${icon.warn} ${i.collisions.length} in-flight story(ies) reference it: ${i.collisions.map((c) => c.story).join(', ')}`))
    }
    const plan = createPlan(cfg, flags.offline ? undefined : new Agentia(cfg), invs, {
      kind: flags['merge-into'] ? 'merge' : undefined,
      mergeInto: flags['merge-into'],
      createStories: !flags['no-stories'] && !flags.offline,
    })
    this.log(`\n${color.bold(`${icon.sun}  Plan ${plan.id}`)} (${plan.kind})`)
    for (const p of plan.phases) {
      this.log(`  ${color.bold(p.name.padEnd(10))} ${p.storyName ? color.cyan(p.storyName) : color.dim('no story yet')}  ${p.storyTitle}`)
      for (const n of p.notes) this.log(color.yellow(`             ${n}`))
    }
    const first = plan.phases[0].name
    this.log(`\nNext: ${color.cyan(`agentia sunset execute ${plan.id} --phase ${first}`)}`)
  }
}
