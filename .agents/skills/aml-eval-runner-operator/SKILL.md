---
name: aml-eval-runner-operator
description: Operate AML Evaluation Runner instances from any repository. Use when configuring runner env files, creating or validating inference/evaluation modules, running local or Azure ML experiments, resuming failed stages, downloading outputs, enabling catalog/actions, comparing run artifacts, or diagnosing runner failures.
license: MIT
compatibility: Requires aml-evaluation-runner 1.x, Python 3.12, uv or pip, and Azure ML access for non-local runs.
metadata:
  spec_version: "1.0"
  version: "1.0.0"
  runner_skill_version: "1.0.0"
  runner_project: "microsoft/aml-evaluation-runner"
  runner_version_researched: "1.0.4"
---

# AML Evaluation Runner Operator

Use this skill to operate the AML Evaluation Runner after it is installed or cloned. Keep deployment work in `aml-eval-runner-install`; use this skill for experiment execution, module contracts, actions, output analysis, and diagnostics.

## What To Load

- Use `references/commands-and-config.md` for CLI commands, env files, execution modes, required variables, resume flows, and output download commands.
- Use `references/modules.md` for inference/evaluation module contracts, remote service contracts, dependency handling, and local test rules.
- Use `references/actions-and-catalog.md` for built-in/custom actions, catalog publishing, `$metrics`, payload shapes, and action failure semantics.
- Use `references/analysis-and-diagnostics.md` for artifact layout, result inspection, comparisons, logs, telemetry, retries, and failure triage.

## Inputs To Discover

- Runner location: cloned repo, installed package, or target app repo using `amleval`.
- Mode: `local`, AML pipeline, `resume-evaluation`, or `resume-summary`.
- Env path: `.local.env`, `.smoke.env`, `.exp.env`, `.baseline.env`, or user-provided path.
- Module mode: Python module dirs, HTTP inference/evaluation services, or mixed mode.
- Ground truth source: local path, AML datastore path, or version-pinned AML data asset.
- Output target: local output path or AML output datastore plus `experiment_name/job_id`.
- Integrations: enabled actions, required actions, Experiment Catalog target, telemetry.

Do not invent Azure subscription, workspace, datastore, identity, catalog, ground truth, or secret values. Ask only when a missing value materially affects a write, a submission, or an irreversible resource operation.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Runner | The `amleval` CLI and embedded AML scripts. |
| Experiment | `AML_EXPERIMENT_NAME`, normalized to lowercase with spaces replaced by underscores. |
| Job ID | Timestamp ID generated at submission; also the catalog set for catalog action results. |
| Ground truth | JSON input item; optionally expanded into per-iteration files. |
| Inference | Stage that transforms a ground truth into an inference response. |
| Evaluation | Stage that scores an inference response and should emit `$metrics`. |
| Summary | Stage that aggregates outputs and executes summarization actions. |
| Action | Hook enabled by `ENABLED_ACTIONS`; optional unless listed in `REQUIRED_ACTIONS`. |

## Default Workflow

1. Identify runner repo/package, env file, execution mode, and intended ground truth set.
2. Validate env variables before running: required AML/local paths, module dirs or service URLs, iteration count, datastores/assets, actions, timeouts, and secret references.
3. Validate module contracts or service health before submitting expensive AML jobs.
4. Run the smallest useful gate first: local run or smoke env before full experiment/baseline.
5. Capture `experiment_name`, `job_id`, env path, git commit, hypothesis, annotations, and output path.
6. Inspect output counts and logs before declaring success; compare expected ground truth/iteration count to inference/eval outputs.
7. If catalog publishing is enabled, verify the catalog project/experiment exists and results are visible under set `<job_id>`.

## Tool Selection Rules

- Prefer `amleval --env-path <env> --local` for module contract checks when local data is available.
- Prefer `.smoke.env` or a small tagged subset before `.exp.env` or `.baseline.env`.
- Use `--resume-evaluation <job_id>` only when inference output is valid and evaluation failed or changed.
- Use `--resume-summary <job_id>` only when evaluation output is valid and summary/actions failed or changed.
- Use `utilities/download_outputs.py` for AML artifacts instead of manually browsing blob paths when the repo utility is present.
- Use Experiment Catalog tools/skill after the run when the user asks for cross-run comparison, regression analysis, p-values, meaningful tags, or catalog state.

## Analysis Rules

- Treat missing output files as failures or skipped items to investigate, not as zeros.
- For non-deterministic systems, prefer multiple iterations per ground truth; compare aggregate metrics and per-ref regressions.
- Use `$metrics` from inference and evaluation as the structured metric source; evaluation metrics override inference metrics on key collision.
- Respect metric direction from domain conventions or catalog metric definitions; latency, cost, token, and duration metrics are usually lower-is-better.
- Report run identity with conclusions: env path, experiment name, job ID, ground truth source, iteration count, module/service mode, and relevant annotations.

## Safety Rules

- Never print, commit, or persist secrets, DevTunnel tokens, connection strings, bearer tokens, or Key Vault secret values.
- Prefer Key Vault URLs or existing secret references over literal secrets in env files.
- Confirm before submitting broad AML jobs, changing baselines, overwriting env files, or enabling required actions that can fail the pipeline.
- Do not edit runner package internals in a downstream repo unless the user is explicitly contributing to `microsoft/aml-evaluation-runner`.
- Keep generated run artifacts and downloaded outputs out of source control unless the user explicitly asks to commit a small, sanitized fixture.

## Versioning

This skill uses `metadata.runner_skill_version` with SemVer.

- `MAJOR`: breaking workflow, CLI, config, or output interpretation changes.
- `MINOR`: new runner feature coverage, new action support, or new diagnostic workflows.
- `PATCH`: corrections, clarifications, command updates, or compatibility notes.
