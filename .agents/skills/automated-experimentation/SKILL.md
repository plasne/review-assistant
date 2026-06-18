---
name: automated-experimentation
description: Create and operate a local automated experimentation loop using GitHub Copilot CLI workers and Experiment Catalog. Use when setting up repeatable agent/evaluation experiments, generating GOAL/BACKLOG/RESULTS files, installing a reusable experiment-loop.py supervisor, running one-experiment-per-branch loops, or analyzing when a goal has been met.
---

# Automated Experimentation

Use this skill to create a repeatable local experimentation loop. The loop runs
on the user's machine, creates one local branch per experiment, launches a fresh
GitHub Copilot CLI worker for exactly one experiment, records results in
Experiment Catalog and `RESULTS.md`, commits the experiment branch locally, then
continues until the user-defined goal is met or the failure policy stops it.

## Simple Operating Model

1. Interview the user and inspect the repository.
2. Create or update a gitignored experiment workspace, usually `experiments/`.
3. Create `GOAL.md`, `BACKLOG.md`, `RESULTS.md`, `loop.config.json`,
   `run-state.json`, and copy `scripts/experiment-loop.py` in the workspace.
4. The user starts `python3 experiments/experiment-loop.py` in a terminal window.
5. The script creates a new experiment branch and launches `copilot -p`.
6. The worker completes one experiment, updates the catalog and local notes,
   commits tracked code changes locally, and exits.
7. The script checks `RESULTS.md` and/or Experiment Catalog. If the goal is met,
   it stops with a summary; otherwise it starts the next experiment.

Everything is local by default: do not push, open PRs, merge, delete branches,
or productize winning changes. If an experiment is interrupted before
completion, record it as incomplete and start over with a new experiment name
and branch.

Use the shipped `scripts/experiment-loop.py` template. Copy it into the
experiment workspace; do not generate a bespoke loop script from scratch unless
the user asks for custom implementation. The copied script infers its workspace
from its own directory, so `loop.config.json` does not need a `workspace` field.

Each worker's goal is exactly one clean experiment iteration. User-defined
result criteria classify that completed experiment as
success/neutral/regression/inconclusive; those criteria are not the worker's
completion goal. A separate user-defined loop stop condition determines when a
completed experiment should be labeled `goal-met` and signals the supervisor to
stop the overall loop.

## Separation of Concerns

- `experiment-loop.py` owns only supervision mechanics: branch creation, config
  restore, worker launch, logging, final safety commit, result-label detection,
  and stop/failure policy.
- `GOAL.md` owns the durable operating contract: goal (run a clean experiment
  successfully), success criteria for that experiment, baseline isolation,
  catalog/evaluation procedure, validation gates, hypothesis implementation/proof requirements, artifact-parameter verification requirements, learning loop, and
  policies.
- `BACKLOG.md` owns all experiment-specific hypotheses, runtime parameters,
  code/config changes, set names, permutation definitions, verification details,
  evidence, results, and follow-up candidates.
- The generated worker prompt must be a small bootstrap that points to
  `GOAL.md` and `BACKLOG.md`; it must not duplicate individual experiment
  details.

## Required User Inputs

Collect these before setup. If the user does not know a value, inspect the repo
and propose a default.

| Field                           | Purpose                                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project/system name             | Used for branch and catalog naming.                                                                                                                                                                                |
| Experiment workspace            | Local folder for ignored experiment-control files; default `experiments/`.                                                                                                                                         |
| Base branch                     | Branch each experiment starts from; default `main` unless repo suggests otherwise.                                                                                                                                 |
| Experiment Catalog URI          | API base URI, usually ending in `/api`.                                                                                                                                                                            |
| Experiment Catalog project name | Existing or to-be-created catalog project.                                                                                                                                                                         |
| Baseline                        | Catalog baseline experiment/set or project baseline rule.                                                                                                                                                          |
| Per-experiment result criteria  | How to classify a completed experiment as success, neutral, regression, or inconclusive.                                                                                                                           |
| Loop stop condition             | The final condition that labels a completed experiment `goal-met` and ends the overall loop.                                                                                                                       |
| Interim success rule            | How to label useful non-final wins when they do not meet the loop stop condition.                                                                                                                                  |
| Primary metric                  | Main optimization target.                                                                                                                                                                                          |
| Guardrail metrics               | Metrics that must not regress beyond user-defined thresholds.                                                                                                                                                      |
| Inference/evaluation route      | Local commands, AML Evaluation Runner modules, or another deterministic route.                                                                                                                                     |
| Validation commands             | Deterministic checks to run before expensive evaluation.                                                                                                                                                           |
| Resource constraints            | Concurrency limits, flaky services, rate limits, credentials, or known hazards.                                                                                                                                    |
| Resettable config files         | Repo-relative paths for tracked or gitignored config files, such as `.env.local` or tracked ground-truth `.env` files, that must be restored from backup before each experiment. Ask explicitly; use `[]` if none. |

