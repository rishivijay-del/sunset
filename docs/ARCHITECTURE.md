# Sunset — Safe, Agent-Powered Retirement of Salesforce Metadata
**Agentia™ Headless Virtual Hackathon 2026 — Architecture & Build Plan**

> "Salesforce has a million ways to deploy. Sunset is the first way to *undeploy*."

---

## 1. The problem, in one paragraph

Adding a custom field takes 30 seconds; deleting one safely takes days. Salesforce blocks the delete while anything references it, and the references are spread across Apex, Flows (including old inactive versions), formulas, validation rules, LWC schema imports, and more. Even after the org lets you delete it, the Git repo still has layouts, permission sets and profiles pointing at the field, so the *next* deployment breaks. Then the deletion must travel through every pipeline environment in the right order. Because this is slow and risky, nobody does it, orgs only grow, and teams eventually hit custom field limits and drown in dead metadata. Analysis tools can already *report* unused fields. Nothing *removes* them safely, end to end, through a governed pipeline, with proof and undo.

---

## 2. Feasibility: what is verified, and what has a fallback

Everything below was checked against public sources: published source code of other plugins built on the Agentia CLI (0.122.0-alpha.1), Copado documentation, and Salesforce CLI behavior. Items marked **[verify]** depend on exact flag names in your CLI version; each has a fallback so the project cannot be blocked.

| Capability Sunset needs | Status | How |
|---|---|---|
| Write a plugin for the Agentia CLI | ✅ Verified | oclif plugin, loaded with `agentia plugins link .` |
| Read user stories, create stories | ✅ Verified | `agentia cicd work list / get / create / update --json` |
| Org-side dependency lookup | ✅ Verified | `agentia cicd metadata dependency list --metadata-type …` |
| Read metadata content | ✅ Verified | `agentia cicd metadata content get --api-name … --metadata-type …` |
| Promote through the pipeline | ✅ Verified | `agentia cicd promotion list --work-id …` and `promotion run <id> --operation merge_and_deploy --wait --json` |
| Call all five AI agents | ✅ Verified | `agentia ai agent ask -p "<prompt>" --agent plan\|build\|test\|release\|operate --json` |
| Run CRT smoke tests | ✅ Verified | `agentia testing build run / get / logs`, `agentia testing job list` |
| Destructive changes (deletions) in Copado | ✅ Verified in product | Copado has a native "Destructive Changes" Git operation that removes components from Git and destination environments |
| Destructive commit **through the CLI** | ⚠️ [verify] | Path A: CLI commit with a delete operation. Path B: remove the file in the story's feature branch (`feature/US-xxxxxxx`). Path C: post-destructive manifest per environment via `sf project deploy start --post-destructive-changes`. At least C always works. |
| Committing modified reference files | ⚠️ [verify] flag names | CLI commit command (confirm via `agentia --help`); fallback: push to the story's feature branch |
| Field usage data, Tooling API, data backup | ✅ Standard | Salesforce CLI (`sf data query`, `--use-tooling-api`, `sf data export bulk` / `import bulk`) |
| Ground-truth blocker detection | ✅ Standard | `sf project deploy validate` (check-only) with a post-destructive manifest: Salesforce itself reports every blocker |

**Pipeline requirement:** use a **source format pipeline**. The Release Agent's commit/promote/deploy features only work on source format pipelines, and source format gives Sunset the full metadata tree in Git to scan.

---

## 3. Architecture

