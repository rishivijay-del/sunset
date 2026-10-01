# ☀ Sunset: the first safe way to *undeploy* in Salesforce

> Salesforce has a million ways to deploy. Sunset is the first way to undeploy.

AI agents now add Salesforce metadata ten times faster than before. Nothing helps teams **remove** it. Unused
custom fields pile up until an object hits its field limit, page layouts become unreadable and every deploy gets
slower. Deleting a field today means hours of hunting references in Setup, guessing who still uses it, hoping the
data wasn't needed, and fixing broken deployments afterwards.

**Sunset** is a plugin for Copado's **Agentia CLI** that retires metadata (starting with custom fields) safely,
in phases, **through your Copado pipeline**, with a proven backup and one-command restore. It runs on your laptop,
in any terminal, or driven by an AI coding agent via `SKILL.md`. Nothing is installed in Salesforce.

## How it works

```
scan → investigate → plan → detach → quarantine → archive → retire      (+ restore, guard, report)
                              │          │            │         │
                        US: remove   US: hide via   proven    US: delete through
                        references   explicit FLS   backup    the pipeline
                        (AI patches  + watch for    capsule   (Copado destructive
                         approved)    usage                    commit)
```

| Capability | What it does |
|---|---|
| **Scan** | Ranks an object's fields by retirement safety (references × fill rate). |
| **Reference Finder** | Finds every use in Git: Apex, Flows, formulas, validation rules, LWC, Aura, VF, layouts, list views, permission sets, reports… and classifies each as *blocker*, *repo hazard* or *warning*. |
| **Blocker Oracle** | Runs a check-only destructive validation so **Salesforce itself** says what blocks deletion. Changes nothing. |
| **Usage Analyzer** | Fill rate, last write and writer, field history, report last-run dates → **SAFE / CAUTION / BLOCKED**. |
| **Archaeologist** | Git history + Copado user stories + Operate agent explain *why the field exists*. |
| **Collision Guard** | Detects teammates' in-flight user stories that still touch the field. |
| **Detach** | Deterministic XML edits for layouts/list views/etc.; Build agent proposes code patches you approve line by line. |
| **Quarantine** | Deploys explicit "no access" field-level security (the only way that actually revokes access) and watches for writes and report runs. An automated scream test. |
| **Archive** | Exports every value per environment; refuses to continue unless row counts match, checksums are recorded and the definition validates. |
| **Retire** | Deletes through the pipeline with typed confirmation for production; purges obsolete Flow versions; records a tombstone. |
| **Restore** | Brings back the definition, every removed reference and the data from the capsule. |
| **Tombstone Guard** | Blocks branches or commits that bring a retired field back (pre-commit hook included). |
| **Merge / Campaign** | Consolidate duplicate fields; retire many safe fields as one campaign. |

### Copado surfaces used

- **CI/CD**: user stories (list/get/create/update), commits, promotions (`merge_and_deploy`), metadata dependencies, metadata content.
- **AI agents**: Plan (story text), Build (patches), Release (promotion fallback, failure analysis, release notes), Operate (history summary, stakeholder notice).
- **Robotic Testing**: smoke job after every promotion.

### What it replaces in the UI

Setup → "Where is this used?" per field · manual story creation · manual layout/permission edits · manual
destructive-changes packages · spreadsheets of "who uses this" · ad-hoc data exports · rollback by memory.

## Install

Requirements: Node.js 18+ (22 LTS recommended), Git, Salesforce CLI (`sf`), Agentia CLI.

```bash
npm install -g @copado/agentia-cli@beta @salesforce/cli
git clone <this repo> sunset && cd sunset
npm install
npm test          # all tests should pass
npm run build
agentia plugins link .
agentia sunset --help
```

In your Copado pipeline's Salesforce project:

```bash
agentia sunset init     # creates .sunset.json, protects backups from Git, installs the tombstone hook
# edit .sunset.json: pipelineId, environments (aliases, credential IDs, org IDs, branches)
agentia sunset doctor
```

## Quick start

```bash
agentia sunset scan Account --org prod --limit 20
agentia sunset investigate Account.Legacy_Region__c
agentia sunset plan Account.Legacy_Region__c
agentia sunset execute <plan> --phase detach
agentia sunset execute <plan> --phase quarantine
agentia sunset watch <plan>
agentia sunset execute <plan> --phase archive
agentia sunset execute <plan> --phase retire --purge-flow-versions
agentia sunset report <plan> --ai
agentia sunset restore <plan>        # if anyone needs it back
```

Preview any phase without touching an org: add `--no-commit` and inspect `git diff`.

## Configuration

Everything lives in `.sunset.json` (see `.sunset.example.json`). Every external command is a template under
`commands`, so if your Agentia CLI version names a flag differently you override just that template:

```json
"commands": {
  "workCreate": ["cicd", "work", "create", "--title", "{title}", "--pipeline", "{pipelineId}", "--json"]
}
```

`commitMode`: `cli` (deploy to DEV, then Copado commit, the Copado-native flow) · `agent` (ask the Release agent to
commit) · `git` (push the feature branch directly). `deletionPath`: `A` Copado destructive commit · `B` git removal ·
`C` per-environment destructive deploy with confirmations. `usage.ignoreWritesBefore`: ignore edits from a known
bulk load or migration when judging recency.

## Safety model

Phases can only run in order; every gate is enforced in code (`src/core/plan.ts`). Production steps need a typed
phrase (never `--yes`). Retire refuses to start while quarantine signals exist, before the quarantine ends, or
without a proven capsule. Exit code `2` means a safety gate stopped the command. Backups never go to Git.

## Salesforce facts Sunset respects

- Deploying a permission set without a field entry does **not** revoke access; quarantine deploys explicit `false`.
- Obsolete Flow versions block deletion even when the active version is clean; Sunset lists and (with approval) purges them.
- Deleted custom fields stay 15 days and count toward the limit until erased; a same-name field can't be created while the deleted one exists. Restore explains Undelete (keeps data) vs. erase-and-redeploy.

## Project layout

```
src/adapters   agentia.ts (all Copado calls) · salesforce.ts (sf CLI) · git.ts
src/core       config · runner (safe exec, redaction) · referenceFinder · plan (gates)
src/engine     investigator · oracle · usage · orgReferences · history · patcher · xmlEditors
               capsule · release · phases · scanReport
src/commands   sunset/*: scan investigate plan execute watch status restore guard report merge campaign doctor init
demo/          a Salesforce project with a hero field, traps and data for the demo org
test/          unit + integration tests (real temporary Git repo, fake Agentia CLI)
SKILL.md       instructions for AI agents driving Sunset
```

## License

MIT