## Where Interview Answers Go

Use one interview to populate both files:

| Answer                                                                                                                                                                  | Write to                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Project/system name                                                                                                                                                     | `GOAL.md`, `loop.config.json.project_name`, and catalog project naming if applicable.                    |
| Experiment workspace                                                                                                                                                    | Filesystem path only; do not put it in `loop.config.json` because the script infers it.                  |
| Base branch                                                                                                                                                             | `GOAL.md` and `loop.config.json.base_branch`.                                                            |
| Branch naming preference                                                                                                                                                | `GOAL.md` and `loop.config.json.branch_prefix`; default `experiment`.                                    |
| Copilot command/path                                                                                                                                                    | `loop.config.json.copilot_command`; mention only in `GOAL.md` if workers need to know it.                |
| Experiment Catalog URI/project                                                                                                                                          | `GOAL.md` and `loop.config.json.experiment_catalog`.                                                     |
| Resettable config files                                                                                                                                                 | `GOAL.md` with purpose/context and `loop.config.json.reset_config_files` with exact repo-relative paths. |
| Baseline, metrics, stop rules, validation, evaluation, upload, comparison, constraints, and hazards                                                                     | `GOAL.md` only.                                                                                          |
| Candidate hypotheses, runtime parameters, code/config changes, set names, permutation definitions, expected impact, candidate-specific verification, and rollback plans | `BACKLOG.md` only.                                                                                       |

## Setup Procedure

1. Confirm Experiment Catalog is reachable and the target project exists or can
   be created. If not, use `experiment-catalog-operator` or
   `experiment-catalog-install` as appropriate before continuing.
2. Confirm the evaluation route can publish or upload results to Experiment
   Catalog. If using AML Evaluation Runner, invoke `aml-eval-runner-operator` for
   runner-specific configuration.
3. Create the workspace directory if needed.
4. Add or confirm a `.gitignore` entry for the workspace. The workspace must
   persist across branch switches and must not be committed by default.
5. Ask for repo-relative paths of any tracked or gitignored config files that must reset
   before every experiment. Record them in `loop.config.json` as
   `reset_config_files`; use an empty array when there are none.
6. Copy those config files into `<workspace>/_config-backups/`, preserving their
   repo-relative paths. Do not commit the backup folder.
7. Copy this skill's `scripts/experiment-loop.py` into the workspace.
8. Create `loop.config.json` beside the copied script.
9. Create `run-state.json` as `{}` if it does not exist.
10. Create or update `GOAL.md`, `BACKLOG.md`, and `RESULTS.md`.
11. Report the exact command to start the loop.

## Minimal `loop.config.json`

Keep this config small. It exists only for values the Python supervisor must read
deterministically before a worker starts. `GOAL.md` is the authoritative
experiment brief and should include the same human-readable details plus all
evaluation commands, metric definitions, stop criteria, and catalog procedures.
Do not duplicate full experiment design in JSON, and do not parse `GOAL.md` from
the supervisor.

```json
{
  "base_branch": "main",
  "branch_prefix": "experiment",
  "project_name": "review-assistant",
  "copilot_command": "copilot",
  "experiment_catalog": {
    "uri": "https://example.invalid/api",
    "project_name": "review-assistant"
  },
  "reset_config_files": [],
  "max_consecutive_failures": 3
}
```

`copilot_command` defaults to `copilot`. Keep it configurable so users can point
to a full path or wrapper command if needed. `max_consecutive_failures` limits
failed or inconclusive attempts for one experiment; when the limit is reached,
the supervisor abandons that experiment and starts the next one instead of
exiting. `reset_config_files` belongs here because the supervisor must restore
those files before it creates the experiment branch and before the worker can
read `GOAL.md`; also describe the files and why they are reset in `GOAL.md` for
the worker's context. Paths must be repo-relative and either tracked by git or
gitignored.