```
                 Developer (terminal / Cursor / Claude via SKILL.md)
                                   │
                        agentia sunset <command>
                                   │
 ┌─────────────────────────────── SUNSET PLUGIN (TypeScript, oclif v4) ───────────────────────────────┐
 │                                                                                                     │
 │  1 Context Resolver ── auth get, cicd work list, credential/pipeline defaults (.sunset.json)        │
 │  2 Reference Finder ── repo scan  +  cicd metadata dependency list  +  Tooling API (merged, deduped) │
 │  3 Blocker Oracle   ── check-only deploy with post-destructive manifest → Salesforce's exact errors │
 │  4 Usage Analyzer   ── fill rate, last written, history → verdict: SAFE / CAUTION / BLOCKED         │
 │  5 Archaeologist    ── git history of the field → user stories → why it exists (AI summary)         │
 │  6 Collision Guard  ── scans every in-flight story branch for references to the target              │
 │  7 Planner          ── phased retirement plan + user stories (Plan agent)                            │
 │  8 Change Engine    ── deterministic XML editors + Build-agent patches for code (human-approved)     │
 │  9 Release Driver   ── commit, promote phase by phase, gate phase 2 on phase 1 reaching PROD         │
 │ 10 Verifier         ── CRT smoke run after each phase (Test agent drafts the script)                │
 │ 11 Restore Capsule  ── metadata + reference hunks + data archive → one-command restore               │
 │ 12 Reporter         ── before/after report, release notes (Release agent), change notice (Operate)  │
 └─────────────────────────────────────────────────────────────────────────────────────────────────────┘
        │                     │                        │                           │
   Copado CI/CD           Copado AI               Copado Robotic              Salesforce org(s)
 (stories, commits,   (Plan, Build, Test,        Testing (smoke runs)      (via sf CLI: SOQL, Tooling,
   promotions)         Release, Operate)                                      validate, bulk data)
```

All three Copado API surfaces and all five specialist agents are used, each for a real job. That directly answers the "use of Agentia extensibility" criterion.

### 3.1 Context Resolver
Reads `.sunset.json` (pipeline ID, credential IDs per environment, CRT project/job IDs, repo path) and confirms auth with `agentia auth get --json`. Never guesses IDs: anything missing is listed with the exact command to find it (matches the Copado guardrail "never fabricate IDs").

### 3.2 Reference Finder (three sources, merged)
1. **Repo scan (deterministic, fastest, most complete for Git).** Walks the source format tree and matches the field in every form it appears: `Account.Legacy_Region__c` in Apex/SOQL, `Legacy_Region__c` inside `objects/Account/**`, `<field>Account.Legacy_Region__c</field>` in layouts/permission sets/profiles, `<field>` elements in Flows, formula text, validation rule formulas, list views, compact layouts, record type picklist entries, and LWC schema imports (`@salesforce/schema/Account.Legacy_Region__c`).
2. **`agentia cicd metadata dependency list`** for org-side dependencies (catches things not in Git).
3. **Tooling API `MetadataComponentDependency`** via `sf data query --use-tooling-api` as a cross-check (up to 2,000 rows per query; use Bulk API for larger orgs).

Results are merged into one graph, each reference tagged with source, file, and line.

### 3.3 Blocker Oracle (the "Salesforce tells us" trick)
Rather than guessing which references block deletion, Sunset builds a destructive manifest and runs a **check-only validation** against the target org:

```
sf project deploy validate --manifest empty-package.xml \
   --post-destructive-changes destructiveChangesPost.xml --target-org <env>
```

Salesforce returns the exact list of blockers. Sunset classifies every reference:

| Class | Typical examples | What Sunset does |
|---|---|---|
| **Blocker** (org refuses delete) | Apex, Visualforce, formulas, validation rules, Flow versions (including inactive ones), LWC/Aura schema imports, roll-up summaries, lookup filters, workflow field updates | Must be changed in Phase 1 |
| **Repo hazard** (org allows delete, Git breaks later) | Layouts, permission sets, profiles, list views, compact layouts | Cleaned in Git so future deploys don't fail |
| **Impact warning** | Reports, dashboards, integrations writing the field | Shown with owners; reports are listed for their owners |

Because the oracle is Salesforce itself, the classification is always correct for that org, even for edge cases nobody anticipated. This is the strongest technical-execution point in the design.

### 3.4 Usage Analyzer
- Fill rate: `SELECT COUNT() FROM Account WHERE Legacy_Region__c != null` versus total.
- Recency: newest `LastModifiedDate` among populated records; field history if tracked.
- Non-filterable types (long text, rich text): sampled instead of counted.
- Verdict: **SAFE** (low fill, no recent writes, no blockers outside Git), **CAUTION** (recent writes or integration references), **BLOCKED** (active writes). Sunset refuses BLOCKED fields unless overridden with a typed confirmation.

