import io
import json
import os
import unittest
import urllib.error
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from eval.evaluate import (
    DEFAULT_JUDGE_TIMEOUT_SECONDS,
    CopilotSdkFactJudge,
    ExperimentCatalogConfig,
    build_judge_request,
    create_fact_judge_from_env,
    evaluate_artifact,
    evaluation_failure_summary,
    evaluation_blob_name,
    experiment_catalog_api_base_url,
    experiment_catalog_metrics,
    list_experiment_catalog_sets,
    next_experiment_catalog_set,
    next_suffixed_set_name,
    generation_metrics_for_answers,
    inference_timing_metrics,
    is_inference_artifact_blob,
    latest_inference_prefix,
    log_evaluation_progress,
    main,
    normalize_prefix,
    parse_args,
    parse_judge_response_content,
    publish_experiment_catalog_result,
    output_structure,
    retrieval_recall,
    resolve_json_pointer_many,
    resolve_json_pointer,
    unquote_env_value,
)


class FakeBlob:
    def __init__(self, name):
        self.name = name


class FakeContainer:
    def __init__(self, blob_names):
        self.blob_names = blob_names

    def list_blobs(self, name_starts_with=None):
        prefix = name_starts_with or ""
        return [FakeBlob(name) for name in self.blob_names if name.startswith(prefix)]


class FakeStorageService:
    def __init__(self, container):
        self.container = container

    def get_container_client(self, _container_name):
        return self.container


class FakeStorageContainer:
    def __init__(self, sources):
        self.sources = sources
        self.uploads = {}

    def list_blobs(self, name_starts_with=None):
        prefix = name_starts_with or ""
        return [FakeBlob(name) for name in self.sources if name.startswith(prefix)]

    def get_blob_client(self, blob_name):
        return FakeBlobClient(self, blob_name)


class FakeBlobClient:
    def __init__(self, container, blob_name):
        self.container = container
        self.blob_name = blob_name
        self.url = f"https://storage.example/{blob_name}"

    def exists(self):
        return self.blob_name in self.container.uploads

    def download_blob(self):
        return FakeBlobDownload(json.dumps(self.container.sources[self.blob_name]).encode("utf-8"))

    def upload_blob(self, body, **_kwargs):
        self.container.uploads[self.blob_name] = body


class FakeBlobDownload:
    def __init__(self, body):
        self.body = body

    def readall(self):
        return self.body


