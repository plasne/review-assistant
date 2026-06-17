# Actions And Catalog

Use this reference for action hooks, required action behavior, catalog publishing, and metric payloads.

## Action Types

| Type | Location | Enablement |
| --- | --- | --- |
| Built-in action | Ships in `src/amleval/_aml_scripts/actions/` | Add name to `ENABLED_ACTIONS`. |
| Custom action | External `.py` files copied at submission | Set `AML_CUSTOM_ACTIONS_DIR` and add name to `ENABLED_ACTIONS`. |

Custom actions can live directly in `AML_CUSTOM_ACTIONS_DIR` or subdirectories. Only `.py` files are copied.

## Enable Actions

```text
ENABLED_ACTIONS=catalog,myaction
```

Make an action pipeline-blocking:

```text
REQUIRED_ACTIONS=catalog
```

The CLI validates every `REQUIRED_ACTIONS` entry is also in `ENABLED_ACTIONS` before submitting. Optional action failures are logged and processing continues; required action failures should be treated as run failures.

## Action Env Injection

Use `EVAL_SET_` for variables consumed by evaluation hooks/actions:

```text
EVAL_SET_MY_ENV=value
```

The runner strips `EVAL_SET_` before injecting variables into the evaluation job, so the action reads `MY_ENV`.

## Custom Action Interface

Actions inherit from `BaseAction` and advertise capabilities with methods such as:

```python
class MyAction(BaseAction):
    def is_process_eval_results(self) -> bool:
        return True

    def process_eval_results(
        self,
        eval_results: dict,
        inf_response: dict | None = None,
        job_details: dict | None = None,
    ) -> None:
        ...
```

`job_details` for evaluation-result actions includes:

| Key | Meaning |
| --- | --- |
| `ground_truth_ref` | Ground truth identifier. |
| `iteration` | Iteration number from filename. |
| `aml_job_id` | Runner job ID. |
| `experiment_name` | Normalized experiment name. |
| `inference_base_path` | Base storage URI for inference outputs. |
| `eval_base_path` | Base storage URI for evaluation outputs. |
| `filename` | Processed filename. |

Summarization actions receive job-level details such as `aml_job_id`, `experiment_name`, `iteration_count`, and `ground_truths_path`.

## Built-In Catalog Action

Enable:

```text
ENABLED_ACTIONS=catalog
EVAL_SET_CATALOG_URL=https://catalog.example.com/api
EVAL_SET_CATALOG_PROJECT=my-project
```

Optional bearer-token auth:

```text
EVAL_SET_CATALOG_API_APP_ID_URI=api://...
```

Preconditions:

1. Catalog API URL includes `/api`.
2. Catalog project exists.
3. Catalog experiment exists and matches normalized `AML_EXPERIMENT_NAME`.
4. Metrics emitted under `$metrics`.
5. If managed identity auth is used, the catalog app exposes the required application role.

The catalog action warms up cold Container Apps by calling `GET {CATALOG_URL}/projects` with a longer first timeout.

## Catalog Payload

The action posts to:

```text
POST {CATALOG_URL}/projects/{CATALOG_PROJECT}/experiments/{experiment_name}/results
```

Payload:

```json
{
  "ref": "<ground_truth_ref>_<iteration>",
  "set": "<aml_job_id>",
  "inference_uri": "<inference_base_path>/<filename>",
  "evaluation_uri": "<eval_base_path>/<filename>",
  "metrics": {
    "metric_key": 0.95,
    "another_metric": "t+"
  }
}
```

Field rules:

| Field | Source |
| --- | --- |
| `ref` | `ground_truth_ref` plus `_` plus `iteration`. |
| `set` | `aml_job_id`; this is the catalog set/run name. |
| `inference_uri` | Inference base path plus filename. |
| `evaluation_uri` | Evaluation base path plus filename. |
| `metrics` | Merged `$metrics` from inference and evaluation. |

## Metric Cleaning

Before catalog submission:

- `NaN` floats are removed.
- Non-classification strings are removed.
- Classification strings `t+`, `t-`, `f+`, and `f-` are kept case-insensitively.
- Integers and floats are kept.
- If no `$metrics` exists in inference or evaluation, the result is skipped.

## Catalog Analysis Handoff

When handing results to the Experiment Catalog skill or tools, provide:

```text
catalog_url=<.../api>
catalog_project=<project>
catalog_experiment=<normalized AML_EXPERIMENT_NAME>
catalog_set=<job_id>
env_path=<env file>
hypothesis=<hypothesis>
annotations=<annotations>
ground_truth_source=<datastore path or data asset>
iteration_count=<count>
```

Use the Experiment Catalog Operator for compare, p-values/statistics, per-ref analysis, and meaningful tags.