### 3.5 Archaeologist ("why does this exist?")
Copado creates a feature branch per user story (`feature/US-0000001`) and merges it into environment branches, so Git history maps components back to stories. Sunset runs `git log --follow` on the field's file and on commits that introduced references, extracts story IDs from branch/merge names, pulls each story with `agentia cicd work get`, and asks the Operate agent for a two-sentence history: who created it, when, for what project, and whether that project is still alive.

### 3.6 Collision Guard
Lists in-flight stories (`agentia cicd work list --json`), fetches their feature branches, and scans them with the same Reference Finder. If a teammate's in-flight story references the target, retirement is paused and both owners are told (optionally via Slack webhook). This prevents the classic "I deleted it while you were building on it" failure.

### 3.7 Planner
Produces the only safe order Salesforce allows:

| Phase | Contents | Gate to proceed |
|---|---|---|
| **1 Detach** | Remove or rewrite all blockers; clean repo hazards; delete obsolete Flow versions that reference the field | Phase 1 promoted all the way to PROD, CRT smoke green |
| **2 Archive** | Export `Id` + field value to the capsule (bulk export) | Archive checksum verified |
| **3 Retire** | Destructive change for the field itself | Human approval; CRT smoke green after |

The Plan agent writes each user story's title, description and acceptance criteria. Sunset creates them with `agentia cicd work create` and links them in the capsule.

### 3.8 Change Engine
- **Deterministic editors** (no AI) for XML: layouts, permission sets, profiles, list views, compact layouts, record types. These are exact, safe, and fast.
- **Build-agent patches** for code and complex Flows: the Build agent gets the file, the reference, and the goal ("remove use of Account.Legacy_Region__c without changing other behavior") and returns a patch. Sunset shows the diff and requires the developer's approval. Every patch is then proven by a check-only validation deploy before commit.
- Anything the engine cannot handle safely is listed as a manual task with file and line. Honesty over magic.

### 3.9 Release Driver
Commits Phase changes to the story, finds its promotion (`promotion list --work-id`), and runs it (`promotion run <id> --operation merge_and_deploy --wait --json`) environment by environment. Phase 3 is never started until Phase 1 is in PROD. Every PROD step pauses for explicit human confirmation.

Deletion path (auto-selected on first run, see section 2): **A** CLI destructive commit → **B** feature-branch file deletion → **C** post-destructive manifest per environment.

### 3.10 Verifier
After each phase, triggers the configured CRT job (`agentia testing build run`, poll `build get`, collect `build logs`). The Test agent can draft a smoke script covering the pages and flows that used the field. A failed smoke run stops the retirement and offers restore.

### 3.11 Restore Capsule
Stored in `.sunset/capsules/<field>-<timestamp>/`:
- `field.xml` (original definition), `references.patch` (every removed reference, as Git commits),
- `data.csv` (Id + value, via bulk export), `plan.json` (stories, promotions, results), checksums.

`agentia sunset restore <capsule>` creates a restore story that re-adds the field and references, promotes it, then reloads the data with bulk import (upsert on Id). Note: Salesforce keeps deleted custom fields for 15 days and they still count against the object's field limit until permanently erased. Sunset's report says so, and offers the erase step once the team is confident.

### 3.12 Reporter
Before/after summary (fields retired, references removed, field-limit headroom, estimated hours saved), release notes from the Release agent, and a stakeholder change notice from the Operate agent (for report owners and admins).

### 3.13 New features (added after review)

**Quarantine: an automated, safe "scream test" (core).** Experienced admins often hide a field for a few weeks before deleting it, to see whether anyone complains. Sunset automates that. After Phase 1, the field is *hidden but not deleted*: removed from layouts and from field-level access for normal users, while the data stays intact. During a quiet period (configurable, for example 14 days), `agentia sunset watch <plan>` checks for signs that someone still needs it: new values written to the field, affected reports that were run (`Report.LastRunDate`), and errors mentioning the field. Any signal pauses the retirement and names the likely owner. If the quiet period passes cleanly, Phase 3 is allowed. For the demo, the quiet period is set to zero and a signal is simulated.

