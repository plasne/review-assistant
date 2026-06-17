# Analysis And Diagnostics

Use this reference after a run starts or completes, or when diagnosing failed submissions, missing outputs, bad metrics, or action issues.

## Run Identity To Capture

Always capture:

```text
env_path
AML_EXPERIMENT_NAME normalized as experiment_name
job_id
AML_JOB_NAME if set
hypothesis
annotations
git commit
ground truth source
iteration count
module dirs or service URLs
enabled/required actions
output datastore or local output path
```

For AML runs, the CLI prints an ML Studio link after submission. Keep the link or job ID in session state.

## Expected Stage Layout

Remote AML output prefix:

```text
<experiment_name>/<job_id>/groundtruths/
<experiment_name>/<job_id>/inference/
<experiment_name>/<job_id>/eval/
<experiment_name>/<job_id>/jobinfo/
<experiment_name>/<job_id>/summary/
```

Local output prefix:

```text
{AML_JOB_OUTPUT_PATH}/{experiment_name}/{job_id}/inference/
{AML_JOB_OUTPUT_PATH}/{experiment_name}/{job_id}/eval/
```

Expected counts:

```text
expected = ground_truth_count * AML_ITERATION_COUNT
```

when `AML_ITERATION_COUNT > 1`; otherwise expected inference/eval count usually equals ground truth count.

Missing inference output means inference did not process or write an item. Missing eval output with existing inference output means evaluation failed, skipped, or timed out for that item.

## Local Analysis

For local outputs:

```bash
find <output>/<experiment_name>/<job_id> -maxdepth 2 -type f | sort
```

Inspect JSON shapes and `$metrics` without printing sensitive payload fields if the data may include private records.

Useful checks:

```bash
find <run-output>/inference -name '*.json' | wc -l
find <run-output>/eval -name '*.json' | wc -l
```

If `GROUND_TRUTH_INCLUDE_TAGS` is set, expected counts apply only to ground truths containing all requested tags.

## AML Output Download

From the runner repo:

```bash
uv run python utilities/download_outputs.py \
  --env_path <env> \
  --experiment_name <experiment_name> \
  --job_id <job_id> \
  --output_dir ./downloads
```

Use downloaded artifacts for detailed comparison and regression inspection.

## Resume Decision Tree

Use `--resume-evaluation <job_id>` when:

- Inference outputs exist and are valid.
- Evaluation module/config changed, or evaluation failed.
- You need to regenerate evaluation and summary only.

Use `--resume-summary <job_id>` when:

- Evaluation outputs exist and are valid.
- Summary stage, action code, catalog config, or action env changed.
- You need to re-run summarization/actions only.

Do not resume from a job whose prerequisite stage outputs are incomplete unless the user explicitly wants partial processing.

## Common Failures

| Symptom | Likely Cause | Action |
| --- | --- | --- |
| `AML_EXPERIMENT_NAME must be set` | Missing required env value | Add to env file or export before running. |
| `AML_GT_DATA_ASSET_VERSION must be set` | Data asset name without version | Pin version for reproducibility. |
| `AML_INF_MODULE_DIR ... required` | AML pipeline needs staged module dir | Set module dir even if using remote inference. |
| `AML_EVAL_MODULE_DIR ... required` | AML pipeline needs staged eval module dir | Set module dir even if using remote evaluation. |
| Required action validation error | `REQUIRED_ACTIONS` not subset of `ENABLED_ACTIONS` | Add to enabled list or remove from required list. |
| Missing catalog results | No `$metrics`, project/experiment absent, URL lacks `/api`, auth issue, or action not enabled | Validate catalog preconditions and action logs. |
| Timeout below minimum | Stage timeout less than 30 seconds | Set each timeout to at least 30. |
| Remote evaluation flaky | Service errors or throttling | Check service health, logs, tunnel tokens, retries, and timeouts. |

## Logs And Telemetry

`AML_LOG_LEVEL` controls CLI and stage logging. Use `INFO` for normal runs and `DEBUG` for focused diagnostics.

Telemetry is enabled when:

```text
AML_APP_INSIGHTS_CONNECTION_STRING=<connection-string-or-key-vault-secret-url>
```

The runner passes it to stages as `OPEN_TELEMETRY_CONNECTION_STRING`. It may be a Key Vault secret URL:

```text
https://<vault-name>.vault.azure.net/secrets/<secret-name>
```

Stage service names:

| Stage | `service.name` |
| --- | --- |
| Create iteration files | `create-iteration-files` |
| Inference | `inference` |
| Evaluation | `evaluation` |
| Summarization | `summarization` |

Traces include `aml_job_id`; evaluation spans may include token usage metrics when returned in `$metrics`.

## Comparison Rules

- Compare runs with the same ground truth source, tags, metric definitions, iteration count, and evaluation logic unless intentionally testing those variables.
- Prefer catalog comparison when catalog action is enabled.
- Otherwise compare downloaded `eval/` JSON files by stable ground truth ref and iteration.
- Treat missing metrics as data quality issues.
- Separate quality metrics from operational metrics such as latency, cost, token count, and timeout rate.
- Include sample size and missing-output counts in conclusions.

## Handoff Template

```text
Run: <experiment_name>/<job_id>
Mode: <local|aml|resume-evaluation|resume-summary>
Env: <env path>
Ground truths: <source>, tags=<include tags>, iterations=<count>
Modules/services: inference=<module or URL>, evaluation=<module or URL>
Actions: enabled=<...>, required=<...>
Outputs: inference=<count>, eval=<count>, summary=<path/status>
Catalog: project=<project>, experiment=<experiment>, set=<job_id>, status=<visible|not-enabled|failed>
Decision: <ship|iterate|investigate> because <metric/output evidence>
```