class EvaluateMetricsTests(unittest.TestCase):
    def test_evaluation_blob_name_replaces_json_suffix(self):
        self.assertEqual(evaluation_blob_name("run/a00-0.json"), "run/a00-0.eval.json")

    def test_evaluation_replaces_existing_outputs_by_default(self):
        with patch("sys.argv", ["evaluate.py"]):
            args = parse_args()

        self.assertEqual(args.skip_existing, False)

    def test_evaluation_can_skip_existing_outputs_when_requested(self):
        with patch("sys.argv", ["evaluate.py", "--skip-existing"]):
            args = parse_args()

        self.assertEqual(args.skip_existing, True)

    def test_normalize_prefix_appends_slash_only_when_needed(self):
        self.assertEqual(normalize_prefix("1780923514279"), "1780923514279/")
        self.assertEqual(normalize_prefix("1780923514279/"), "1780923514279/")
        self.assertEqual(normalize_prefix(""), "")

    def test_latest_inference_prefix_uses_newest_manifest_folder(self):
        container = FakeContainer(["1780923514278/manifest.json", "1780923514279/manifest.json", "1780923514279/a00-0.json"])
        self.assertEqual(latest_inference_prefix(container), "1780923514279/")

    def test_inference_artifact_filter_skips_manifest_and_eval_outputs(self):
        self.assertTrue(is_inference_artifact_blob("1780923514279/a00-0.json"))
        self.assertFalse(is_inference_artifact_blob("1780923514279/manifest.json"))
        self.assertFalse(is_inference_artifact_blob("1780923514279/a00-0.eval.json"))

    def test_unquote_env_value_handles_quoted_values(self):
        self.assertEqual(unquote_env_value('"container"'), "container")
        self.assertEqual(unquote_env_value("'container'"), "container")
        self.assertEqual(unquote_env_value("container"), "container")

    def test_evaluation_progress_logs_to_stderr(self):
        stderr = io.StringIO()

        with patch("sys.stderr", stderr):
            log_evaluation_progress("Evaluating inference artifact", "run/a00-0.json")

        self.assertEqual(stderr.getvalue(), "Evaluating inference artifact: run/a00-0.json\n")

    def test_evaluation_failure_summary_reports_source_and_error(self):
        self.assertEqual(
            evaluation_failure_summary(
                "run/a01-0.json",
                {"status": "failed", "error": {"type": "ValueError", "message": "missing output"}},
            ),
            {
                "source_blob": "run/a01-0.json",
                "status": "failed",
                "error_type": "ValueError",
                "reason": "missing output",
            },
        )

    def test_main_summary_reports_catalog_publish_counts(self):
        container = FakeStorageContainer(
            {
                "run/a00-0.json": {"inference": {"ref": "ref-a", "run_folder": "run"}},
                "run/a00-1.json": {"inference": {"ref": "ref-b", "run_folder": "run"}},
            }
        )
        stdout = io.StringIO()
        stderr = io.StringIO()

        with (
            patch("eval.evaluate.parse_args", return_value=SimpleNamespace(latest=False, prefix="run", skip_existing=False)),
            patch("eval.evaluate.load_default_env"),
            patch.dict(os.environ, {"INFERENCE_CONTAINER": "inference"}, clear=True),
            patch("eval.evaluate.create_blob_service_client", return_value=FakeStorageService(container)),
            patch("eval.evaluate.create_fact_judge_from_env", return_value=equivalent_fact_judge),
            patch(
                "eval.evaluate.create_experiment_catalog_from_env",
                return_value=ExperimentCatalogConfig(
                    base_url="https://example.com/",
                    project="review-assistant",
                    experiment="baseline",
                ),
            ),
            patch("eval.evaluate.next_experiment_catalog_set", return_value="run-A"),
            patch("eval.evaluate.publish_experiment_catalog_result") as publish,
            patch(
                "eval.evaluate.evaluate_artifact",
                side_effect=[
                    {"status": "evaluated", "metrics": {}},
                    {"status": "failed", "error": {"type": "ValueError", "message": "missing output"}},
                ],
            ),
            patch("sys.stdout", stdout),
            patch("sys.stderr", stderr),
        ):
            exit_code = main()

        self.assertEqual(exit_code, 0)
        self.assertEqual(publish.call_count, 1)
        self.assertEqual(json.loads(stdout.getvalue()), {
            "catalog_published": 1,
            "catalog_skipped_not_evaluated": 1,
            "evaluated": 2,
            "evaluation_failed": 1,
            "failed_artifacts": [
                {
                    "source_blob": "run/a00-1.json",
                    "status": "failed",
                    "error_type": "ValueError",
                    "reason": "missing output",
                }
            ],
            "prefix": "run/",
            "skipped_existing": 0,
        })
        self.assertIn("Evaluation failed: run/a00-1.json - ValueError: missing output\n", stderr.getvalue())

    def test_json_pointer_resolves_objects_and_arrays(self):
        value = {"turns": [{"answer": "done"}]}
        self.assertEqual(resolve_json_pointer(value, "/turns/0/answer"), "done")

    def test_json_pointer_many_supports_wildcard_segments(self):
        value = {
            "turns": [
                {"evidence": [{"id": "doc-a"}]},
                {"evidence": [{"id": "doc-b"}]},
            ]
        }

        self.assertEqual(
            resolve_json_pointer_many(value, "/turns/*/evidence"),
            [[{"id": "doc-a"}], [{"id": "doc-b"}]],
        )

    def test_retrieval_recall_matches_expected_evidence_by_id(self):
        metric = retrieval_recall(
            [{"id": "doc-a"}, {"id": "doc-b"}],
            [{"id": "doc-a"}, {"id": "doc-c"}],
            "id",
        )
        self.assertEqual(metric["score"], 0.5)
        self.assertEqual(metric["missing_evidence"], ["id:doc-b"])

    def test_retrieval_recall_can_match_expected_evidence_by_configured_key(self):
        metric = retrieval_recall(
            [{"id": "expected-a", "url": "https://example.com/a"}, {"id": "expected-b", "url": "https://example.com/b"}],
            [{"id": "actual-a", "url": "https://example.com/a"}, {"id": "actual-c", "url": "https://example.com/c"}],
            "url",
        )

        self.assertEqual(metric["score"], 0.5)
        self.assertEqual(metric["missing_evidence"], ["url:https://example.com/b"])

    def test_retrieval_recall_counts_expected_evidence_missing_configured_key(self):
        metric = retrieval_recall(
            [{"id": "expected-a", "url": "https://example.com/a"}, {"id": "expected-b"}],
            [{"id": "actual-a", "url": "https://example.com/a"}],
            "url",
        )

        self.assertEqual(metric["score"], 0.5)
        self.assertEqual(metric["missing_evidence"], ["url:<missing:1>"])

    def test_generation_metrics_use_judge_for_material_equivalence(self):
        def fact_judge(expected_answer, actual_answer):
            self.assertIn("advancing the influence track", expected_answer)
            self.assertIn("push the influence track", actual_answer)
            return {
                "schema_version": "review-assistant.fact-judge.v1",
                "ground_truth_facts": [
                    {
                        "id": "gt-1",
                        "fact": "Dracula wins by advancing the influence track to its victory space through vampires, hunters, and influence-adding effects.",
                    }
                ],
                "inference_facts": [
                    {
                        "id": "inf-1",
                        "fact": "Dracula's goal is to push the influence track to victory using maturing vampires, hunter attacks, and influence effects.",
                    }
                ],
                "comparisons": [
                    {
                        "ground_truth_fact_id": "gt-1",
                        "inference_fact_ids": ["inf-1"],
                        "label": "equivalent",
                        "rationale": "Both state the same objective and main mechanisms with different wording.",
                    }
                ],
            }

        metrics = generation_metrics_for_answers(
            "Dracula is trying to win by advancing the influence track to its victory space, commonly by maturing vampires, defeating or biting hunters, and using encounter or card effects that add influence.",
            "Dracula's goal is to push the influence track to victory, usually by maturing vampires, attacking hunters, and resolving effects that increase influence.",
            fact_judge=fact_judge,
        )

        self.assertEqual(metrics["generation_accuracy"]["method"], "agent_judge")
        self.assertEqual(metrics["generation_accuracy"]["numerator"], 2)
        self.assertEqual(metrics["generation_accuracy"]["denominator"], 2)
        self.assertEqual(metrics["generation_accuracy"]["score"], 1.0)
        self.assertEqual(metrics["generation_recall"]["supported_ground_truth_fact_count"], 1)
        self.assertEqual(metrics["generation_recall"]["ground_truth_fact_count"], 1)
        self.assertEqual(metrics["generation_recall"]["score"], 1.0)
        self.assertEqual(metrics["generation_precision"]["supported_inference_fact_count"], 1)
        self.assertEqual(metrics["generation_precision"]["inference_fact_count"], 1)
        self.assertEqual(metrics["generation_precision"]["score"], 1.0)
        self.assertEqual(metrics["generation_accuracy"]["ground_truth_facts"][0]["supported_by_inference"], True)
        self.assertEqual(metrics["generation_accuracy"]["inference_facts"][0]["supported_by_ground_truth"], True)
        self.assertNotIn("generation_correctness", metrics)
        self.assertNotIn("overlap", metrics["generation_accuracy"])
        self.assertNotIn("extra_inference_facts", metrics["generation_accuracy"])

    def test_evaluate_artifact_writes_judge_model_metadata(self):
        class RecordingFactJudge:
            def __init__(self):
                self.model = "gpt-5.4-mini"
                self.used_models = set()

            def __call__(self, _expected_answer, _actual_answer):
                self.used_models.add("gpt-5.4-mini")
                return {
                    "schema_version": "review-assistant.fact-judge.v1",
                    "ground_truth_facts": [{"id": "gt-1", "fact": "Dracula advances influence."}],
                    "inference_facts": [{"id": "inf-1", "fact": "Dracula advances influence."}],
                    "comparisons": [
                        {
                            "ground_truth_fact_id": "gt-1",
                            "inference_fact_ids": ["inf-1"],
                            "label": "equivalent",
                            "rationale": "Same fact.",
                        }
                    ],
                }

        result = evaluate_artifact(
            {
                "ground_truth": {"output": {"answer": "Dracula advances influence."}},
                "inference": {
                    "status": "completed",
                    "elapsed_ms": 123,
                    "transcript": [],
                    "output": {"answer": "Dracula advances influence."},
                },
            },
            fact_judge=RecordingFactJudge(),
            source_blob="run/ref-a-0.json",
        )

        self.assertEqual(result["status"], "evaluated")
        self.assertEqual(result["judge"], {"model": "gpt-5.4-mini"})

    def test_evaluate_artifact_fails_when_judge_reports_unexpected_model(self):
        class MismatchedFactJudge:
            def __init__(self):
                self.model = "gpt-5.4-mini"
                self.used_models = {"claude-sonnet-4.6"}

            def __call__(self, _expected_answer, _actual_answer):
                return {
                    "schema_version": "review-assistant.fact-judge.v1",
                    "ground_truth_facts": [{"id": "gt-1", "fact": "Dracula advances influence."}],
                    "inference_facts": [{"id": "inf-1", "fact": "Dracula advances influence."}],
                    "comparisons": [
                        {
                            "ground_truth_fact_id": "gt-1",
                            "inference_fact_ids": ["inf-1"],
                            "label": "equivalent",
                            "rationale": "Same fact.",
                        }
                    ],
                }

        result = evaluate_artifact(
            {
                "ground_truth": {"output": {"answer": "Dracula advances influence."}},
                "inference": {
                    "status": "completed",
                    "elapsed_ms": 123,
                    "transcript": [],
                    "output": {"answer": "Dracula advances influence."},
                },
            },
            fact_judge=MismatchedFactJudge(),
            source_blob="run/ref-a-0.json",
        )

        self.assertEqual(result["status"], "failed")
        self.assertIn("unexpected model", result["error"]["message"])

    def test_generation_metrics_report_simple_support_flags_and_component_scores(self):
        def fact_judge(_expected_answer, _actual_answer):
            return {
                "schema_version": "review-assistant.fact-judge.v1",
                "ground_truth_facts": [
                    {"id": "gt-1", "fact": "Dracula advances influence."},
                    {"id": "gt-2", "fact": "Dracula matures vampires."},
                ],
                "inference_facts": [
                    {"id": "inf-1", "fact": "Dracula advances influence."},
                    {"id": "inf-2", "fact": "Dracula acts in secret."},
                ],
                "comparisons": [
                    {
                        "ground_truth_fact_id": "gt-1",
                        "inference_fact_ids": ["inf-1"],
                        "label": "equivalent",
                        "rationale": "Same fact.",
                    },
                    {
                        "ground_truth_fact_id": "gt-2",
                        "inference_fact_ids": [],
                        "label": "missing",
                        "rationale": "No inference fact mentions vampire maturation.",
                    },
                ],
            }

        metrics = generation_metrics_for_answers("expected", "actual", fact_judge=fact_judge)

        self.assertEqual(
            metrics["generation_accuracy"]["ground_truth_facts"],
            [
                {"id": "gt-1", "fact": "Dracula advances influence.", "supported_by_inference": True},
                {"id": "gt-2", "fact": "Dracula matures vampires.", "supported_by_inference": False},
            ],
        )
        self.assertEqual(
            metrics["generation_accuracy"]["inference_facts"],
            [
                {"id": "inf-1", "fact": "Dracula advances influence.", "supported_by_ground_truth": True},
                {"id": "inf-2", "fact": "Dracula acts in secret.", "supported_by_ground_truth": False},
            ],
        )
        self.assertEqual(
            metrics["generation_accuracy"],
            {
                "numerator": 2,
                "denominator": 4,
                "score": 0.5,
                "method": "agent_judge",
                "schema_version": "review-assistant.fact-judge.v1",
                "supported_fact_count": 2,
                "total_fact_count": 4,
                "inference_facts": [
                    {"id": "inf-1", "fact": "Dracula advances influence.", "supported_by_ground_truth": True},
                    {"id": "inf-2", "fact": "Dracula acts in secret.", "supported_by_ground_truth": False},
                ],
                "ground_truth_facts": [
                    {"id": "gt-1", "fact": "Dracula advances influence.", "supported_by_inference": True},
                    {"id": "gt-2", "fact": "Dracula matures vampires.", "supported_by_inference": False},
                ],
            },
        )
        self.assertEqual(
            metrics["generation_recall"],
            {
                "numerator": 1,
                "denominator": 2,
                "score": 0.5,
                "method": "agent_judge",
                "schema_version": "review-assistant.fact-judge.v1",
                "supported_ground_truth_fact_count": 1,
                "ground_truth_fact_count": 2,
            },
        )
        self.assertEqual(
            metrics["generation_precision"],
            {
                "numerator": 1,
                "denominator": 2,
                "score": 0.5,
                "method": "agent_judge",
                "schema_version": "review-assistant.fact-judge.v1",
                "supported_inference_fact_count": 1,
                "inference_fact_count": 2,
            },
        )

    def test_generation_metrics_reject_incomplete_judge_output(self):
        def fact_judge(_expected_answer, _actual_answer):
            return {
                "schema_version": "review-assistant.fact-judge.v1",
                "ground_truth_facts": [{"id": "gt-1", "fact": "Dracula advances influence."}],
                "inference_facts": [],
                "comparisons": [],
            }

        with self.assertRaisesRegex(ValueError, "missing comparisons"):
            generation_metrics_for_answers("Dracula advances influence.", "", fact_judge=fact_judge)

    def test_parse_judge_response_accepts_json_content_from_copilot(self):
        parsed = parse_judge_response_content(
            '```json\n{"schema_version":"review-assistant.fact-judge.v1","ground_truth_facts":[],"inference_facts":[],"comparisons":[]}\n```'
        )

        self.assertEqual(parsed["schema_version"], "review-assistant.fact-judge.v1")

    def test_judge_request_treats_no_rule_as_supporting_no_evidence(self):
        request = build_judge_request(
            "No supporting evidence was found for an official helicopter movement rule, so no evidence entries were recorded.",
            "There is no official Fury of Dracula rule about helicopter movement between cities.",
        )

        self.assertIn(
            'treat "no official/source rule exists or was found" as materially supporting',
            request["instructions"],
        )

    def test_create_fact_judge_from_env_requires_model_and_uses_copilot_sdk_defaults(self):
        with patch.dict(os.environ, {"AGENT_MODEL": "gpt-5.4-mini"}, clear=True):
            judge = create_fact_judge_from_env()

        self.assertIsInstance(judge, CopilotSdkFactJudge)
        self.assertEqual(judge.repo_root, Path.cwd())
        self.assertEqual(judge.timeout_seconds, DEFAULT_JUDGE_TIMEOUT_SECONDS)
        self.assertEqual(judge.model, "gpt-5.4-mini")

    def test_create_fact_judge_from_env_rejects_missing_model(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "AGENT_MODEL is required"):
                create_fact_judge_from_env()

    def test_output_structure_validates_against_schema_without_comparing_values_or_array_lengths(self):
        metric = output_structure(
            {
                "answer": "Different answer.",
                "evidence": [
                    {"id": "doc-1", "title": "A", "url": "a://doc", "excerpt": "Text.", "score": 25},
                    {"id": "doc-2", "title": "B", "url": "b://doc", "excerpt": "Other text.", "score": 12},
                ],
            },
            {
                "type": "object",
                "properties": {
                    "answer": {"type": "string", "enum": ["Expected answer."]},
                    "evidence": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string"},
                                "title": {"type": "string"},
                                "url": {"type": "string"},
                                "excerpt": {"type": "string"},
                                "score": {"type": "number"},
                            },
                            "required": ["id", "title", "url", "excerpt"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["answer", "evidence"],
                "additionalProperties": False,
            },
        )

        self.assertTrue(metric["valid"])
        self.assertEqual(metric["issue_count"], 0)
        self.assertEqual(metric["score"], 1.0)

    def test_output_structure_reports_schema_violations(self):
        metric = output_structure(
            {"answer": 42, "extra": True},
            {
                "type": "object",
                "properties": {"answer": {"type": "string"}, "evidence": {"type": "array"}},
                "required": ["answer", "evidence"],
                "additionalProperties": False,
            },
        )

        self.assertFalse(metric["valid"])
        self.assertEqual(metric["issue_count"], 3)
        self.assertEqual(
            metric["issues"],
            [
                {"path": "/", "keyword": "required", "message": "Missing required property: evidence."},
                {"path": "/answer", "keyword": "type", "message": "Expected string, got integer."},
                {"path": "/extra", "keyword": "additionalProperties", "message": "Unexpected property: extra."},
            ],
        )
        self.assertEqual(metric["score"], 0.0)

    def test_output_structure_ignores_configured_issues_only(self):
        metric = output_structure(
            {"turns": [{"question": "Search?", "answer": "Search answer."}, {"question": "Synthesize?", "answer": 42}]},
            {
                "type": "object",
                "properties": {
                    "turns": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "question": {"type": "string"},
                                "evidence": {"type": "array"},
                                "answer": {"type": "string"},
                            },
                            "required": ["question", "evidence", "answer"],
                            "additionalProperties": False,
                        },
                    }
                },
                "required": ["turns"],
                "additionalProperties": False,
            },
            (
                {
                    "path": "/turns/0",
                    "keyword": "required",
                    "message": "Missing required property: evidence.",
                },
            ),
        )

        self.assertFalse(metric["valid"])
        self.assertEqual(metric["score"], 0.0)
        self.assertEqual(metric["ignored_issue_count"], 1)
        self.assertEqual(
            metric["ignored_issues"],
            [{"path": "/turns/0", "keyword": "required", "message": "Missing required property: evidence."}],
        )
        self.assertEqual(
            metric["issues"],
            [
                {"path": "/turns/1", "keyword": "required", "message": "Missing required property: evidence."},
                {"path": "/turns/1/answer", "keyword": "type", "message": "Expected string, got integer."},
            ],
        )

    def test_inference_timing_metrics_are_derived_from_inference_transcript(self):
        metrics = inference_timing_metrics(
            {
                "elapsed_ms": 1234,
                "transcript": [
                    {"type": "user-prompt", "elapsed_ms": 0},
                    {"type": "tool-call", "elapsed_ms": 250},
                    {
                        "type": "assistant-response",
                        "elapsed_ms": 800,
                        "metadata": {"assistantRequestElapsedMs": 900, "firstTokenLatencyMs": 100, "streamElapsedMs": 800},
                    },
                    {"type": "tool-call", "elapsed_ms": 50},
                ],
            }
        )

        self.assertEqual(
            metrics,
            {
                "meta_total_elapsed_ms": 1234,
                "meta_assistant_request_elapsed_ms": 900,
                "meta_first_token_latency_ms": 100,
                "meta_stream_elapsed_ms": 800,
                "meta_tool_elapsed_ms": 300,
                "meta_unattributed_elapsed_ms": 334,
            },
        )

    def test_experiment_catalog_metrics_flatten_scores_and_timing_values(self):
        metrics = experiment_catalog_metrics(
            {
                "metrics": {
                    "retrieval_recall": {"score": 0.5, "missing_evidence": ["id:doc-b"]},
                    "generation_accuracy": {"score": 0.75, "ground_truth_facts": []},
                    "output_structure": {"score": 1.0},
                    "meta_total_elapsed_ms": 1234,
                    "meta_assistant_request_elapsed_ms": 900,
                    "meta_first_token_latency_ms": 100,
                    "meta_stream_elapsed_ms": 800,
                    "meta_tool_elapsed_ms": 250,
                    "meta_unattributed_elapsed_ms": 334,
                }
            }
        )

        self.assertEqual(
            metrics,
            {
                "retrieval_recall": 0.5,
                "generation_accuracy": 0.75,
                "output_structure": 1.0,
                "meta_total_elapsed_ms": 1234,
                "meta_assistant_request_elapsed_ms": 900,
                "meta_first_token_latency_ms": 100,
                "meta_stream_elapsed_ms": 800,
                "meta_tool_elapsed_ms": 250,
                "meta_unattributed_elapsed_ms": 334,
            },
        )

    def test_experiment_catalog_url_normalizes_to_api_path(self):
        self.assertEqual(experiment_catalog_api_base_url("https://example.com/"), "https://example.com/api/")
        self.assertEqual(experiment_catalog_api_base_url("https://example.com/api"), "https://example.com/api/")

    def test_next_suffixed_set_name_uses_next_run_folder_letter(self):
        self.assertEqual(next_suffixed_set_name("1700000000000", []), "1700000000000-A")
        self.assertEqual(
            next_suffixed_set_name("1700000000000", ["1700000000000-A", "1700000000000-B", "other-A"]),
            "1700000000000-C",
        )
        self.assertEqual(next_suffixed_set_name("1700000000000", ["1700000000000-Z"]), "1700000000000-AA")

    def test_next_experiment_catalog_set_reads_existing_catalog_sets(self):
        response = FakeHttpResponse(status=200, body='["1700000000000-A"]')
        config = ExperimentCatalogConfig(base_url="https://example.com/", project="review-assistant", experiment="baseline")

        with patch("urllib.request.urlopen", return_value=response) as urlopen:
            set_name = next_experiment_catalog_set(config, "1700000000000")

        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "https://example.com/api/projects/review-assistant/experiments/baseline/sets")
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(set_name, "1700000000000-B")

    def test_list_experiment_catalog_sets_rejects_invalid_shape(self):
        config = ExperimentCatalogConfig(base_url="https://example.com/", project="review-assistant", experiment="baseline")
        with patch("urllib.request.urlopen", return_value=FakeHttpResponse(status=200, body='{"set":"bad"}')):
            with self.assertRaisesRegex(ValueError, "string list"):
                list_experiment_catalog_sets(config)

    def test_publish_experiment_catalog_result_posts_evaluation_metrics(self):
        response = FakeHttpResponse(status=200)
        with patch("urllib.request.urlopen", return_value=response) as urlopen:
            publish_experiment_catalog_result(
                ExperimentCatalogConfig(
                    base_url="https://eval-catalog.salmonsky-371093b3.eastus2.azurecontainerapps.io/",
                    project="review-assistant",
                    experiment="baseline",
                ),
                {
                    "inference": {
                        "ref": "ref-a",
                        "run_folder": "1700000000000",
                    }
                },
                {
                    "metrics": {
                        "generation_accuracy": {"score": 1.0},
                        "meta_total_elapsed_ms": 1234,
                        "meta_assistant_request_elapsed_ms": 900,
                        "meta_first_token_latency_ms": 100,
                        "meta_stream_elapsed_ms": 800,
                        "meta_tool_elapsed_ms": 250,
                        "meta_unattributed_elapsed_ms": 334,
                    }
                },
                set_name="1700000000000-B",
                inference_uri="https://storage.example/inference/1700000000000/ref-a-0.json",
                evaluation_uri="https://storage.example/inference/1700000000000/ref-a-0.eval.json",
            )

        request = urlopen.call_args.args[0]
        self.assertIn("context", urlopen.call_args.kwargs)
        self.assertEqual(
            request.full_url,
            "https://eval-catalog.salmonsky-371093b3.eastus2.azurecontainerapps.io/api/projects/review-assistant/experiments/baseline/results",
        )
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.headers["Content-type"], "application/json")
        self.assertEqual(
            json_from_request(request),
            {
                "ref": "ref-a",
                "set": "1700000000000-B",
                "inference_uri": "https://storage.example/inference/1700000000000/ref-a-0.json",
                "evaluation_uri": "https://storage.example/inference/1700000000000/ref-a-0.eval.json",
                "metrics": {
                    "generation_accuracy": 1.0,
                    "meta_total_elapsed_ms": 1234,
                    "meta_assistant_request_elapsed_ms": 900,
                    "meta_first_token_latency_ms": 100,
                    "meta_stream_elapsed_ms": 800,
                    "meta_tool_elapsed_ms": 250,
                    "meta_unattributed_elapsed_ms": 334,
                },
            },
        )

    def test_publish_experiment_catalog_result_retries_transient_http_errors(self):
        responses = [
            urllib.error.HTTPError(
                "https://example.com/api/projects/review-assistant/experiments/baseline/results",
                503,
                "Service Unavailable",
                {},
                io.BytesIO(b"busy"),
            ),
            FakeHttpResponse(status=200),
        ]

        with (
            patch("urllib.request.urlopen", side_effect=responses) as urlopen,
            patch("time.sleep") as sleep,
        ):
            publish_experiment_catalog_result(
                ExperimentCatalogConfig(
                    base_url="https://example.com/",
                    project="review-assistant",
                    experiment="baseline",
                ),
                {"inference": {"ref": "ref-a", "run_folder": "1700000000000"}},
                {"metrics": {"generation_accuracy": {"score": 1.0}}},
                set_name="1700000000000-B",
                inference_uri="https://storage.example/inference/1700000000000/ref-a-0.json",
                evaluation_uri="https://storage.example/inference/1700000000000/ref-a-0.eval.json",
            )

        self.assertEqual(urlopen.call_count, 2)
        sleep.assert_called_once_with(1)

    def test_list_experiment_catalog_sets_retries_url_errors(self):
        config = ExperimentCatalogConfig(base_url="https://example.com/", project="review-assistant", experiment="baseline")

        with (
            patch(
                "urllib.request.urlopen",
                side_effect=[
                    urllib.error.URLError("connection reset"),
                    FakeHttpResponse(status=200, body='["1700000000000-A"]'),
                ],
            ) as urlopen,
            patch("time.sleep") as sleep,
        ):
            sets = list_experiment_catalog_sets(config)

        self.assertEqual(sets, ["1700000000000-A"])
        self.assertEqual(urlopen.call_count, 2)
        sleep.assert_called_once_with(1)

    def test_evaluate_artifact_uses_explicit_ground_truth_paths(self):
        artifact = {
            "ground_truth": {
                "output": {
                    "turns": [
                        {
                            "answer": "Dracula wins by advancing influence.",
                            "evidence": [{"id": "expected-objective", "url": "fury-of-dracula-4e://rules/objective"}],
                        }
                    ]
                },
                "evaluation": {
                    "evidence_path": "/turns/0/evidence",
                    "answer_path": "/turns/0/answer",
                    "evidence_key": "url",
                    "output_schema": {
                        "type": "object",
                        "properties": {
                            "turns": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "answer": {"type": "string"},
                                        "evidence": {
                                            "type": "array",
                                            "items": {
                                                "type": "object",
                                                "properties": {"id": {"type": "string"}, "url": {"type": "string"}},
                                                "required": ["id", "url"],
                                                "additionalProperties": False,
                                            },
                                        },
                                    },
                                    "required": ["answer", "evidence"],
                                    "additionalProperties": False,
                                },
                            }
                        },
                        "required": ["turns"],
                        "additionalProperties": False,
                    },
                },
            },
            "inference": {
                "ref": "ref-a",
                "run_folder": "run",
                "status": "completed",
                "elapsed_ms": 1234,
                "output": {
                    "turns": [
                        {
                            "answer": "Dracula wins by advancing influence.",
                            "evidence": [{"id": "actual-objective", "url": "fury-of-dracula-4e://rules/objective"}],
                        }
                    ]
                },
                "transcript": [
                    {"type": "tool-call", "elapsed_ms": 250},
                    {
                        "type": "assistant-response",
                        "elapsed_ms": 800,
                        "metadata": {"assistantRequestElapsedMs": 900, "firstTokenLatencyMs": 100, "streamElapsedMs": 800},
                    },
                ],
            },
        }

        result = evaluate_artifact(artifact, source_blob="run/c00-0.json", fact_judge=equivalent_fact_judge)

        self.assertEqual(result["status"], "evaluated")
        self.assertEqual(result["metrics"]["retrieval_recall"]["score"], 1.0)
        self.assertNotIn("generation_correctness", result["metrics"])
        self.assertEqual(result["metrics"]["generation_accuracy"]["score"], 1.0)
        self.assertEqual(result["metrics"]["generation_recall"]["score"], 1.0)
        self.assertEqual(result["metrics"]["generation_precision"]["score"], 1.0)
        self.assertEqual(result["metrics"]["output_structure"]["score"], 1.0)
        self.assertEqual(result["paths"]["has_output_schema"], True)
        self.assertEqual(result["metrics"]["meta_total_elapsed_ms"], 1234)
        self.assertEqual(result["metrics"]["meta_assistant_request_elapsed_ms"], 900)
        self.assertEqual(result["metrics"]["meta_first_token_latency_ms"], 100)
        self.assertEqual(result["metrics"]["meta_stream_elapsed_ms"], 800)
        self.assertEqual(result["metrics"]["meta_tool_elapsed_ms"], 250)
        self.assertEqual(result["metrics"]["meta_unattributed_elapsed_ms"], 334)

    def test_evaluate_artifact_computes_per_turn_retrieval_recall_macro_average(self):
        artifact = {
            "ground_truth": {
                "output": {
                    "turns": [
                        {
                            "answer": "Turn 0 answer.",
                            "evidence": [{"id": "expected-a", "url": "fury-of-dracula-4e://rules/objective"}],
                        },
                        {
                            "answer": "Turn 1 answer.",
                            "evidence": [{"id": "expected-b", "url": "fury-of-dracula-4e://rules/combat-overview"}],
                        },
                    ]
                },
                "evaluation": {
                    "evidence_path": "/turns/*/evidence",
                    "answer_path": "/turns/0/answer",
                    "evidence_key": "url",
                },
            },
            "inference": {
                "ref": "ref-a",
                "run_folder": "run",
                "status": "completed",
                "elapsed_ms": 1234,
                "output": {
                    "turns": [
                        {
                            "answer": "Turn 0 answer.",
                            "evidence": [{"id": "actual-a", "url": "fury-of-dracula-4e://rules/objective"}],
                        },
                        {
                            "answer": "Turn 1 answer.",
                            "evidence": [{"id": "actual-c", "url": "fury-of-dracula-4e://rules/missing"}],
                        },
                    ]
                },
                "transcript": [
                    {"type": "tool-call", "elapsed_ms": 250},
                    {
                        "type": "assistant-response",
                        "elapsed_ms": 800,
                        "metadata": {"assistantRequestElapsedMs": 900, "firstTokenLatencyMs": 100, "streamElapsedMs": 800},
                    },
                ],
            },
        }

        result = evaluate_artifact(artifact, source_blob="run/c10-0.json", fact_judge=equivalent_fact_judge)

        self.assertEqual(result["status"], "evaluated")
        self.assertEqual(result["metrics"]["retrieval_recall"]["method"], "per_turn_macro_average")
        self.assertEqual(result["metrics"]["retrieval_recall"]["turn_count"], 2)
        self.assertEqual(result["metrics"]["retrieval_recall"]["score"], 0.5)
        self.assertEqual(
            result["metrics"]["retrieval_recall"]["per_turn"],
            [
                {
                    "turn_index": 0,
                    "score": 1.0,
                    "expected_evidence_count": 1,
                    "actual_evidence_count": 1,
                    "retrieved_relevant_count": 1,
                    "missing_evidence": [],
                },
                {
                    "turn_index": 1,
                    "score": 0.0,
                    "expected_evidence_count": 1,
                    "actual_evidence_count": 1,
                    "retrieved_relevant_count": 0,
                    "missing_evidence": ["url:fury-of-dracula-4e://rules/combat-overview"],
                },
            ],
        )

    def test_evaluate_artifact_computes_per_turn_generation_macro_average(self):
        def fact_judge(expected_answer, actual_answer):
            is_equivalent = expected_answer == actual_answer
            return {
                "schema_version": "review-assistant.fact-judge.v1",
                "ground_truth_facts": [{"id": "gt-1", "fact": expected_answer}],
                "inference_facts": [{"id": "inf-1", "fact": actual_answer}],
                "comparisons": [
                    {
                        "ground_truth_fact_id": "gt-1",
                        "inference_fact_ids": ["inf-1"] if is_equivalent else [],
                        "label": "equivalent" if is_equivalent else "missing",
                        "rationale": "string match" if is_equivalent else "string mismatch",
                    }
                ],
            }

        artifact = {
            "ground_truth": {
                "output": {
                    "turns": [
                        {"answer": "Turn 0 expected.", "evidence": []},
                        {"answer": "Turn 1 expected.", "evidence": []},
                    ]
                },
                "evaluation": {
                    "evidence_path": "/turns/*/evidence",
                    "answer_path": "/turns/*/answer",
                    "evidence_key": "url",
                },
            },
            "inference": {
                "ref": "ref-a",
                "run_folder": "run",
                "status": "completed",
                "elapsed_ms": 1234,
                "output": {
                    "turns": [
                        {"answer": "Turn 0 expected.", "evidence": []},
                        {"answer": "Turn 1 different.", "evidence": []},
                    ]
                },
                "transcript": [
                    {"type": "tool-call", "elapsed_ms": 250},
                    {
                        "type": "assistant-response",
                        "elapsed_ms": 800,
                        "metadata": {"assistantRequestElapsedMs": 900, "firstTokenLatencyMs": 100, "streamElapsedMs": 800},
                    },
                ],
            },
        }

        result = evaluate_artifact(artifact, source_blob="run/c11-0.json", fact_judge=fact_judge)

        self.assertEqual(result["status"], "evaluated")
        self.assertEqual(result["metrics"]["generation_accuracy"]["method"], "per_turn_macro_average")
        self.assertEqual(result["metrics"]["generation_accuracy"]["turn_count"], 2)
        self.assertEqual(result["metrics"]["generation_accuracy"]["score"], 0.5)
        self.assertEqual(
            [metric["score"] for metric in result["metrics"]["generation_accuracy"]["per_turn"]],
            [1.0, 0.0],
        )
        self.assertEqual(result["metrics"]["generation_recall"]["score"], 0.5)
        self.assertEqual(result["metrics"]["generation_precision"]["score"], 0.5)
        self.assertEqual(experiment_catalog_metrics(result)["generation_accuracy"], 0.5)

    def test_evaluate_artifact_uses_ground_truth_schema_when_output_schema_is_omitted(self):
        artifact = {
            "ground_truth": {
                "output": {
                    "answer": "Dracula wins by advancing influence.",
                    "evidence": [{"id": "expected-objective", "url": "fury-of-dracula-4e://rules/objective"}],
                },
                "schema": {
                    "type": "object",
                    "properties": {
                        "answer": {"type": "string"},
                        "evidence": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {"id": {"type": "string"}, "url": {"type": "string"}},
                                "required": ["id", "url"],
                                "additionalProperties": False,
                            },
                        },
                    },
                    "required": ["answer", "evidence"],
                    "additionalProperties": False,
                },
                "evaluation": {
                    "evidence_path": "/evidence",
                    "answer_path": "/answer",
                    "evidence_key": "url",
                },
            },
            "inference": {
                "ref": "ref-a",
                "run_folder": "run",
                "status": "completed",
                "elapsed_ms": 1234,
                "output": {
                    "answer": "Dracula wins by advancing influence.",
                    "evidence": [{"id": "actual-objective", "url": "fury-of-dracula-4e://rules/objective"}],
                },
                "transcript": [
                    {"type": "tool-call", "elapsed_ms": 250},
                    {
                        "type": "assistant-response",
                        "elapsed_ms": 800,
                        "metadata": {"assistantRequestElapsedMs": 900, "firstTokenLatencyMs": 100, "streamElapsedMs": 800},
                    },
                ],
            },
        }

        result = evaluate_artifact(artifact, source_blob="run/b00-0.json", fact_judge=equivalent_fact_judge)

        self.assertEqual(result["status"], "evaluated")
        self.assertEqual(result["metrics"]["output_structure"]["score"], 1.0)
        self.assertEqual(result["paths"]["has_output_schema"], True)

    def test_evaluate_artifact_applies_ignored_output_structure_issues(self):
        artifact = {
            "ground_truth": {
                "output": {
                    "turns": [
                        {
                            "question": "How does Dracula gain influence?",
                            "answer": "Through matured encounters.",
                            "evidence": [{"id": "expected-objective", "url": "fury-of-dracula-4e://rules/objective"}],
                        }
                    ]
                },
                "schema": {
                    "type": "object",
                    "properties": {
                        "turns": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "question": {"type": "string"},
                                    "evidence": {
                                        "type": "array",
                                        "items": {
                                            "type": "object",
                                            "properties": {"id": {"type": "string"}, "url": {"type": "string"}},
                                            "required": ["id", "url"],
                                            "additionalProperties": False,
                                        },
                                    },
                                    "answer": {"type": "string"},
                                },
                                "required": ["question", "evidence", "answer"],
                                "additionalProperties": False,
                            },
                        }
                    },
                    "required": ["turns"],
                    "additionalProperties": False,
                },
                "evaluation": {
                    "evidence_path": "/turns/0/evidence",
                    "answer_path": "/turns/0/answer",
                    "evidence_key": "url",
                    "ignored_output_structure_issues": [
                        {
                            "path": "/turns/1",
                            "keyword": "required",
                            "message": "Missing required property: evidence.",
                        }
                    ],
                },
            },
            "inference": {
                "ref": "ref-a",
                "run_folder": "run",
                "status": "completed",
                "elapsed_ms": 1234,
                "output": {
                    "turns": [
                        {
                            "question": "How does Dracula gain influence?",
                            "answer": "Through matured encounters.",
                            "evidence": [{"id": "actual-objective", "url": "fury-of-dracula-4e://rules/objective"}],
                        },
                        {
                            "question": "Generate a new answer based on this evidence.",
                            "answer": "Dracula gains influence through matured encounters.",
                        },
                    ]
                },
                "transcript": [
                    {"type": "tool-call", "elapsed_ms": 250},
                    {
                        "type": "assistant-response",
                        "elapsed_ms": 800,
                        "metadata": {"assistantRequestElapsedMs": 900, "firstTokenLatencyMs": 100, "streamElapsedMs": 800},
                    },
                ],
            },
        }

        result = evaluate_artifact(artifact, source_blob="run/c05-0.json", fact_judge=equivalent_fact_judge)

        self.assertEqual(result["status"], "evaluated")
        self.assertEqual(result["metrics"]["output_structure"]["score"], 1.0)
        self.assertEqual(result["metrics"]["output_structure"]["issue_count"], 0)
        self.assertEqual(result["metrics"]["output_structure"]["ignored_issue_count"], 1)
        self.assertEqual(result["paths"]["ignored_output_structure_issue_count"], 1)

    def test_evaluate_artifact_omits_retrieval_recall_when_evidence_key_is_omitted(self):
        artifact = {
            "ground_truth": {
                "output": {
                    "answer": "Dracula wins by advancing influence.",
                    "evidence": [{"id": "objective"}],
                },
                "evaluation": {
                    "evidence_path": "/evidence",
                    "answer_path": "/answer",
                    "output_schema": {
                        "type": "object",
                        "properties": {
                            "answer": {"type": "string"},
                            "evidence": {"type": "array"},
                        },
                        "required": ["answer", "evidence"],
                        "additionalProperties": False,
                    },
                },
            },
            "inference": {
                "ref": "ref-a",
                "run_folder": "run",
                "status": "completed",
                "elapsed_ms": 1234,
                "output": {
                    "answer": "Dracula wins by advancing influence.",
                    "evidence": [{"id": "objective"}],
                },
                "transcript": [
                    {"type": "tool-call", "elapsed_ms": 250},
                    {
                        "type": "assistant-response",
                        "elapsed_ms": 800,
                        "metadata": {"assistantRequestElapsedMs": 900, "firstTokenLatencyMs": 100, "streamElapsedMs": 800},
                    },
                ],
            },
        }

        result = evaluate_artifact(artifact, source_blob="run/no-evidence-key-0.json", fact_judge=equivalent_fact_judge)

        self.assertEqual(result["status"], "evaluated")
        self.assertIsNone(result["paths"]["evidence_key"])
        self.assertNotIn("retrieval_recall", result["metrics"])

    def test_evaluate_artifact_keeps_timeout_outputs_catalog_publishable(self):
        def fail_if_called(_expected_answer, _actual_answer):
            raise AssertionError("timeout artifacts should not call the fact judge")

        artifact = {
            "ground_truth": {
                "output": {
                    "answer": "Dracula wins by advancing influence.",
                    "evidence": [{"id": "objective"}],
                },
                "evaluation": {
                    "output_schema": {
                        "type": "object",
                        "properties": {
                            "answer": {"type": "string"},
                            "evidence": {"type": "array"},
                        },
                        "required": ["answer", "evidence"],
                        "additionalProperties": False,
                    },
                },
            },
            "inference": {
                "ref": "ref-a",
                "run_folder": "run",
                "status": "timeout",
                "elapsed_ms": 4079,
                "output": {},
                "transcript": [
                    {"type": "user-prompt", "elapsed_ms": 0},
                    {"type": "event", "elapsed_ms": 0},
                ],
                "error": {"code": "INFERENCE_TIMEOUT", "message": "Inference prompt timed out."},
            },
        }

        result = evaluate_artifact(artifact, source_blob="run/b00-7.json", fact_judge=fail_if_called)

        self.assertEqual(result["status"], "evaluated")
        self.assertEqual(result["source_status"], "timeout")
        self.assertNotIn("retrieval_recall", result["metrics"])
        self.assertEqual(result["metrics"]["generation_accuracy"]["score"], 0.0)
        self.assertEqual(result["metrics"]["generation_recall"]["score"], 0.0)
        self.assertEqual(result["metrics"]["generation_precision"]["score"], 0.0)
        self.assertEqual(result["metrics"]["output_structure"]["score"], 0.0)
        self.assertEqual(
            experiment_catalog_metrics(result),
            {
                "generation_accuracy": 0.0,
                "generation_recall": 0.0,
                "generation_precision": 0.0,
                "output_structure": 0.0,
                "meta_total_elapsed_ms": 4079,
                "meta_assistant_request_elapsed_ms": 0,
                "meta_first_token_latency_ms": 0,
                "meta_stream_elapsed_ms": 0,
                "meta_tool_elapsed_ms": 0,
                "meta_unattributed_elapsed_ms": 4079,
            },
        )


def equivalent_fact_judge(_expected_answer, _actual_answer):
    return {
        "schema_version": "review-assistant.fact-judge.v1",
        "ground_truth_facts": [{"id": "gt-1", "fact": "Dracula wins by advancing influence."}],
        "inference_facts": [{"id": "inf-1", "fact": "Dracula wins by advancing influence."}],
        "comparisons": [
            {
                "ground_truth_fact_id": "gt-1",
                "inference_fact_ids": ["inf-1"],
                "label": "equivalent",
                "rationale": "The statements are identical.",
            }
        ],
    }


class FakeHttpResponse:
    def __init__(self, status, body=""):
        self.status = status
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _traceback):
        return False

    def getcode(self):
        return self.status

    def read(self):
        return self.body.encode("utf-8")


def json_from_request(request):
    return __import__("json").loads(request.data.decode("utf-8"))


if __name__ == "__main__":
    unittest.main()