## Workspace Files

### `GOAL.md`

Write a project-specific operating contract that a fresh worker can follow
without prior conversation context. `GOAL.md` must not contain individual
experiment hypotheses, specific model choices, permutation set names, or
candidate-specific code changes. Put those in `BACKLOG.md`. Include:

- goal and motivation;
- a one-experiment worker completion rule: one iteration is complete once the
  selected backlog candidate has been implemented, verified as exercising the
  hypothesis, evaluated or explicitly marked non-comparable, documented in
  `RESULTS.md` and `BACKLOG.md`, and committed if it produced non-ignored
  changes;
- commit/workspace policy;
- Experiment Catalog URI, project, baseline, and naming rules;
- baseline-isolation policy: each experiment starts from the original baseline
  and changes only the hypothesis variable being tested;
- primary metric, guardrail metrics, result-classification criteria, interim
  success criteria, and final supervisor stop condition;
- exact validation, inference, evaluation, upload, annotation, and comparison
  commands or AML Evaluation Runner modules;
- a hypothesis implementation/proof policy: workers must identify the effective
  code/config/control surface consumed by the route, make the minimal change
  needed to exercise the selected hypothesis, and prove the hypothesis is active
  before expensive evaluation;
- resource constraints and known hazards;
- resettable tracked or gitignored config files and what each one controls,
  matching `loop.config.json`;
- one-experiment procedure;
- continuous learning requirements;
- a rule that workers must read the selected `BACKLOG.md` candidate for exact
  runtime parameters, the effective config source or command-scoped environment
  variables consumed by the evaluation route, set names, code changes,
  artifact-parameter verification, and rollback instructions.

Critical rules to include:

```md
Files under `experiments/` are gitignored local experiment-control artifacts.
Do not commit them, do not force-add them, and do not commit any other
gitignored file. Commit every non-ignored code/configuration change locally on
each experiment branch so the exact implementation that was run is auditable.
Before returning to the base branch, `git status --porcelain
--untracked-files=all` must show no non-ignored tracked or untracked changes.
Do not push, merge, open a PR, delete branches, or productize results unless
the user explicitly asks later.
```

```md
Every experiment must use the same ground truth, baseline, metric definitions,
and guardrail thresholds unless this file explicitly says the baseline changed.
Do not compare runs that used materially different evaluation inputs as if they
were equivalent.
Result counts do not need to exactly match baseline counts. Unequal counts must
be reported with missing/failed refs and may reduce confidence, but count
mismatch alone does not make a run inconclusive when the same intended ground
truth, baseline, metric definitions, and guardrail thresholds were used.
```

```md
Every experiment branch must be a clean, reproducible test of one hypothesis.
Start from the configured base branch and original baseline, then make only the
smallest code/configuration change needed to test the selected hypothesis. Do
not carry forward previous experiment changes, prior config edits, prompt
tweaks, incidental refactors, dependency updates, metric changes, or evaluation
input changes unless they are the explicit variable being tested and are
documented as such. If more than one variable changed, label the result
`inconclusive` unless the run is intentionally documented as a new baseline.
```

### `BACKLOG.md`

Create a ranked backlog with:

- a short ranked candidate list;
- completed experiment list;
- code surface inventory;
- detailed candidate entries.

Each candidate should include hypothesis, single-variable change, expected
impact, isolation boundary, quality risk, metrics to watch, suggested set names,
evidence, rollback plan, and status.

Each candidate should also include candidate-specific runtime/configuration
parameters, the exact config source or command environment variables that the
inference/evaluation route actually consumes, and any artifact checks needed to
prove the run used the intended configuration. If command-scoped environment
variables do not override the route's config files, the candidate must instruct
the worker to edit the effective config file instead. These details belong in
`BACKLOG.md`, not `GOAL.md` or the loop prompt.

Workers are still responsible for validating candidate instructions against the
actual code path before running expensive evaluation. If the backlog names the
wrong control surface, the worker must correct the implementation, document the
learning in `BACKLOG.md`, mark any already-started attempt non-comparable, and
exit so the supervisor can restart from a fresh branch rather than uploading
misleading results.

When an experiment completes, update the candidate with the result, evaluated set
name, metric/result summary, observed failure modes, and whether the idea should
be retried, combined, narrowed, or abandoned.

### `RESULTS.md`

