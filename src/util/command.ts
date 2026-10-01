import { Command, Flags } from '@oclif/core'
import { Agentia } from '../adapters/agentia.js'
import { Git } from '../adapters/git.js'
import { Salesforce } from '../adapters/salesforce.js'
import { loadConfig, type LoadedConfig } from '../core/config.js'
import { setVerbose } from '../core/runner.js'
import type { ReleaseDeps } from '../engine/release.js'
import { ApprovalError, color, icon } from './index.js'

export abstract class SunsetCommand extends Command {
  static baseFlags = {
    config: Flags.string({ description: 'Path to .sunset.json (default: ./.sunset.json)' }),
    verbose: Flags.boolean({ description: 'Print every external command Sunset runs', default: false }),
  }

  protected cfg!: LoadedConfig

  protected init0(flags: { config?: string; verbose?: boolean }) {
    setVerbose(Boolean(flags.verbose))
    this.cfg = loadConfig(process.cwd(), flags.config)
    return this.cfg
  }

  protected deps(): ReleaseDeps {
    return { cfg: this.cfg, agentia: new Agentia(this.cfg), sf: new Salesforce(), git: new Git(this.cfg.root, this.cfg.gitRemote) }
  }

  protected async catch(err: Error & { exitCode?: number }): Promise<any> {
    if (err instanceof ApprovalError) {
      this.logToStderr(color.yellow(`${icon.stop} ${err.message}`))
      this.exit(2) // 2 = stopped by a safety gate (agents and CI can branch on this)
    }
    return super.catch(err)
  }
}
