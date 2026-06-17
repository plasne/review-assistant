# Commands And Config

Use this reference for runner commands, env files, required variables, execution modes, resume flows, and artifact download.

## Install Or Locate

If the runner is not installed in the current environment:

```bash
pip install -e .
```

from the cloned runner repo, or:

```bash
pip install git+https://github.com/microsoft/aml-evaluation-runner.git@main
```

The console script is:

```bash
amleval --help
```

The package requires Python 3.12. The source repo commonly uses `uv`.

## Env Files

Common env files:

| File | Use |
| --- | --- |
| `.local.env` | Local run without Azure ML; copy from `src/.local.env.example`. |
| `.smoke.env` | Small AML smoke run for image/module/dependency validation. |
| `.exp.env` | Experiment run, usually validation ground truths. |
| `.baseline.env` | Baseline run, usually full test and validation ground truths. |

Do not assume these files exist in downstream repos. Discover them with file search and inspect only non-secret structure; avoid printing secret values.

## CLI Commands

Azure ML pipeline:

```bash
amleval --env-path .exp.env --hypothesis "<hypothesis>" --annotations reason=experiment,key=value
```

Local run:

```bash
amleval --env-path .local.env --local
```

Friendly AML Studio display name:

```bash
amleval --env-path .exp.env --job-name "prompt-context-v2" --annotations reason=experiment
```

Resume evaluation after a valid inference run:

```bash
amleval --env-path .exp.env --resume-evaluation <previous-job-id>
```

Resume summary/actions after valid evaluation output:

```bash
amleval --env-path .exp.env --resume-summary <previous-job-id>
```

All CLI flags support hyphenated and underscore forms, such as `--env-path` and `--env_path`.

## CLI Arguments

| Argument | Use |
| --- | --- |
| `--env-path` | Path to runner env file; defaults to `./.env`. |
| `--local` | Run without Azure ML infrastructure. |
| `--resume-evaluation` | Re-run evaluation and summary using previous inference output. |
| `--resume-summary` | Re-run summary/actions using previous evaluation output. |
| `--hypothesis` | Experiment hypothesis recorded in summary. |
| `--annotations` | Comma-delimited `key=value` tags attached to the run. |
| `--job-name` | Optional display name in AML Studio; env fallback is `AML_JOB_NAME`. |
| `--show-job-output` | Print full submitted job object. Avoid unless needed. |
| `--inf-env-path` | Explicit inference env override file. |
| `--eval-env-path` | Explicit evaluation env override file. |
| `--extra-deps` | Additional pip requirements file merged into AML environment. |

## Required Variables For AML Pipeline

Minimum AML run variables:

```text
AML_SUBSCRIPTION_ID=<subscription-id>
AML_RESOURCE_GROUP_NAME=<resource-group>
AML_WORKSPACE_NAME=<workspace>
AML_COMPUTE_NAME=<compute>
AML_EXPERIMENT_NAME=<experiment-name>
AML_JOB_OUTPUT_DATASTORE=<output-datastore>
AML_INF_MODULE_DIR=<path-to-inference-module>
AML_EVAL_MODULE_DIR=<path-to-evaluation-module>
```

Ground truth input is one of:

```text
AML_JOB_INPUT_DATASTORE=<input-datastore>
AML_GROUND_TRUTHS_PATH=<datastore-path>
```

or version-pinned data asset:

```text
AML_GT_DATA_ASSET_NAME=<asset-name>
AML_GT_DATA_ASSET_VERSION=<asset-version>
```

When `AML_GT_DATA_ASSET_NAME` is set, `AML_GT_DATA_ASSET_VERSION` is required for reproducibility.

## Required Variables For Local Mode

```text
AML_EXPERIMENT_NAME=my-experiment
AML_JOB_INPUT_PATH=./data
AML_GROUND_TRUTHS_PATH=ground_truths
AML_JOB_OUTPUT_PATH=./output
```

Local module mode:

```text
AML_INF_MODULE_DIR=../inference/default
AML_EVAL_MODULE_DIR=../evaluation/default
```

Local HTTP mode:

```text
INF_INFERENCE_SERVICE_URL=http://localhost:8080
EVAL_SERVICE_URL=http://localhost:8081
```

HTTP URLs override module mode independently, so mixed mode is allowed.

## Common Optional Variables

```text
AML_ITERATION_COUNT=5
AML_JOB_NAME=readable-run-name
AML_LOG_LEVEL=INFO
GROUND_TRUTH_INCLUDE_TAGS=dev,test
AML_INFERENCE_CONCURRENCY=10
AML_EVAL_CONCURRENCY=10
AML_INF_TIMEOUT_SECONDS=360
AML_EVAL_TIMEOUT_SECONDS=120
AML_SUMMARY_TIMEOUT_SECONDS=300
AML_CREATE_ITERATION_TIMEOUT_SECONDS=300
AML_IMAGE_NAME=<acr-image-or-base-image>
AML_EXTRA_DEPS=path/to/requirements.txt
```

Timeouts must be at least 30 seconds. `AML_ITERATION_COUNT` of `0` or `1` skips iteration expansion; values greater than `1` create per-ground-truth iteration files.

## Env Prefix Rules

The runner can load inference/evaluation env files or inject overrides by prefix.

Inference:

```text
AML_INF_ENV_PATH=../inference/default/.env
INF_SET_AI_SEARCH_ENDPOINT=https://example.search.windows.net
```

Evaluation:

```text
AML_EVAL_ENV_PATH=../evaluation/default/.env
EVAL_SET_MODEL_NAME=gpt-4.1
```

`INF_SET_` and `EVAL_SET_` keys override matching values loaded from the respective env files. Use these for per-run overrides and action configuration.

## Output Paths

Remote AML outputs are stored under:

```text
<experiment_name>/<job_id>/groundtruths/
<experiment_name>/<job_id>/inference/
<experiment_name>/<job_id>/eval/
<experiment_name>/<job_id>/jobinfo/
<experiment_name>/<job_id>/summary/
```

Local outputs are stored under:

```text
{AML_JOB_OUTPUT_PATH}/{experiment_name}/{job_id}/inference/
{AML_JOB_OUTPUT_PATH}/{experiment_name}/{job_id}/eval/
```

`AML_EXPERIMENT_NAME` is normalized to lowercase and spaces become underscores.

## Download AML Outputs

From the runner repo:

```bash
uv run python utilities/download_outputs.py \
  --env_path .exp.env \
  --list_experiments
```

```bash
uv run python utilities/download_outputs.py \
  --env_path .exp.env \
  --experiment_name <experiment_name> \
  --list_jobs
```

```bash
uv run python utilities/download_outputs.py \
  --env_path .exp.env \
  --experiment_name <experiment_name> \
  --job_id <job_id> \
  --output_dir ./downloads
```

The utility requires `AML_SUBSCRIPTION_ID`, `AML_RESOURCE_GROUP_NAME`, `AML_WORKSPACE_NAME`, and `AML_JOB_OUTPUT_DATASTORE`.
