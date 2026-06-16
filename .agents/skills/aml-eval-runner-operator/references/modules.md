# Modules

Use this reference when creating, validating, or diagnosing custom inference and evaluation implementations.

## Execution Modes

| Mode | Trigger | Notes |
| --- | --- | --- |
| Module mode | `AML_INF_MODULE_DIR` and/or `AML_EVAL_MODULE_DIR` | Python modules copied into AML job or imported locally. Best visibility in AML logs and run history. |
| HTTP mode | `INF_INFERENCE_SERVICE_URL` and/or `EVAL_SERVICE_URL` | Remote service controlled by caller. Useful for non-Python stacks or hosted agents. |
| Mixed mode | One stage module, one stage HTTP | Supported independently for inference and evaluation. |

For local mode, HTTP URLs override module dirs per stage. For AML pipeline runs, module dirs are required by the current CLI even when service URLs are configured because staged scripts are still copied.

## Inference Module Contract

Module directory:

```text
AML_INF_MODULE_DIR=../inference/default
AML_INFERENCE_MODULE=default
AML_INF_ENV_PATH=../inference/default/.env
```

The runner imports `inference.py` from the configured module directory. Discovery order:

1. Module-level functions.
2. Static or class methods on `InferenceService`.
3. Instance methods on `InferenceService` after auto-instantiation.

Recommended function interface:

```python
def init_inference(**kwargs) -> None:
    ...

def process_inference(ground_truth_source: dict) -> dict:
    ...
```

`init_inference` kwargs include:

| Key | Description |
| --- | --- |
| `job_output_path` | Directory where job writes output files. |
| `job_id` | Unique run ID. |
| `experiment_name` | Normalized experiment name. |
| `job_name` | Optional friendly display name when available. |

`process_inference` receives one ground truth dictionary and returns a JSON-serializable dictionary passed to evaluation.

## Evaluation Module Contract

Module directory:

```text
AML_EVAL_MODULE_DIR=../evaluation/default
AML_EVAL_MODULE=default
AML_EVAL_ENV_PATH=../evaluation/default/.env
```

The runner imports `eval.py` from the configured module directory. Discovery order:

1. Module-level functions.
2. Static or class methods on `EvaluationService`.
3. Instance methods on `EvaluationService` after auto-instantiation.

Recommended function interface:

```python
def init_evaluation(**kwargs) -> None:
    ...

def process_evaluation(payload_json: dict) -> dict:
    ...
```

`payload_json` is the inference result dictionary. Return a JSON-serializable dictionary; include `$metrics` for structured metrics:

```python
return {
    "answer": "...",
    "$metrics": {
        "generation_correctness": 0.92,
        "meta_latency_ms": 1830,
    },
}
```

## Metric Emission Rules

- Put decision metrics under `$metrics`.
- Use stable lowercase names.
- Use numeric values for averages, costs, counts, durations, and token usage.
- Classification values may use `t+`, `t-`, `f+`, or `f-` when downstream catalog aggregation expects classification outcomes.
- Avoid strings for normal metrics; the catalog action removes non-classification strings.
- Evaluation metrics override inference metrics when keys collide.

## Remote Service Contracts

Inference service:

```text
INF_INFERENCE_SERVICE_URL=https://...
INF_INFERENCE_SERVICE_TUNNEL_TOKEN=<token-if-devtunnel>
```

Evaluation service:

```text
EVAL_SERVICE_URL=https://...
EVAL_SERVICE_TUNNEL_TOKEN=<token-if-devtunnel>
```

Evaluation services must support:

| Endpoint | Use |
| --- | --- |
| `GET /health` | Health check. |
| `POST /evaluation` | Accept inference payload and return evaluation result. |

Remote services should log or propagate `X-AML-Job-Id` when present so failures can be traced back to AML runs.

## Dependencies

Use one or more:

```text
<module-dir>/requirements.txt
AML_EXTRA_DEPS=path/to/requirements.txt
amleval --env-path .exp.env --extra-deps path/to/requirements.txt
```

The runner merges customer pip requirements into the base conda environment at submission time. Runner dependencies take precedence; conflicting customer packages are skipped with a warning. Do not edit the packaged `amlevalreq.yml` for downstream module dependencies.

## Copy Rules

For module dirs, the runner copies source into the job but ignores common non-runtime files such as virtual environments, `__pycache__`, `.env`, `.md`, `requirements.txt`, `.git`, CSVs, `pyproject.toml`, and lockfiles. Runtime assets needed by the module should be packaged intentionally and tested with a smoke/local run.

## Validation Workflow

1. Run unit tests in the downstream module repo if present.
2. Run `amleval --env-path .local.env --local` with a tiny ground truth set.
3. Verify every ground truth creates an inference output and evaluation output.
4. Verify evaluation outputs include expected `$metrics`.
5. Run `.smoke.env` in AML before `.exp.env` or `.baseline.env`.

Prefer testing module code through the runner boundary rather than only importing functions directly.
