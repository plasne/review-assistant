#!/usr/bin/env python3
"""Evaluate Review Assistant inference artifacts stored in Azure Blob Storage."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import ssl
import sys
import textwrap
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

try:
    from azure.identity import DefaultAzureCredential
    from azure.storage.blob import BlobServiceClient, ContentSettings
except ImportError:  # pragma: no cover - exercised only when dependencies are missing.
    DefaultAzureCredential = None
    BlobServiceClient = None
    ContentSettings = None

try:
    import certifi
except ImportError:  # pragma: no cover - exercised only when optional CA bundle is missing.
    certifi = None


JsonValue = Any
FactJudge = Callable[[str, str], dict[str, JsonValue]]
MetricProducer = Callable[[], dict[str, JsonValue]]

JUDGE_SCHEMA_VERSION = "review-assistant.fact-judge.v1"
JUDGE_RETRY_ATTEMPTS = 3
JUDGE_LABEL_SCORES = {
    "equivalent": 1.0,
    "partial": 0.5,
    "missing": 0.0,
    "contradicted": 0.0,
}
DEFAULT_JUDGE_TIMEOUT_SECONDS = 120
GITHUB_AI_CREDIT_USD_ENV = "GITHUB_AI_CREDIT_USD"
DEFAULT_GITHUB_AI_CREDIT_USD = Decimal("0.01")
EXPERIMENT_CATALOG_HTTP_TIMEOUT_SECONDS = 30
EXPERIMENT_CATALOG_RETRY_ATTEMPTS = 3
EXPERIMENT_CATALOG_RETRY_DELAY_SECONDS = 1
EXPERIMENT_CATALOG_RETRYABLE_STATUS_CODES = {408, 429}


@dataclass(frozen=True)
class EvaluationPaths:
    evidence_path: str
    answer_path: str
    evidence_key: str | None
    output_schema: dict[str, JsonValue] | None
    ignored_output_structure_issues: tuple[dict[str, str], ...]


class RepairableJudgeOutputError(ValueError):
    """Judge output can be retried and, if needed, normalized deterministically."""


@dataclass(frozen=True)
class ExperimentCatalogConfig:
    base_url: str
    project: str
    experiment: str


DEFAULT_PATHS = EvaluationPaths(
    evidence_path="/evidence",
    answer_path="/answer",
    evidence_key=None,
    output_schema=None,
    ignored_output_structure_issues=(),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate inference JSON artifacts in an Azure Blob container.")
    parser.add_argument(
        "--prefix",
        default="",
        help="Optional blob prefix to evaluate, such as a run folder. Defaults to every JSON artifact in the container unless --latest is used.",
    )
    parser.add_argument(
        "--latest",
        action="store_true",
        help="Evaluate the latest inference run folder discovered from */manifest.json blobs.",
    )
    parser.add_argument(
        "--skip-existing",
        action="store_true",
        help="Skip existing .eval.json blobs. By default existing evaluation outputs are replaced.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.latest and args.prefix:
        raise RuntimeError("--latest cannot be combined with --prefix.")
    load_default_env()
    force_ground_truth_local_path()
    container_name = require_env("INFERENCE_CONTAINER")
    container = create_blob_service_client().get_container_client(container_name)
    prefix = latest_inference_prefix(container) if args.latest else normalize_prefix(args.prefix)
    fact_judge = create_fact_judge_from_env()
    experiment_catalog = create_experiment_catalog_from_env()
    experiment_catalog_sets: dict[str, str] = {}
    evaluated = 0
    skipped_existing = 0
    evaluation_failed = 0
    failed_artifacts: list[dict[str, JsonValue]] = []
    catalog_published = 0
    catalog_skipped_not_evaluated = 0

    for blob in container.list_blobs(name_starts_with=prefix):
        blob_name = blob.name
        if not is_inference_artifact_blob(blob_name):
            continue
        eval_blob_name = evaluation_blob_name(blob_name)
        eval_blob = container.get_blob_client(eval_blob_name)
        if args.skip_existing and eval_blob.exists():
            log_evaluation_progress("Skipping existing evaluation", eval_blob_name)
            skipped_existing += 1
            continue

        log_evaluation_progress("Evaluating inference artifact", blob_name)
        source_blob = container.get_blob_client(blob_name)
        source = json.loads(source_blob.download_blob().readall())
        result = evaluate_artifact(source, source_blob=blob_name, fact_judge=fact_judge)
        body = json.dumps(result, indent=2, sort_keys=True).encode("utf-8") + b"\n"
        eval_blob.upload_blob(
            body,
            overwrite=True,
            content_settings=ContentSettings(content_type="application/json") if ContentSettings else None,
        )
        result_status = result.get("status")
        if result_status != "evaluated":
            evaluation_failed += 1
            failure = evaluation_failure_summary(blob_name, result)
            failed_artifacts.append(failure)
            log_evaluation_failure(failure)
        if experiment_catalog is not None:
            if result_status == "evaluated":
                run_folder = inference_run_folder(source)
                if run_folder not in experiment_catalog_sets:
                    experiment_catalog_sets[run_folder] = next_experiment_catalog_set(experiment_catalog, run_folder)
                publish_experiment_catalog_result(
                    experiment_catalog,
                    source,
                    result,
                    set_name=experiment_catalog_sets[run_folder],
                    inference_uri=source_blob.url,
                    evaluation_uri=eval_blob.url,
                )
                catalog_published += 1
            else:
                catalog_skipped_not_evaluated += 1
        evaluated += 1

    print(
        json.dumps(
            {
                "catalog_published": catalog_published,
                "catalog_skipped_not_evaluated": catalog_skipped_not_evaluated,
                "evaluated": evaluated,
                "evaluation_failed": evaluation_failed,
                "failed_artifacts": failed_artifacts,
                "prefix": prefix,
                "skipped_existing": skipped_existing,
            },
            sort_keys=True,
        )
    )
    return 0


def log_evaluation_progress(message: str, blob_name: str) -> None:
    print(f"{message}: {blob_name}", file=sys.stderr, flush=True)


def log_evaluation_failure(failure: dict[str, JsonValue]) -> None:
    source_blob = failure["source_blob"]
    reason = failure["reason"]
    error_type = failure.get("error_type")
    detail = f"{error_type}: {reason}" if error_type else str(reason)
    print(f"Evaluation failed: {source_blob} - {detail}", file=sys.stderr, flush=True)


def evaluation_failure_summary(source_blob: str, result: dict[str, JsonValue]) -> dict[str, JsonValue]:
    error = result.get("error")
    if isinstance(error, dict):
        message = error.get("message")
        error_type = error.get("type")
        return {
            "source_blob": source_blob,
            "status": result.get("status"),
            "error_type": error_type if isinstance(error_type, str) and error_type else None,
            "reason": message if isinstance(message, str) and message else "Evaluation failed without an error message.",
        }

    source_status = result.get("source_status")
    if isinstance(source_status, str) and source_status:
        reason = f"Source inference status was {source_status!r}."
    else:
        reason = "Evaluation did not produce status 'evaluated'."

    return {
        "source_blob": source_blob,
        "status": result.get("status"),
        "reason": reason,
    }


def create_blob_service_client() -> Any:
    if BlobServiceClient is None:
        raise RuntimeError("Azure dependencies are missing. Install the TOML requirements with: python -m pip install -e ./eval")

    connstring = os.environ.get("AZURE_STORAGE_ACCOUNT_CONNSTRING", "").strip()
    if connstring:
        return BlobServiceClient.from_connection_string(connstring)

    account_name = os.environ.get("AZURE_STORAGE_ACCOUNT_NAME", "").strip()
    if not account_name:
        raise RuntimeError("AZURE_STORAGE_ACCOUNT_CONNSTRING or AZURE_STORAGE_ACCOUNT_NAME is required.")
    if DefaultAzureCredential is None:
        raise RuntimeError("azure-identity is required when using AZURE_STORAGE_ACCOUNT_NAME.")
    return BlobServiceClient(f"https://{account_name}.blob.core.windows.net", credential=DefaultAzureCredential())


def load_default_env() -> None:
    env_path = Path("ground-truth/config/.env")
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        os.environ[key] = unquote_env_value(value.strip())


def force_ground_truth_local_path() -> None:
    os.environ["LOCAL_PATH"] = str(Path("ground-truth").resolve())


def unquote_env_value(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required.")
    return value


def optional_env(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    return value or None


def create_experiment_catalog_from_env() -> ExperimentCatalogConfig | None:
    base_url = optional_env("EXPERIMENT_CATALOG_URL")
    if base_url is None:
        return None
    return ExperimentCatalogConfig(
        base_url=base_url,
        project=require_env("EXPERIMENT_CATALOG_PROJECT"),
        experiment=require_env("EXPERIMENT_CATALOG_EXPERIMENT"),
    )


def evaluation_blob_name(blob_name: str) -> str:
    if not blob_name.endswith(".json"):
        return f"{blob_name}.eval.json"
    return f"{blob_name[:-len('.json')]}.eval.json"


def normalize_prefix(prefix: str) -> str:
    trimmed = prefix.strip("/")
    return f"{trimmed}/" if trimmed else ""


def latest_inference_prefix(container: Any) -> str:
    run_folders = sorted(
        {blob.name.rsplit("/", 1)[0] for blob in container.list_blobs() if blob.name.endswith("/manifest.json")},
        key=run_folder_sort_key,
    )
    if not run_folders:
        raise RuntimeError("No inference run manifests found in INFERENCE_CONTAINER.")
    return f"{run_folders[-1]}/"


def run_folder_sort_key(run_folder: str) -> tuple[int, int | str]:
    leaf = PurePosixPath(run_folder).name
    return (1, int(leaf)) if leaf.isdigit() else (0, run_folder)


def is_inference_artifact_blob(blob_name: str) -> bool:
    if not blob_name.endswith(".json") or blob_name.endswith(".eval.json"):
        return False
    return PurePosixPath(blob_name).name != "manifest.json"


def evaluate_artifact(artifact: JsonValue, *, fact_judge: FactJudge, source_blob: str | None = None) -> dict[str, JsonValue]:
    evaluated_at = datetime.now(timezone.utc).isoformat()
    try:
        ground_truth = require_object(artifact, "ground_truth")
        inference = require_object(artifact, "inference")
        expected_output = ground_truth.get("output")
        actual_output = inference.get("output")
        paths = read_evaluation_paths(ground_truth)
        inference_status = inference.get("status")

        if inference_status != "completed":
            return evaluate_non_completed_artifact(
                source_blob=source_blob,
                evaluated_at=evaluated_at,
                inference=inference,
                expected_output=expected_output,
                actual_output=actual_output,
                paths=paths,
            )

        actual_record = actual_output
        metrics: dict[str, JsonValue] = {}
        metric_errors: dict[str, dict[str, str]] = {}
        collect_metrics(
            metrics,
            metric_errors,
            "generation",
            lambda: generation_metrics(expected_output, actual_output, paths.answer_path, fact_judge=fact_judge),
        )
        inference_timing = collect_metrics(metrics, metric_errors, "inference_timing", lambda: inference_timing_metrics(inference))
        if inference_timing:
            collect_metrics(metrics, metric_errors, "cost", lambda: evaluation_cost_metrics(inference_timing, fact_judge))
        collect_metrics(metrics, metric_errors, "retrieval_recall", lambda: retrieval_recall_metrics(expected_output, actual_output, paths))
        collect_metrics(
            metrics,
            metric_errors,
            "output_structure",
            lambda: {
                "output_structure": output_structure(
                    actual_record,
                    paths.output_schema,
                    paths.ignored_output_structure_issues,
                )
            },
        )
        judge = evaluation_judge_metadata(fact_judge)
        if not metrics:
            return {
                "source_blob": source_blob,
                "evaluated_at": evaluated_at,
                "status": "failed",
                "source_status": inference_status,
                "paths": paths_to_dict(paths),
                "metric_errors": metric_errors,
                "error": {"message": "No evaluation metrics could be computed.", "type": "ValueError"},
            }

        return {
            "source_blob": source_blob,
            "evaluated_at": evaluated_at,
            "status": "evaluated",
            "source_status": inference_status,
            **({"judge": judge} if judge else {}),
            "paths": paths_to_dict(paths),
            "metrics": metrics,
            **({"metric_errors": metric_errors} if metric_errors else {}),
        }
    except Exception as error:
        return {
            "source_blob": source_blob,
            "evaluated_at": evaluated_at,
            "status": "failed",
            "error": {"message": str(error), "type": error.__class__.__name__},
        }


def collect_metrics(
    metrics: dict[str, JsonValue],
    metric_errors: dict[str, dict[str, str]],
    name: str,
    producer: MetricProducer,
) -> dict[str, JsonValue]:
    try:
        produced = producer()
    except Exception as error:
        metric_errors[name] = {"message": str(error), "type": error.__class__.__name__}
        return {}
    metrics.update(produced)
    return produced


def evaluate_non_completed_artifact(
    *,
    source_blob: str | None,
    evaluated_at: str,
    inference: dict[str, JsonValue],
    expected_output: JsonValue,
    actual_output: JsonValue,
    paths: EvaluationPaths,
) -> dict[str, JsonValue]:
    actual_record = actual_output if isinstance(actual_output, dict) else {}
    return {
        "source_blob": source_blob,
        "evaluated_at": evaluated_at,
        "status": "evaluated",
        "source_status": inference.get("status"),
        "paths": paths_to_dict(paths),
        "metrics": {
            **retrieval_recall_metrics(expected_output, None, paths),
            **non_completed_generation_metrics(inference.get("status")),
            "output_structure": output_structure(
                actual_record,
                paths.output_schema,
                paths.ignored_output_structure_issues,
            ),
            **inference_timing_metrics(inference),
        },
    }


def non_completed_generation_metrics(source_status: JsonValue) -> dict[str, JsonValue]:
    method = f"source_{source_status}" if isinstance(source_status, str) and source_status else "source_not_completed"
    return {
        "generation_accuracy": {
            "numerator": 0,
            "denominator": 1,
            "score": 0.0,
            "method": method,
            "supported_fact_count": 0,
            "total_fact_count": 1,
            "inference_facts": [],
            "ground_truth_facts": [],
        },
        "generation_recall": {
            "numerator": 0,
            "denominator": 1,
            "score": 0.0,
            "method": method,
            "supported_ground_truth_fact_count": 0,
            "ground_truth_fact_count": 1,
        },
        "generation_precision": {
            "numerator": 0,
            "denominator": 1,
            "score": 0.0,
            "method": method,
            "supported_inference_fact_count": 0,
            "inference_fact_count": 1,
        },
    }


def require_object(value: JsonValue, key: str) -> dict[str, JsonValue]:
    if not isinstance(value, dict) or not isinstance(value.get(key), dict):
        raise ValueError(f"Artifact is missing object field: {key}")
    return value[key]


def read_evaluation_paths(ground_truth: dict[str, JsonValue]) -> EvaluationPaths:
    config = ground_truth.get("evaluation")
    if not isinstance(config, dict):
        return EvaluationPaths(
            evidence_path=DEFAULT_PATHS.evidence_path,
            answer_path=DEFAULT_PATHS.answer_path,
            evidence_key=DEFAULT_PATHS.evidence_key,
            output_schema=read_ground_truth_schema(ground_truth),
            ignored_output_structure_issues=DEFAULT_PATHS.ignored_output_structure_issues,
        )

    return EvaluationPaths(
        evidence_path=str(config.get("evidence_path", DEFAULT_PATHS.evidence_path)),
        answer_path=str(config.get("answer_path", DEFAULT_PATHS.answer_path)),
        evidence_key=read_evidence_key(config),
        output_schema=read_output_schema(config) or read_ground_truth_schema(ground_truth),
        ignored_output_structure_issues=read_ignored_output_structure_issues(config),
    )


def read_evidence_key(config: dict[str, JsonValue]) -> str | None:
    raw_key = config.get("evidence_key")
    if raw_key is None:
        return None
    if not isinstance(raw_key, str) or not raw_key.strip():
        raise ValueError("evaluation.evidence_key must be a non-empty string.")
    return raw_key.strip()


def read_output_schema(config: dict[str, JsonValue]) -> dict[str, JsonValue] | None:
    raw_schema = config.get("output_schema")
    if raw_schema is None:
        return None
    if not isinstance(raw_schema, dict):
        raise ValueError("evaluation.output_schema must be a JSON Schema object.")
    return raw_schema


def read_ignored_output_structure_issues(config: dict[str, JsonValue]) -> tuple[dict[str, str], ...]:
    raw_issues = config.get("ignored_output_structure_issues")
    if raw_issues is None:
        return ()
    if not isinstance(raw_issues, list):
        raise ValueError("evaluation.ignored_output_structure_issues must be an array.")

    issues: list[dict[str, str]] = []
    for index, raw_issue in enumerate(raw_issues):
        if not isinstance(raw_issue, dict):
            raise ValueError(f"evaluation.ignored_output_structure_issues[{index}] must be an object.")
        path = raw_issue.get("path")
        keyword = raw_issue.get("keyword")
        message = raw_issue.get("message")
        if not isinstance(path, str) or not path:
            raise ValueError(f"evaluation.ignored_output_structure_issues[{index}].path must be a non-empty string.")
        if not isinstance(keyword, str) or not keyword:
            raise ValueError(f"evaluation.ignored_output_structure_issues[{index}].keyword must be a non-empty string.")
        if message is not None and not isinstance(message, str):
            raise ValueError(f"evaluation.ignored_output_structure_issues[{index}].message must be a string when provided.")
        issue = {"path": path, "keyword": keyword}
        if message is not None:
            issue["message"] = message
        issues.append(issue)
    return tuple(issues)


def read_ground_truth_schema(ground_truth: dict[str, JsonValue]) -> dict[str, JsonValue] | None:
    raw_schema = ground_truth.get("schema")
    if raw_schema is None:
        return None
    if not isinstance(raw_schema, dict):
        raise ValueError("ground_truth.schema must be a JSON Schema object.")
    return raw_schema


def paths_to_dict(paths: EvaluationPaths) -> dict[str, JsonValue]:
    return {
        "evidence_path": paths.evidence_path,
        "answer_path": paths.answer_path,
        "evidence_key": paths.evidence_key,
        "has_output_schema": paths.output_schema is not None,
        "ignored_output_structure_issue_count": len(paths.ignored_output_structure_issues),
    }


def resolve_json_pointer(value: JsonValue, pointer: str) -> JsonValue:
    if pointer in ("", "/"):
        return value
    if not pointer.startswith("/"):
        raise ValueError(f"JSON pointer must start with '/': {pointer}")

    current = value
    for raw_part in pointer.split("/")[1:]:
        part = raw_part.replace("~1", "/").replace("~0", "~")
        if isinstance(current, dict):
            if part not in current:
                raise ValueError(f"JSON pointer not found: {pointer}")
            current = current[part]
        elif isinstance(current, list):
            if not part.isdigit():
                raise ValueError(f"JSON pointer list segment must be an index: {pointer}")
            index = int(part)
            if index >= len(current):
                raise ValueError(f"JSON pointer index out of range: {pointer}")
            current = current[index]
        else:
            raise ValueError(f"JSON pointer cannot traverse scalar value: {pointer}")
    return current


def as_list(value: JsonValue) -> list[JsonValue]:
    if isinstance(value, list):
        return value
    raise ValueError("Expected an evidence list.")


def as_text(value: JsonValue) -> str:
    if isinstance(value, str):
        return value
    raise ValueError("Expected an answer string.")


def resolve_answer_texts(value: JsonValue, pointer: str) -> list[str]:
    return [as_text(item) for item in resolve_json_pointer_many(value, pointer)]


def inference_timing_metrics(inference: dict[str, JsonValue]) -> dict[str, int | float]:
    total_elapsed_ms = as_non_negative_int(inference.get("elapsed_ms"), "inference.elapsed_ms")
    model_elapsed_ms = transcript_metadata_elapsed_ms(
        inference,
        "assistant-response",
        "assistantRequestElapsedMs",
    )
    tool_elapsed_ms = transcript_elapsed_ms(inference, "tool-call")
    cost = transcript_metadata_optional_number(inference, "assistant-response", "cost")
    metrics: dict[str, int | float] = {
        "meta_total_elapsed_ms": total_elapsed_ms,
        "meta_model_elapsed_ms": model_elapsed_ms,
        "meta_tool_elapsed_ms": tool_elapsed_ms,
        "meta_tool_call_count": transcript_count(inference, "tool-call"),
    }
    if cost is not None:
        metrics["meta_inference_cost"] = github_ai_credits_to_usd(cost)
    return metrics


def transcript_elapsed_ms(inference: dict[str, JsonValue], entry_type: str) -> int:
    transcript = inference.get("transcript", [])
    if not isinstance(transcript, list):
        raise ValueError("inference.transcript must be a list.")
    total = 0
    for index, entry in enumerate(transcript):
        if not isinstance(entry, dict):
            raise ValueError(f"inference.transcript[{index}] must be an object.")
        if entry.get("type") == entry_type:
            total += as_non_negative_int(entry.get("elapsed_ms"), f"inference.transcript[{index}].elapsed_ms")
    return total


def transcript_count(inference: dict[str, JsonValue], entry_type: str) -> int:
    transcript = inference.get("transcript", [])
    if not isinstance(transcript, list):
        raise ValueError("inference.transcript must be a list.")
    total = 0
    for index, entry in enumerate(transcript):
        if not isinstance(entry, dict):
            raise ValueError(f"inference.transcript[{index}] must be an object.")
        if entry.get("type") == entry_type:
            total += 1
    return total


def transcript_metadata_elapsed_ms(inference: dict[str, JsonValue], entry_type: str, metadata_key: str) -> int:
    transcript = inference.get("transcript", [])
    if not isinstance(transcript, list):
        raise ValueError("inference.transcript must be a list.")
    total = 0
    for index, entry in enumerate(transcript):
        if not isinstance(entry, dict):
            raise ValueError(f"inference.transcript[{index}] must be an object.")
        if entry.get("type") != entry_type:
            continue
        metadata = entry.get("metadata")
        if not isinstance(metadata, dict):
            raise ValueError(f"inference.transcript[{index}].metadata must be an object.")
        total += as_non_negative_int(
            metadata.get(metadata_key),
            f"inference.transcript[{index}].metadata.{metadata_key}",
        )
    return total


def transcript_metadata_optional_number(inference: dict[str, JsonValue], entry_type: str, metadata_key: str) -> float | None:
    transcript = inference.get("transcript", [])
    if not isinstance(transcript, list):
        raise ValueError("inference.transcript must be a list.")
    total = 0.0
    found = False
    for index, entry in enumerate(transcript):
        if not isinstance(entry, dict):
            raise ValueError(f"inference.transcript[{index}] must be an object.")
        if entry.get("type") != entry_type:
            continue
        metadata = entry.get("metadata")
        if not isinstance(metadata, dict):
            raise ValueError(f"inference.transcript[{index}].metadata must be an object.")
        value = metadata.get(metadata_key)
        if value is None:
            continue
        total += as_non_negative_number(value, f"inference.transcript[{index}].metadata.{metadata_key}")
        found = True
    return total if found else None


def as_non_negative_int(value: JsonValue, path: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{path} must be a non-negative integer.")
    return value


def as_non_negative_number(value: JsonValue, path: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float) or value < 0:
        raise ValueError(f"{path} must be a non-negative number.")
    return float(value)


def retrieval_recall_metrics(expected_output: JsonValue, actual_output: JsonValue | None, paths: EvaluationPaths) -> dict[str, JsonValue]:
    if paths.evidence_key is None:
        return {}
    expected_evidence_lists = resolve_evidence_lists(expected_output, paths.evidence_path)
    if actual_output is None:
        actual_evidence_lists = [[] for _ in expected_evidence_lists]
    else:
        actual_evidence_lists = resolve_evidence_lists(actual_output, paths.evidence_path)

    if len(expected_evidence_lists) == 1 and len(actual_evidence_lists) <= 1:
        actual_evidence = actual_evidence_lists[0] if actual_evidence_lists else []
        return {"retrieval_recall": retrieval_recall(expected_evidence_lists[0], actual_evidence, paths.evidence_key)}

    per_turn: list[dict[str, JsonValue]] = []
    for turn_index, expected_evidence in enumerate(expected_evidence_lists):
        actual_evidence = actual_evidence_lists[turn_index] if turn_index < len(actual_evidence_lists) else []
        turn_metric = retrieval_recall(expected_evidence, actual_evidence, paths.evidence_key)
        per_turn.append({"turn_index": turn_index, **turn_metric})

    score = 1.0 if not per_turn else sum(float(metric["score"]) for metric in per_turn) / len(per_turn)
    return {
        "retrieval_recall": {
            "score": round(score, 6),
            "method": "per_turn_macro_average",
            "turn_count": len(per_turn),
            "expected_evidence_count": sum(int(metric["expected_evidence_count"]) for metric in per_turn),
            "actual_evidence_count": sum(int(metric["actual_evidence_count"]) for metric in per_turn),
            "retrieved_relevant_count": sum(int(metric["retrieved_relevant_count"]) for metric in per_turn),
            "per_turn": per_turn,
        }
    }


def resolve_evidence_lists(value: JsonValue, pointer: str) -> list[list[JsonValue]]:
    resolved = resolve_json_pointer_many(value, pointer)
    return [as_list(item) for item in resolved]


def resolve_json_pointer_many(value: JsonValue, pointer: str) -> list[JsonValue]:
    if "*" not in pointer:
        return [resolve_json_pointer(value, pointer)]
    if not pointer.startswith("/"):
        raise ValueError(f"JSON pointer must start with '/': {pointer}")

    current_values: list[JsonValue] = [value]
    for raw_part in pointer.split("/")[1:]:
        part = raw_part.replace("~1", "/").replace("~0", "~")
        next_values: list[JsonValue] = []
        if part == "*":
            for current in current_values:
                if not isinstance(current, list):
                    raise ValueError(f"JSON pointer wildcard segment requires a list: {pointer}")
                next_values.extend(current)
            current_values = next_values
            continue

        for current in current_values:
            if isinstance(current, dict):
                if part not in current:
                    raise ValueError(f"JSON pointer not found: {pointer}")
                next_values.append(current[part])
            elif isinstance(current, list):
                if not part.isdigit():
                    raise ValueError(f"JSON pointer list segment must be an index: {pointer}")
                index = int(part)
                if index >= len(current):
                    raise ValueError(f"JSON pointer index out of range: {pointer}")
                next_values.append(current[index])
            else:
                raise ValueError(f"JSON pointer cannot traverse scalar value: {pointer}")
        current_values = next_values

    return current_values


def retrieval_recall(expected_evidence: list[JsonValue], actual_evidence: list[JsonValue], evidence_key: str) -> dict[str, JsonValue]:
    expected_keys = evidence_identities(expected_evidence, evidence_key, include_missing_configured_key=True)
    actual_keys = evidence_identities(actual_evidence, evidence_key, include_missing_configured_key=False)
    matched = len(expected_keys & actual_keys)
    total = len(expected_keys)
    score = 1.0 if total == 0 else matched / total
    return {
        "score": round(score, 6),
        "expected_evidence_count": total,
        "actual_evidence_count": len(actual_keys),
        "retrieved_relevant_count": matched,
        "missing_evidence": sorted(expected_keys - actual_keys),
    }


def evidence_identities(evidence: list[JsonValue], evidence_key: str, *, include_missing_configured_key: bool) -> set[str]:
    identities: set[str] = set()
    for index, item in enumerate(evidence):
        identity = evidence_identity(item, evidence_key)
        if identity:
            identities.add(identity)
        elif include_missing_configured_key:
            identities.add(f"{evidence_key}:<missing:{index}>")
    return identities


def evidence_identity(item: JsonValue, evidence_key: str) -> str:
    if isinstance(item, dict):
        value = item.get(evidence_key)
        return f"{evidence_key}:{value.strip().lower()}" if isinstance(value, str) and value.strip() else ""
    return ""


class CopilotSdkFactJudge:
    def __init__(self, *, repo_root: Path | None = None, timeout_seconds: int | None = None):
        self.repo_root = repo_root or Path.cwd()
        self.timeout_seconds = timeout_seconds or int(os.environ.get("EVALUATION_JUDGE_TIMEOUT_SECONDS", str(DEFAULT_JUDGE_TIMEOUT_SECONDS)))
        self.model = require_env("AGENT_MODEL")
        self.used_models: set[str] = set()
        self.cost = 0.0

    def __call__(self, expected_answer: str, actual_answer: str) -> dict[str, JsonValue]:
        return asyncio.run(self.evaluate(expected_answer, actual_answer))

    def judge_with_feedback(self, expected_answer: str, actual_answer: str, retry_feedback: str) -> dict[str, JsonValue]:
        return asyncio.run(self.evaluate(expected_answer, actual_answer, retry_feedback=retry_feedback))

    async def evaluate(
        self,
        expected_answer: str,
        actual_answer: str,
        *,
        retry_feedback: str | None = None,
    ) -> dict[str, JsonValue]:
        try:
            return await asyncio.wait_for(
                self.evaluate_with_copilot(expected_answer, actual_answer, retry_feedback=retry_feedback),
                timeout=self.timeout_seconds,
            )
        except TimeoutError as error:
            raise RuntimeError(f"Copilot SDK fact judge timed out after {self.timeout_seconds} seconds.") from error

    async def evaluate_with_copilot(
        self,
        expected_answer: str,
        actual_answer: str,
        *,
        retry_feedback: str | None = None,
    ) -> dict[str, JsonValue]:
        from copilot import CopilotClient
        from copilot.session import PermissionHandler
        from copilot.session_events import AssistantMessageData, AssistantMessageDeltaData, AssistantUsageData, SessionIdleData

        judge_request = build_judge_request(expected_answer, actual_answer, retry_feedback=retry_feedback)
        done = asyncio.Event()
        chunks: list[str] = []

        def on_event(event: object) -> None:
            data = getattr(event, "data", None)
            if isinstance(data, AssistantMessageDeltaData):
                chunks.append(data.delta_content or "")
            elif isinstance(data, AssistantMessageData):
                if not chunks:
                    chunks.append(data.content or "")
            elif isinstance(data, SessionIdleData):
                done.set()
            elif isinstance(data, AssistantUsageData):
                if data.cost is not None:
                    self.cost += data.cost
            model = getattr(data, "model", None)
            if isinstance(model, str) and model.strip():
                self.used_models.add(model.strip())

        client_options = {
            "working_directory": str(self.repo_root),
            "github_token": os.environ.get("COPILOT_GITHUB_TOKEN") or None,
            "env": dict(os.environ),
        }
        session_options = {
            "on_permission_request": PermissionHandler.approve_all,
            "client_name": "review-assistant-evaluation",
            "streaming": True,
            "tools": [],
            "available_tools": [],
            "skip_custom_instructions": True,
            "custom_agents_local_only": True,
            "coauthor_enabled": False,
            "manage_schedule_enabled": False,
            "request_extensions": False,
            "request_canvas_renderer": False,
            "enable_mcp_apps": False,
            "infinite_sessions": {"enabled": False},
            "large_output": {"enabled": False},
            "mcp_oauth_token_storage": "in-memory",
            "on_event": on_event,
        }
        reasoning_effort = optional_env("REASONING_EFFORT")
        session_options["model"] = self.model
        if reasoning_effort is not None:
            session_options["reasoning_effort"] = reasoning_effort

        async with CopilotClient(**client_options) as client:
            async with await client.create_session(**session_options) as session:
                await session.send(
                    "\n\n".join(
                        [
                            "You are a strict Review Assistant evaluation judge.",
                            "Return only valid JSON matching the requested schema. Do not include Markdown.",
                            json.dumps(judge_request, indent=2, sort_keys=True),
                        ]
                    )
                )
                await done.wait()

        return parse_judge_response_content("".join(chunks))


def create_fact_judge_from_env() -> CopilotSdkFactJudge:
    return CopilotSdkFactJudge()


def evaluation_judge_metadata(fact_judge: FactJudge) -> dict[str, JsonValue]:
    configured_model = getattr(fact_judge, "model", None)
    if not isinstance(configured_model, str) or not configured_model.strip():
        return {}
    model = configured_model.strip()
    raw_models = getattr(fact_judge, "used_models", None)
    if raw_models is None:
        return {"model": model}
    if not isinstance(raw_models, (set, list, tuple)):
        return {"model": model}
    models = sorted({model.strip() for model in raw_models if isinstance(model, str) and model.strip()})
    unexpected_models = [observed_model for observed_model in models if observed_model != model]
    if unexpected_models:
        raise RuntimeError(
            f"Evaluation judge used unexpected model(s): {', '.join(unexpected_models)}. Expected AGENT_MODEL={model}."
        )
    return {"model": model}


def evaluation_cost_metrics(inference_metrics: dict[str, int | float], fact_judge: FactJudge) -> dict[str, float]:
    metrics: dict[str, float] = {}
    inference_cost = inference_metrics.get("meta_inference_cost")
    if isinstance(inference_cost, int | float) and not isinstance(inference_cost, bool):
        metrics["meta_inference_cost"] = float(inference_cost)
    judge_cost = getattr(fact_judge, "cost", None)
    if isinstance(judge_cost, int | float) and not isinstance(judge_cost, bool):
        metrics["meta_evaluation_cost"] = github_ai_credits_to_usd(float(judge_cost))
    return metrics


def github_ai_credits_to_usd(credits: float) -> float:
    return float(Decimal(str(credits)) * github_ai_credit_usd_rate())


def github_ai_credit_usd_rate() -> Decimal:
    raw_rate = os.environ.get(GITHUB_AI_CREDIT_USD_ENV)
    if raw_rate is None or not raw_rate.strip():
        return DEFAULT_GITHUB_AI_CREDIT_USD
    try:
        rate = Decimal(raw_rate.strip())
    except InvalidOperation as error:
        raise ValueError(f"{GITHUB_AI_CREDIT_USD_ENV} must be a positive decimal number.") from error
    if not rate.is_finite() or rate <= 0:
        raise ValueError(f"{GITHUB_AI_CREDIT_USD_ENV} must be a positive decimal number.")
    return rate


def parse_judge_response_content(content: str) -> dict[str, JsonValue]:
    if not content.strip():
        raise ValueError("Fact judge response content must be a non-empty JSON string.")
    try:
        parsed = json.loads(strip_json_code_fence(content))
    except json.JSONDecodeError as error:
        raise ValueError(f"Fact judge response content is invalid JSON: {error}") from error
    if not isinstance(parsed, dict):
        raise ValueError("Fact judge response content must decode to a JSON object.")
    return parsed


def strip_json_code_fence(content: str) -> str:
    stripped = content.strip()
    match = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", stripped, flags=re.DOTALL)
    return match.group(1).strip() if match else stripped


def build_judge_request(
    expected_answer: str,
    actual_answer: str,
    *,
    retry_feedback: str | None = None,
) -> dict[str, JsonValue]:
    request = {
        "schema_version": JUDGE_SCHEMA_VERSION,
        "task": "Extract comparable facts from both answers, then judge material equivalence of each ground-truth fact.",
        "instructions": textwrap.dedent(
            """
            Use the same extraction rubric for ground_truth_facts and inference_facts.
            Extract complete, answer-level facts: each fact should be independently checkable and include the necessary subject,
            predicate, object, and important qualifiers. Do not split a single answer point into tiny phrase fragments.
            Compare meaning, not exact wording. Mark a ground-truth fact equivalent when the inference materially asserts the
            same claim, partial when it covers only part of the claim or omits an important qualifier, contradicted when it
            conflicts, and missing when no inference fact supports it. Use an empty inference_fact_ids array for missing facts.
            For no-results search answers, treat "no official/source rule exists or was found" as materially supporting
            "no supporting evidence was found or recorded" when the answer's evidence is sourced from those rules.
            Return only JSON matching the requested schema. Do not include Markdown.
            """
        ).strip(),
        "expected_answer": expected_answer,
        "actual_answer": actual_answer,
        "output_schema": {
            "type": "object",
            "required": ["schema_version", "ground_truth_facts", "inference_facts", "comparisons"],
            "properties": {
                "schema_version": {"const": JUDGE_SCHEMA_VERSION},
                "ground_truth_facts": {
                    "type": "array",
                    "items": {"type": "object", "required": ["id", "fact"], "properties": {"id": {"type": "string"}, "fact": {"type": "string"}}},
                },
                "inference_facts": {
                    "type": "array",
                    "items": {"type": "object", "required": ["id", "fact"], "properties": {"id": {"type": "string"}, "fact": {"type": "string"}}},
                },
                "comparisons": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["ground_truth_fact_id", "inference_fact_ids", "label", "rationale"],
                        "properties": {
                            "ground_truth_fact_id": {"type": "string"},
                            "inference_fact_ids": {"type": "array", "items": {"type": "string"}},
                            "label": {"enum": ["equivalent", "partial", "missing", "contradicted"]},
                            "rationale": {"type": "string"},
                        },
                    },
                },
            },
        },
    }
    if retry_feedback is not None:
        request["retry_feedback"] = retry_feedback
    return request


def generation_metrics_for_answers(expected_answer: str, actual_answer: str, *, fact_judge: FactJudge) -> dict[str, JsonValue]:
    retry_feedback = None
    last_judge_output = None
    for attempt in range(1, JUDGE_RETRY_ATTEMPTS + 1):
        try:
            judge_output = call_fact_judge(
                fact_judge,
                expected_answer,
                actual_answer,
                retry_feedback=retry_feedback,
            )
            last_judge_output = judge_output
            return judge_generation_metrics(judge_output)
        except RepairableJudgeOutputError as error:
            if attempt >= JUDGE_RETRY_ATTEMPTS:
                if last_judge_output is None:
                    raise
                return judge_generation_metrics(last_judge_output, normalize_repairable=True)
            retry_feedback = judge_retry_feedback(error)
        except ValueError as error:
            if attempt >= JUDGE_RETRY_ATTEMPTS or not is_retryable_judge_error(error):
                raise
            retry_feedback = judge_retry_feedback(error)
    raise RuntimeError("Fact judge retry loop exited unexpectedly.")


def call_fact_judge(
    fact_judge: FactJudge,
    expected_answer: str,
    actual_answer: str,
    *,
    retry_feedback: str | None,
) -> dict[str, JsonValue]:
    if retry_feedback is not None:
        retry_method = getattr(fact_judge, "judge_with_feedback", None)
        if callable(retry_method):
            return retry_method(expected_answer, actual_answer, retry_feedback)
    return fact_judge(expected_answer, actual_answer)


def is_retryable_judge_error(error: ValueError) -> bool:
    return str(error).startswith("Fact judge ")


def judge_retry_feedback(error: ValueError) -> str:
    return textwrap.dedent(
        f"""
        Your previous response could not be used: {error}
        Return only a corrected JSON object matching the schema. Do not include Markdown or prose.
        Every ground_truth_fact must have exactly one comparison. For a comparison labeled missing, use an empty inference_fact_ids array.
        For equivalent, partial, or contradicted comparisons, include the relevant inference_fact_ids.
        """
    ).strip()


def generation_metrics(
    expected_output: JsonValue,
    actual_output: JsonValue,
    answer_path: str,
    *,
    fact_judge: FactJudge,
) -> dict[str, JsonValue]:
    expected_answers = resolve_answer_texts(expected_output, answer_path)
    actual_answers = resolve_answer_texts(actual_output, answer_path)

    if len(expected_answers) == 1 and len(actual_answers) <= 1:
        actual_answer = actual_answers[0] if actual_answers else ""
        return generation_metrics_for_answers(expected_answers[0], actual_answer, fact_judge=fact_judge)

    per_turn_generation_metrics = []
    for turn_index, expected_answer in enumerate(expected_answers):
        actual_answer = actual_answers[turn_index] if turn_index < len(actual_answers) else ""
        per_turn_generation_metrics.append(
            {"turn_index": turn_index, **generation_metrics_for_answers(expected_answer, actual_answer, fact_judge=fact_judge)}
        )

    return {
        "generation_accuracy": aggregate_generation_metric("generation_accuracy", per_turn_generation_metrics),
        "generation_recall": aggregate_generation_metric("generation_recall", per_turn_generation_metrics),
        "generation_precision": aggregate_generation_metric("generation_precision", per_turn_generation_metrics),
    }


def aggregate_generation_metric(metric_name: str, per_turn_generation_metrics: list[dict[str, JsonValue]]) -> dict[str, JsonValue]:
    per_turn_metrics: list[dict[str, JsonValue]] = []
    for entry in per_turn_generation_metrics:
        turn_index = entry.get("turn_index")
        turn_metric = entry.get(metric_name)
        if isinstance(turn_index, int) and isinstance(turn_metric, dict):
            per_turn_metrics.append({"turn_index": turn_index, **turn_metric})

    score = 1.0 if not per_turn_metrics else sum(float(metric["score"]) for metric in per_turn_metrics) / len(per_turn_metrics)
    aggregated: dict[str, JsonValue] = {
        "score": round(score, 6),
        "method": "per_turn_macro_average",
        "turn_count": len(per_turn_metrics),
        "numerator": sum(int(metric["numerator"]) for metric in per_turn_metrics if isinstance(metric.get("numerator"), int)),
        "denominator": sum(
            int(metric["denominator"]) for metric in per_turn_metrics if isinstance(metric.get("denominator"), int)
        ),
        "per_turn": per_turn_metrics,
    }

    schema_versions = {
        metric.get("schema_version") for metric in per_turn_metrics if isinstance(metric.get("schema_version"), str)
    }
    if len(schema_versions) == 1:
        aggregated["schema_version"] = next(iter(schema_versions))

    if metric_name == "generation_accuracy":
        aggregated["supported_fact_count"] = sum(
            int(metric["supported_fact_count"])
            for metric in per_turn_metrics
            if isinstance(metric.get("supported_fact_count"), int)
        )
        aggregated["total_fact_count"] = sum(
            int(metric["total_fact_count"])
            for metric in per_turn_metrics
            if isinstance(metric.get("total_fact_count"), int)
        )
    elif metric_name == "generation_recall":
        aggregated["supported_ground_truth_fact_count"] = sum(
            int(metric["supported_ground_truth_fact_count"])
            for metric in per_turn_metrics
            if isinstance(metric.get("supported_ground_truth_fact_count"), int)
        )
        aggregated["ground_truth_fact_count"] = sum(
            int(metric["ground_truth_fact_count"])
            for metric in per_turn_metrics
            if isinstance(metric.get("ground_truth_fact_count"), int)
        )
    elif metric_name == "generation_precision":
        aggregated["supported_inference_fact_count"] = sum(
            int(metric["supported_inference_fact_count"])
            for metric in per_turn_metrics
            if isinstance(metric.get("supported_inference_fact_count"), int)
        )
        aggregated["inference_fact_count"] = sum(
            int(metric["inference_fact_count"])
            for metric in per_turn_metrics
            if isinstance(metric.get("inference_fact_count"), int)
        )

    return aggregated


def judge_generation_metrics(
    judge_output: dict[str, JsonValue],
    *,
    normalize_repairable: bool = False,
) -> dict[str, JsonValue]:
    ground_truth_facts = parse_judge_facts(judge_output, "ground_truth_facts")
    inference_facts = parse_judge_facts(judge_output, "inference_facts")
    comparisons = parse_judge_comparisons(
        judge_output,
        ground_truth_facts,
        inference_facts,
        normalize_repairable=normalize_repairable,
    )
    used_inference_fact_ids = {
        inference_fact_id
        for comparison in comparisons
        if comparison["label"] in {"equivalent", "partial"}
        for inference_fact_id in comparison["inference_fact_ids"]
    }
    supported_ground_truth_fact_ids = {
        comparison["ground_truth_fact_id"]
        for comparison in comparisons
        if comparison["label"] in {"equivalent", "partial"}
    }

    generation_accuracy = generation_metric(
        numerator=len(supported_ground_truth_fact_ids) + len(used_inference_fact_ids),
        denominator=len(ground_truth_facts) + len(inference_facts),
    )
    return {
        "generation_accuracy": {
            **generation_accuracy,
            "method": "agent_judge",
            "schema_version": JUDGE_SCHEMA_VERSION,
            "supported_fact_count": len(supported_ground_truth_fact_ids) + len(used_inference_fact_ids),
            "total_fact_count": len(ground_truth_facts) + len(inference_facts),
            "inference_facts": [
                {
                    "id": fact["id"],
                    "fact": fact["fact"],
                    "supported_by_ground_truth": fact["id"] in used_inference_fact_ids,
                }
                for fact in inference_facts.values()
            ],
            "ground_truth_facts": [
                {
                    "id": fact["id"],
                    "fact": fact["fact"],
                    "supported_by_inference": fact["id"] in supported_ground_truth_fact_ids,
                }
                for fact in ground_truth_facts.values()
            ],
        },
        "generation_recall": {
            **generation_metric(numerator=len(supported_ground_truth_fact_ids), denominator=len(ground_truth_facts)),
            "method": "agent_judge",
            "schema_version": JUDGE_SCHEMA_VERSION,
            "supported_ground_truth_fact_count": len(supported_ground_truth_fact_ids),
            "ground_truth_fact_count": len(ground_truth_facts),
        },
        "generation_precision": {
            **generation_metric(numerator=len(used_inference_fact_ids), denominator=len(inference_facts)),
            "method": "agent_judge",
            "schema_version": JUDGE_SCHEMA_VERSION,
            "supported_inference_fact_count": len(used_inference_fact_ids),
            "inference_fact_count": len(inference_facts),
        },
    }


def generation_metric(*, numerator: int, denominator: int) -> dict[str, JsonValue]:
    return {
        "numerator": numerator,
        "denominator": denominator,
        "score": round(1.0 if denominator == 0 else numerator / denominator, 6),
    }


def publish_experiment_catalog_result(
    config: ExperimentCatalogConfig,
    source: JsonValue,
    evaluation_result: dict[str, JsonValue],
    *,
    set_name: str,
    inference_uri: str,
    evaluation_uri: str,
) -> None:
    inference = require_object(source, "inference")
    payload = {
        "ref": require_string_field(inference, "ref"),
        "set": set_name,
        "inference_uri": inference_uri,
        "evaluation_uri": evaluation_uri,
        "metrics": experiment_catalog_metrics(evaluation_result),
    }
    post_json(experiment_catalog_results_url(config), payload)


def inference_run_folder(source: JsonValue) -> str:
    return require_string_field(require_object(source, "inference"), "run_folder")


def next_experiment_catalog_set(config: ExperimentCatalogConfig, run_folder: str) -> str:
    return next_suffixed_set_name(run_folder, list_experiment_catalog_sets(config))


def list_experiment_catalog_sets(config: ExperimentCatalogConfig) -> list[str]:
    value = get_json(experiment_catalog_sets_url(config))
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError("Experiment Catalog sets response must be a string list.")
    return value


def next_suffixed_set_name(run_folder: str, existing_sets: list[str]) -> str:
    prefix = f"{run_folder}-"
    suffixes = [set_name.removeprefix(prefix) for set_name in existing_sets if set_name.startswith(prefix)]
    used_indexes = [suffix_to_index(suffix) for suffix in suffixes if re.fullmatch(r"[A-Z]+", suffix)]
    return f"{run_folder}-{index_to_suffix(max(used_indexes, default=0) + 1)}"


def suffix_to_index(suffix: str) -> int:
    value = 0
    for char in suffix:
        value = (value * 26) + (ord(char) - ord("A") + 1)
    return value


def index_to_suffix(index: int) -> str:
    if index <= 0:
        raise ValueError("Suffix index must be positive.")
    chars = []
    value = index
    while value > 0:
        value -= 1
        chars.append(chr(ord("A") + (value % 26)))
        value //= 26
    return "".join(reversed(chars))


def experiment_catalog_results_url(config: ExperimentCatalogConfig) -> str:
    return urllib.parse.urljoin(
        experiment_catalog_api_base_url(config.base_url),
        f"projects/{urllib.parse.quote(config.project, safe='')}/experiments/{urllib.parse.quote(config.experiment, safe='')}/results",
    )


def experiment_catalog_sets_url(config: ExperimentCatalogConfig) -> str:
    return urllib.parse.urljoin(
        experiment_catalog_api_base_url(config.base_url),
        f"projects/{urllib.parse.quote(config.project, safe='')}/experiments/{urllib.parse.quote(config.experiment, safe='')}/sets",
    )


def experiment_catalog_api_base_url(base_url: str) -> str:
    parsed = urllib.parse.urlsplit(base_url)
    if not parsed.scheme or not parsed.netloc:
        raise ValueError("EXPERIMENT_CATALOG_URL must be an absolute URL.")
    path = parsed.path.rstrip("/")
    if not path.endswith("/api"):
        path = f"{path}/api"
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, f"{path}/", "", ""))


def experiment_catalog_metrics(evaluation_result: dict[str, JsonValue]) -> dict[str, int | float]:
    raw_metrics = evaluation_result.get("metrics")
    if not isinstance(raw_metrics, dict):
        raise ValueError("Evaluation result metrics must be an object before publishing to Experiment Catalog.")
    return {key: experiment_catalog_metric_value(key, value) for key, value in raw_metrics.items()}


def experiment_catalog_metric_value(key: str, value: JsonValue) -> int | float:
    if isinstance(value, bool):
        raise ValueError(f"Experiment Catalog metric {key} must be numeric.")
    if isinstance(value, int | float):
        return value
    if isinstance(value, dict):
        score = value.get("score")
        if isinstance(score, bool) or not isinstance(score, int | float):
            raise ValueError(f"Experiment Catalog metric {key} must include a numeric score.")
        return score
    raise ValueError(f"Experiment Catalog metric {key} must be numeric or include a numeric score.")


def require_string_field(value: dict[str, JsonValue], key: str) -> str:
    field = value.get(key)
    if not isinstance(field, str) or not field.strip():
        raise ValueError(f"inference.{key} must be a non-empty string for Experiment Catalog publishing.")
    return field.strip()


def post_json(url: str, payload: dict[str, JsonValue]) -> None:
    body = json.dumps(payload, sort_keys=True).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST", headers={"Content-Type": "application/json"})
    request_experiment_catalog(request, failure_message="Experiment Catalog metrics push failed")


def request_experiment_catalog(request: urllib.request.Request, *, failure_message: str) -> bytes:
    for attempt in range(1, EXPERIMENT_CATALOG_RETRY_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(
                request,
                timeout=EXPERIMENT_CATALOG_HTTP_TIMEOUT_SECONDS,
                context=https_context(),
            ) as response:
                status = response.getcode()
                body = response.read()
                if status < 200 or status >= 300:
                    if should_retry_experiment_catalog_status(status, attempt):
                        sleep_before_experiment_catalog_retry(attempt)
                        continue
                    raise RuntimeError(f"{failure_message} with HTTP {status}: {decode_response_body(body)}")
                return body
        except urllib.error.HTTPError as error:
            if should_retry_experiment_catalog_status(error.code, attempt):
                sleep_before_experiment_catalog_retry(attempt)
                continue
            raise RuntimeError(f"{failure_message} with HTTP {error.code}: {decode_response_body(error.read())}") from error
        except urllib.error.URLError as error:
            if should_retry_experiment_catalog_attempt(attempt):
                sleep_before_experiment_catalog_retry(attempt)
                continue
            raise RuntimeError(f"{failure_message}: {error.reason}") from error
        except TimeoutError as error:
            if should_retry_experiment_catalog_attempt(attempt):
                sleep_before_experiment_catalog_retry(attempt)
                continue
            raise RuntimeError(f"{failure_message}: {error}") from error
    raise RuntimeError(f"{failure_message}: retry attempts exhausted.")


def should_retry_experiment_catalog_status(status: int, attempt: int) -> bool:
    return should_retry_experiment_catalog_attempt(attempt) and (
        status in EXPERIMENT_CATALOG_RETRYABLE_STATUS_CODES or status >= 500
    )


def should_retry_experiment_catalog_attempt(attempt: int) -> bool:
    return attempt < EXPERIMENT_CATALOG_RETRY_ATTEMPTS


def sleep_before_experiment_catalog_retry(attempt: int) -> None:
    time.sleep(EXPERIMENT_CATALOG_RETRY_DELAY_SECONDS * attempt)


def decode_response_body(body: bytes) -> str:
    return body.decode("utf-8", errors="replace")


def get_json(url: str) -> JsonValue:
    request = urllib.request.Request(url, method="GET")
    try:
        body = request_experiment_catalog(request, failure_message="Experiment Catalog request failed")
        return json.loads(body.decode("utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"Experiment Catalog response was not valid JSON: {error}") from error


def https_context() -> ssl.SSLContext:
    if certifi is not None and not os.environ.get("SSL_CERT_FILE"):
        return ssl.create_default_context(cafile=certifi.where())
    return ssl.create_default_context()


def parse_judge_facts(judge_output: dict[str, JsonValue], key: str) -> dict[str, dict[str, str]]:
    raw_facts = judge_output.get(key)
    if not isinstance(raw_facts, list):
        raise ValueError(f"Fact judge output must include a {key} list.")
    facts: dict[str, dict[str, str]] = {}
    for index, raw_fact in enumerate(raw_facts):
        if not isinstance(raw_fact, dict):
            raise ValueError(f"Fact judge {key}[{index}] must be an object.")
        fact_id = raw_fact.get("id")
        fact = raw_fact.get("fact")
        if not isinstance(fact_id, str) or not fact_id.strip():
            raise ValueError(f"Fact judge {key}[{index}].id must be a non-empty string.")
        if not isinstance(fact, str) or not fact.strip():
            raise ValueError(f"Fact judge {key}[{index}].fact must be a non-empty string.")
        if fact_id in facts:
            raise ValueError(f"Fact judge {key} contains duplicate id: {fact_id}")
        facts[fact_id] = {"id": fact_id, "fact": fact.strip()}
    return facts


def parse_judge_comparisons(
    judge_output: dict[str, JsonValue],
    ground_truth_facts: dict[str, dict[str, str]],
    inference_facts: dict[str, dict[str, str]],
    *,
    normalize_repairable: bool = False,
) -> list[dict[str, JsonValue]]:
    if judge_output.get("schema_version") != JUDGE_SCHEMA_VERSION:
        raise ValueError(f"Fact judge output schema_version must be {JUDGE_SCHEMA_VERSION}.")
    raw_comparisons = judge_output.get("comparisons")
    if not isinstance(raw_comparisons, list):
        raise ValueError("Fact judge output must include a comparisons list.")

    comparisons = []
    seen_ground_truth_ids = set()
    for index, raw_comparison in enumerate(raw_comparisons):
        if not isinstance(raw_comparison, dict):
            raise ValueError(f"Fact judge comparisons[{index}] must be an object.")
        ground_truth_fact_id = raw_comparison.get("ground_truth_fact_id")
        inference_fact_ids = raw_comparison.get("inference_fact_ids")
        label = raw_comparison.get("label")
        rationale = raw_comparison.get("rationale")
        if not isinstance(ground_truth_fact_id, str) or ground_truth_fact_id not in ground_truth_facts:
            raise ValueError(f"Fact judge comparisons[{index}].ground_truth_fact_id is unknown.")
        if ground_truth_fact_id in seen_ground_truth_ids:
            raise ValueError(f"Fact judge comparisons has multiple entries for ground truth fact: {ground_truth_fact_id}")
        if not isinstance(inference_fact_ids, list) or not all(isinstance(value, str) for value in inference_fact_ids):
            raise ValueError(f"Fact judge comparisons[{index}].inference_fact_ids must be a string list.")
        if label not in JUDGE_LABEL_SCORES:
            raise ValueError(f"Fact judge comparisons[{index}].label is invalid: {label}")
        if label == "missing" and inference_fact_ids:
            if not normalize_repairable:
                raise RepairableJudgeOutputError(
                    f"Fact judge comparisons[{index}] must not include inference_fact_ids for missing facts."
                )
            inference_fact_ids = []
        unknown_inference_ids = [value for value in inference_fact_ids if value not in inference_facts]
        if unknown_inference_ids:
            raise ValueError(f"Fact judge comparisons[{index}] references unknown inference fact ids: {unknown_inference_ids}")
        if label in {"equivalent", "partial", "contradicted"} and not inference_fact_ids:
            raise ValueError(f"Fact judge comparisons[{index}] requires inference_fact_ids for label {label}.")
        if not isinstance(rationale, str) or not rationale.strip():
            raise ValueError(f"Fact judge comparisons[{index}].rationale must be a non-empty string.")
        seen_ground_truth_ids.add(ground_truth_fact_id)
        comparisons.append(
            {
                "ground_truth_fact_id": ground_truth_fact_id,
                "inference_fact_ids": inference_fact_ids,
                "label": label,
                "rationale": rationale.strip(),
            }
        )

    missing_comparison_ids = set(ground_truth_facts) - seen_ground_truth_ids
    if missing_comparison_ids:
        raise ValueError(f"Fact judge output is missing comparisons for ground truth facts: {sorted(missing_comparison_ids)}")
    return comparisons


def output_structure(
    actual_record: JsonValue,
    output_schema: dict[str, JsonValue] | None,
    ignored_issues: tuple[dict[str, str], ...] = (),
) -> dict[str, JsonValue]:
    if output_schema is None:
        issues = [{"path": "/", "keyword": "schema", "message": "No ground_truth.schema or evaluation.output_schema configured."}]
    else:
        issues = validate_json_schema(output_schema, actual_record)
    ignored, active = partition_ignored_output_structure_issues(issues, ignored_issues)
    metric: dict[str, JsonValue] = {
        "score": 1.0 if not active else 0.0,
        "valid": not active,
        "issue_count": len(active),
        "issues": active,
    }
    if ignored:
        metric["ignored_issue_count"] = len(ignored)
        metric["ignored_issues"] = ignored
    return metric


def partition_ignored_output_structure_issues(
    issues: list[dict[str, str]],
    ignored_issues: tuple[dict[str, str], ...],
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    ignored: list[dict[str, str]] = []
    active: list[dict[str, str]] = []
    for issue in issues:
        if any(output_structure_issue_matches(issue, ignored_issue) for ignored_issue in ignored_issues):
            ignored.append(issue)
        else:
            active.append(issue)
    return ignored, active


def output_structure_issue_matches(issue: dict[str, str], ignored_issue: dict[str, str]) -> bool:
    if issue.get("path") != ignored_issue.get("path"):
        return False
    if issue.get("keyword") != ignored_issue.get("keyword"):
        return False
    ignored_message = ignored_issue.get("message")
    if ignored_message is not None and issue.get("message") != ignored_message:
        return False
    return True


def validate_json_schema(schema: JsonValue, value: JsonValue, path: str = "/") -> list[dict[str, str]]:
    if not isinstance(schema, dict):
        return [{"path": path, "keyword": "schema", "message": "Schema node must be an object."}]

    issues: list[dict[str, str]] = []
    schema_type = schema.get("type")
    if schema_type is not None and not json_schema_type_matches(value, schema_type):
        return [
            {
                "path": path,
                "keyword": "type",
                "message": f"Expected {format_schema_type(schema_type)}, got {json_value_type(value)}.",
            }
        ]

    if isinstance(value, dict):
        issues.extend(validate_object_schema(schema, value, path))
    if isinstance(value, list):
        issues.extend(validate_array_schema(schema, value, path))
    return issues


def validate_object_schema(schema: dict[str, JsonValue], value: dict[str, JsonValue], path: str) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    properties = schema.get("properties")
    property_schemas = properties if isinstance(properties, dict) else {}
    required = schema.get("required")
    if required is not None and not isinstance(required, list):
        issues.append({"path": path, "keyword": "required", "message": "Schema required must be an array."})
    else:
        for key in required or []:
            if not isinstance(key, str):
                issues.append({"path": path, "keyword": "required", "message": "Schema required entries must be strings."})
            elif key not in value:
                issues.append({"path": path, "keyword": "required", "message": f"Missing required property: {key}."})

    for key, child in value.items():
        child_path = child_json_pointer(path, key)
        child_schema = property_schemas.get(key)
        if child_schema is not None:
            issues.extend(validate_json_schema(child_schema, child, child_path))
        elif schema.get("additionalProperties") is False:
            issues.append({"path": child_path, "keyword": "additionalProperties", "message": f"Unexpected property: {key}."})
    return issues


def validate_array_schema(schema: dict[str, JsonValue], value: list[JsonValue], path: str) -> list[dict[str, str]]:
    item_schema = schema.get("items")
    if item_schema is None:
        return []
    issues: list[dict[str, str]] = []
    for index, child in enumerate(value):
        issues.extend(validate_json_schema(item_schema, child, child_json_pointer(path, str(index))))
    return issues


def json_schema_type_matches(value: JsonValue, schema_type: JsonValue) -> bool:
    if isinstance(schema_type, list):
        return any(json_schema_type_matches(value, item) for item in schema_type)
    if schema_type == "object":
        return isinstance(value, dict)
    if schema_type == "array":
        return isinstance(value, list)
    if schema_type == "string":
        return isinstance(value, str)
    if schema_type == "number":
        return isinstance(value, int | float) and not isinstance(value, bool)
    if schema_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if schema_type == "boolean":
        return isinstance(value, bool)
    if schema_type == "null":
        return value is None
    return True


def json_value_type(value: JsonValue) -> str:
    if isinstance(value, bool):
        return "boolean"
    if value is None:
        return "null"
    if isinstance(value, dict):
        return "object"
    if isinstance(value, list):
        return "array"
    if isinstance(value, str):
        return "string"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    return type(value).__name__


def format_schema_type(schema_type: JsonValue) -> str:
    if isinstance(schema_type, list):
        return " or ".join(str(item) for item in schema_type)
    return str(schema_type)


def child_json_pointer(parent: str, key: str) -> str:
    return f"{parent.rstrip('/')}/{escape_pointer(key)}"


def escape_pointer(value: str) -> str:
    return value.replace("~", "~0").replace("/", "~1")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
