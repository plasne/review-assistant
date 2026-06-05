#!/usr/bin/env python3
"""Evaluate Review Assistant inference artifacts stored in Azure Blob Storage."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

try:
    from azure.identity import DefaultAzureCredential
    from azure.storage.blob import BlobServiceClient, ContentSettings
except ImportError:  # pragma: no cover - exercised only when dependencies are missing.
    DefaultAzureCredential = None
    BlobServiceClient = None
    ContentSettings = None


JsonValue = Any

STOP_WORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "in",
    "is",
    "it",
    "its",
    "of",
    "or",
    "the",
    "their",
    "through",
    "to",
    "with",
}


@dataclass(frozen=True)
class EvaluationPaths:
    evidence_path: str
    answer_path: str


DEFAULT_PATHS = EvaluationPaths(
    evidence_path="/evidence",
    answer_path="/answer",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate inference JSON artifacts in an Azure Blob container.")
    parser.add_argument(
        "--prefix",
        default="",
        help="Optional blob prefix to evaluate, such as a run folder. Defaults to every JSON artifact in the container.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite existing .eval.json blobs. By default existing evaluation outputs are skipped.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    container_name = require_env("INFERENCE_CONTAINER")
    container = create_blob_service_client().get_container_client(container_name)
    evaluated = 0
    skipped_existing = 0

    for blob in container.list_blobs(name_starts_with=args.prefix):
        blob_name = blob.name
        if not blob_name.endswith(".json") or blob_name.endswith(".eval.json"):
            continue
        eval_blob_name = evaluation_blob_name(blob_name)
        eval_blob = container.get_blob_client(eval_blob_name)
        if not args.overwrite and eval_blob.exists():
            skipped_existing += 1
            continue

        source_blob = container.get_blob_client(blob_name)
        source = json.loads(source_blob.download_blob().readall())
        result = evaluate_artifact(source, source_blob=blob_name)
        body = json.dumps(result, indent=2, sort_keys=True).encode("utf-8") + b"\n"
        eval_blob.upload_blob(
            body,
            overwrite=True,
            content_settings=ContentSettings(content_type="application/json") if ContentSettings else None,
        )
        evaluated += 1

    print(json.dumps({"evaluated": evaluated, "skipped_existing": skipped_existing}, sort_keys=True))
    return 0


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


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required.")
    return value


def evaluation_blob_name(blob_name: str) -> str:
    if not blob_name.endswith(".json"):
        return f"{blob_name}.eval.json"
    return f"{blob_name[:-len('.json')]}.eval.json"


def evaluate_artifact(artifact: JsonValue, *, source_blob: str | None = None) -> dict[str, JsonValue]:
    evaluated_at = datetime.now(timezone.utc).isoformat()
    try:
        ground_truth = require_object(artifact, "ground_truth")
        inference = require_object(artifact, "inference")
        expected_output = ground_truth.get("output")
        actual_output = inference.get("output")
        paths = read_evaluation_paths(ground_truth)

        expected_record = expected_output
        actual_record = actual_output
        expected_evidence = as_list(resolve_json_pointer(expected_output, paths.evidence_path))
        actual_evidence = as_list(resolve_json_pointer(actual_output, paths.evidence_path))
        expected_answer = as_text(resolve_json_pointer(expected_output, paths.answer_path))
        actual_answer = as_text(resolve_json_pointer(actual_output, paths.answer_path))

        return {
            "source_blob": source_blob,
            "evaluated_at": evaluated_at,
            "status": "evaluated",
            "source_status": inference.get("status"),
            "paths": paths_to_dict(paths),
            "metrics": {
                "retrieval_recall": retrieval_recall(expected_evidence, actual_evidence),
                "generation_correctness": generation_correctness(expected_answer, actual_answer),
                "record_correctness": record_correctness(expected_record, actual_record),
            },
        }
    except Exception as error:
        return {
            "source_blob": source_blob,
            "evaluated_at": evaluated_at,
            "status": "failed",
            "error": {"message": str(error), "type": error.__class__.__name__},
        }


def require_object(value: JsonValue, key: str) -> dict[str, JsonValue]:
    if not isinstance(value, dict) or not isinstance(value.get(key), dict):
        raise ValueError(f"Artifact is missing object field: {key}")
    return value[key]


def read_evaluation_paths(ground_truth: dict[str, JsonValue]) -> EvaluationPaths:
    config = ground_truth.get("evaluation")
    if not isinstance(config, dict):
        return DEFAULT_PATHS

    return EvaluationPaths(
        evidence_path=str(config.get("evidence_path", DEFAULT_PATHS.evidence_path)),
        answer_path=str(config.get("answer_path", DEFAULT_PATHS.answer_path)),
    )


def paths_to_dict(paths: EvaluationPaths) -> dict[str, str]:
    return {
        "evidence_path": paths.evidence_path,
        "answer_path": paths.answer_path,
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


def retrieval_recall(expected_evidence: list[JsonValue], actual_evidence: list[JsonValue]) -> dict[str, JsonValue]:
    expected_keys = {evidence_identity(item) for item in expected_evidence}
    actual_keys = {evidence_identity(item) for item in actual_evidence}
    expected_keys.discard("")
    actual_keys.discard("")
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


def evidence_identity(item: JsonValue) -> str:
    if isinstance(item, dict):
        for key in ("id", "url", "uri", "source"):
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                return f"{key}:{value.strip().lower()}"
        return json.dumps(item, sort_keys=True, separators=(",", ":")).lower()
    return json.dumps(item, sort_keys=True, separators=(",", ":")).lower()


def generation_correctness(expected_answer: str, actual_answer: str) -> dict[str, JsonValue]:
    expected_facts = extract_facts(expected_answer)
    actual_tokens = set(tokenize(actual_answer))
    fact_scores = []
    for fact in expected_facts:
        fact_tokens = set(tokenize(fact))
        score = 1.0 if not fact_tokens else len(fact_tokens & actual_tokens) / len(fact_tokens)
        fact_scores.append({"fact": fact, "score": round(score, 6)})

    score = 1.0 if not fact_scores else sum(item["score"] for item in fact_scores) / len(fact_scores)
    return {
        "score": round(score, 6),
        "expected_fact_count": len(fact_scores),
        "matched_fact_count": sum(1 for item in fact_scores if item["score"] >= 0.8),
        "facts": fact_scores,
    }


def extract_facts(answer: str) -> list[str]:
    facts = [part.strip(" ,") for part in re.split(r"[.;!?]|\s+\band\b\s+|\s+\bwhile\b\s+", answer) if part.strip(" ,")]
    return facts or ([answer.strip()] if answer.strip() else [])


def tokenize(text: str) -> list[str]:
    return [token for token in re.findall(r"[a-z0-9]+", text.lower()) if token not in STOP_WORDS]


def record_correctness(expected_record: JsonValue, actual_record: JsonValue) -> dict[str, JsonValue]:
    expected_properties = flatten_properties(expected_record)
    actual_properties = flatten_properties(actual_record)
    all_paths = sorted(set(expected_properties) | set(actual_properties))
    matches = [path for path in all_paths if expected_properties.get(path) == actual_properties.get(path)]
    total = len(all_paths)
    score = 1.0 if total == 0 else len(matches) / total
    return {
        "score": round(score, 6),
        "matching_properties": len(matches),
        "total_properties": total,
        "mismatched_properties": [path for path in all_paths if path not in matches],
    }


def flatten_properties(value: JsonValue, prefix: str = "") -> dict[str, JsonValue]:
    if isinstance(value, dict):
        if not value:
            return {prefix or "/": {}}
        flattened: dict[str, JsonValue] = {}
        for key, child in value.items():
            flattened.update(flatten_properties(child, f"{prefix}/{escape_pointer(key)}"))
        return flattened
    if isinstance(value, list):
        if not value:
            return {prefix or "/": []}
        flattened = {}
        for index, child in enumerate(value):
            flattened.update(flatten_properties(child, f"{prefix}/{index}"))
        return flattened
    return {prefix or "/": value}


def escape_pointer(value: str) -> str:
    return value.replace("~", "~0").replace("/", "~1")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