**Proven backup, not just a backup (core).** Sunset refuses to delete until the backup is proven usable: the exported row count must equal a live `COUNT()` of populated records, the file checksum is recorded, and a check-only validation proves the field definition in the capsule can be redeployed. The report shows "Backup verified: 1,284 of 1,284 values, restorable."

**Report usage check (core, cheap).** Instead of just listing affected reports, Sunset queries each one's `LastRunDate`. "2 reports use this field; neither has been run since 2022" is far more convincing than a bare list.

**Tombstone guard (core, cheap).** After a retirement, the field is recorded in `.sunset/tombstones.json`. `agentia sunset guard --story <id>` checks a story's feature branch and blocks it if it tries to reintroduce a retired field by accident (for example, from an old branch). This keeps cleaned-up orgs clean.

**Consolidate duplicates (stretch).** Many orgs have near-duplicate fields such as `Region__c` and `Region_New__c`. `agentia sunset merge <from> <into>` copies the data into the surviving field, repoints every reference, and then retires the old one using the same safe phases.

**Cleanup campaigns (stretch).** Retire several fields as one campaign, with one set of phased stories and one combined report, for example "Account cleanup: 18 fields retired, 18 slots reclaimed."

Updated phase order: **1 Detach → 2 Quarantine → 3 Archive (proven) → 4 Retire.**

---

## 4. Command design

```
agentia sunset scan <Object> [--json]                 # rank dead-weight candidates on an object
agentia sunset investigate <Object.Field__c> [--json] # references, blockers, usage, history, collisions
agentia sunset plan <Object.Field__c>                 # phased plan + Copado user stories
agentia sunset execute <plan-id> --phase 1|2|3|4      # detach, quarantine, archive, retire (human gates)
agentia sunset watch <plan-id>                        # quarantine signals: new writes, report runs, errors
agentia sunset guard --story <id>                     # block stories that reintroduce a retired field
agentia sunset status <plan-id>                       # where every phase is in the pipeline
agentia sunset restore <capsule-id>                   # bring it all back, data included
```

Every command supports `--json`, POSIX exit codes (0 success, 1 error, 2 blocked by safety gate), and never prints tokens.

**SKILL.md** at the repo root teaches any AI agent the playbooks ("clean up Account", "why does this field exist?", "undo the last retirement") with guardrails: never run Phase 3 or any PROD step without human confirmation, never override a BLOCKED verdict, never fabricate IDs.

---

## 5. Demo org design (build this deliberately)

Seed a dev org and source format pipeline (DEV → UAT → PROD, from the Copado playground) with:

- **`Account.Legacy_Region__c`** (the hero): used by an Apex class and its test, one active Flow plus two inactive Flow versions, a validation rule, a formula field, an LWC with a schema import, 3 layouts, 4 permission sets, 2 reports. Only 0.3% of records populated, last written two years ago. Created in a story titled like a cancelled 2021 territory project.
- **`Account.Sync_Status__c`** (the trap): looks dead in layouts, but an integration user wrote to it yesterday. Sunset must return **BLOCKED**. This shows judgment, not blind deletion.
- **An in-flight story** by a "teammate" that references the hero field, so Collision Guard fires, then is resolved in the demo.
- **15–20 truly dead fields** on Account so `scan` looks realistic.

---

## 6. Demo script (≤ 5 minutes)

1. **The pain (30s):** Setup → Delete field → Salesforce's "referenced by…" error. Everyone recognizes it.
2. **Scan (30s):** `agentia sunset scan Account` → "63 dead-weight fields, 412/500 used."
3. **Investigate (60s):** references graph, blocker oracle results, usage 0.3%, history ("created for a cancelled 2021 project"), collision warning with a teammate's story.
4. **The trap (20s):** `investigate Account.Sync_Status__c` → BLOCKED, integration wrote yesterday.
5. **Execute (90s):** Phase 1 changes shown as diffs (XML automatic, Apex patch from Build agent approved), stories created, promotions run DEV → UAT → PROD, CRT smoke green. Phase 3 deletes the field after human confirmation.
6. **Undo (30s):** `agentia sunset restore` → field and data back.
7. **Close (20s):** before/after numbers. "Orgs only grew. Now they can shrink."

Record everything headless: no Copado UI in the demo flow.

---