Create an at-a-glance board. `RESULTS.md` is the only local results board; do
not create `results.jsonl`. Every evaluated run should also be recorded in
Experiment Catalog. Do not create CSV, JSONL, SQLite, or local-only fallback
result stores.

Recommended header:

```md
# Experiment Results

At-a-glance progress board for <project/system> experiments.

Baseline:

- Source: <catalog project/experiment/set or project baseline>
- Ground truth: <name/path/version>
- Primary metric: `<metric>` = <value>
- Guardrail metrics:
  - `<metric>` = <value>
  - `<metric>` = <value>
- Interim success: <definition>
- Goal met: <definition>
```

Recommended table:

```md
| Experiment | Date | Hypothesis | Result | Best/decisive set | Primary metric delta | Worst guardrail delta | Key learning |
| ---------- | ---- | ---------- | ------ | ----------------- | -------------------- | --------------------- | ------------ |
```

Allowed result labels:

- `goal-met`
- `success`
- `neutral`
- `regression`
- `inconclusive`

Treat fast-but-low-quality runs as regressions. A speed win is not a success if
quality guardrails fail.

Workers should append exactly one row per attempted experiment iteration. The
row's label tells the supervisor what to do next: `goal-met` stops the loop;
`success`, `neutral`, and `regression` complete the worker turn but allow the
supervisor to continue; `inconclusive` counts against the failure policy and
should include enough failure detail for a fresh retry.

## Loop Script Behavior

The copied script should:

- infer workspace from its own directory;
- read `loop.config.json`;
- verify the workspace is gitignored;
- verify non-ignored working tree state is clean before creating the next branch;
- check out the base branch;
- restore every `reset_config_files` path from `<workspace>/_config-backups/`
  before creating the experiment branch;
- create every experiment branch from that clean base state rather than from a
  previous experiment branch;
- create a fresh experiment branch named
  `<branch_prefix>/<project-slug>-exp-YYYYMMDD-NN`;
- create `experiments/<experiment-name>/artifacts/worker-prompt.txt`;
- launch `copilot -p` in non-interactive mode;
- print timestamped supervisor progress to the console and
  `experiments/logs/experiment-loop.log`;
- stream worker stdout/stderr to both the console and
  `experiments/<experiment-name>/artifacts/copilot-run.log`;
- make a final safety commit for any remaining non-ignored changes on the
  experiment branch before returning to the base branch;
- fail rather than continue if any file under the gitignored experiment
  workspace becomes tracked or staged;
- parse `RESULTS.md` or consult Experiment Catalog to detect `goal-met`;
- mark interrupted attempts incomplete and continue from a new branch/name;
- after `max_consecutive_failures`, abandon the current experiment and continue
  with a fresh experiment.

Start it from a terminal:

```bash
python3 experiments/experiment-loop.py
```

Optional one-iteration smoke:

```bash
python3 experiments/experiment-loop.py --max-iterations 1 --dry-run
```

## Worker Prompt Requirements

The worker prompt generated by the script should say:

```text
Follow experiments/GOAL.md. Complete exactly one experiment iteration.

Experiment name: <supervisor-provided experiment name>
Current branch: <supervisor-created branch>
Experiment Catalog URI: <catalog URI>
Experiment Catalog project: <catalog project>

Use experiments/BACKLOG.md as the only source for the selected experiment's
hypothesis, parameters, set names, code/config changes, verification steps, and
rollback plan. Select the highest-ranked pending candidate and execute exactly
one experiment or permutation group as instructed there.

Update experiments/RESULTS.md and experiments/BACKLOG.md with the result and
learning before exiting.
```

## Validation Before Handoff

After creating the skill workspace in a repository:

1. Confirm `experiments/` is gitignored.
2. Confirm `loop.config.json` has catalog URI and project name.
3. Confirm `reset_config_files` is present in `loop.config.json`; if non-empty,
   confirm each path is gitignored and has a backup under
   `experiments/_config-backups/`.
4. Confirm `GOAL.md` contains concrete evaluation commands or AML runner module
   references.
5. Run:

```bash
python3 experiments/experiment-loop.py --max-iterations 1 --dry-run
```

6. Confirm the dry run prints a `copilot -p` command and does not start a real
   experiment.

## Handoff

Summarize:

- workspace path;
- files created or updated;
- catalog URI/project;
- baseline and stop condition;
- first recommended backlog candidate;
- command to start the loop.

Do not start a multi-day loop unless the user explicitly asks.