## 7. Build plan (today is Sep 30; registration closes Oct 12)

The submission deadline is not shown on the landing page, so the plan reaches a complete, submittable entry by **Oct 12** and uses any extra time for polish.

| Day | Date | Deliverable |
|---|---|---|
| 0 | Sep 30 | Register. Sign up for Copado CI/CD Playground (source format pipeline) and Copado AI freemium. Request CRT trial. |
| 1 | Oct 1 | Install CLI (`npm install -g @copado/agentia-cli@beta`), `agentia setup`, record `agentia --help` for every namespace. Scaffold oclif plugin, `plugins link`. Decide deletion path A/B/C. |
| 2 | Oct 2 | Seed demo org and repo (section 5). Context Resolver + `.sunset.json`. |
| 3 | Oct 3 | Reference Finder (repo scan + dependency list + Tooling cross-check). |
| 4 | Oct 4 | Blocker Oracle + Usage Analyzer → `investigate` works end to end. |
| 5 | Oct 5 | Archaeologist + Collision Guard. |
| 6 | Oct 6 | Planner + story creation. Restore Capsule (archive side). |
| 7 | Oct 7 | Change Engine: deterministic XML editors. **MVP checkpoint: investigate + plan + Phase 1 XML work.** |
| 8 | Oct 8 | Build-agent patches for Apex/Flow with approval and validation. |
| 9 | Oct 9 | Release Driver: commit, promote, phase gating, deletion path. |
| 10 | Oct 10 | Verifier (CRT) + restore command + proven-backup gate. Quarantine + `watch`. `scan` command. |
| 11 | Oct 11 | Reporter (with report `LastRunDate`), tombstone guard, SKILL.md, README, architecture diagram, full dry run. |
| 12 | Oct 12 | Record demo video, slide deck, submit. |

**Rule to follow:** write all code within the hackathon window (it opened Sep 28), keep commit history clean and daily, MIT license, no secrets in the repo.

---

## 8. Risks and fallbacks

| Risk | Likelihood | Fallback |
|---|---|---|
| CLI has no destructive commit | Medium | Path B (feature-branch deletion) or Path C (post-destructive manifest per environment). The demo still shows full automation. |
| CLI commit flags differ from expectations | Medium | Push changes to the story's feature branch; promotion commands are verified. |
| Build agent's Apex patch is wrong | Medium | Every patch is diffed, human-approved, and proven by check-only validation before commit. Demo Apex is kept simple. |
| Dependency API misses a type | Low | Repo scan + Blocker Oracle cover it; the oracle is Salesforce itself. |
| Playground/CRT setup delays | Medium | Start today. CRT is optional: without it, the Verifier runs Apex tests in the validation deploy. |
| Scope creep | High | Custom fields only. Classes, Flows and objects go on the roadmap slide. |

---

## 9. Submission package

**Title:** Sunset: Safe, Agent-Powered Retirement of Salesforce Metadata

**Abstract (≈100 words):** Salesforce orgs only grow, because deleting metadata is slow, risky, and manual. Sunset is an Agentia CLI plugin that retires unused metadata end to end. It finds every reference, asks Salesforce itself which ones block deletion, checks real production usage, explains why the component exists from Copado story history, and protects in-flight work. It then plans the only safe phased order, makes the changes, creates Copado user stories, promotes each phase through the pipeline with CRT verification, and keeps a restore capsule so any retirement can be undone with one command, data included. Days of risky work become minutes.

**README outline:** problem → 20-second GIF → install → quick start → commands → architecture diagram → how the Blocker Oracle works → safety model and guardrails → which Copado API surfaces are used and which UI interactions are eliminated → roadmap → license.

**Slides (8):** 1 Problem · 2 Why nobody deletes · 3 Sunset in one sentence · 4 Live flow · 5 Architecture · 6 Safety model (oracle, verdicts, collisions, capsule) · 7 Impact numbers · 8 Roadmap (Apex classes, Flows, objects, org-wide cleanup campaigns).

**UI interactions eliminated:** Setup "Where is this used?" investigation, manual reference removal across Setup screens, Copado commit grid destructive commits, manual promotion creation per environment, manual data backup before deletion.
