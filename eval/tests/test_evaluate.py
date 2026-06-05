import unittest

from eval.evaluate import (
    evaluate_artifact,
    evaluation_blob_name,
    generation_correctness,
    record_correctness,
    retrieval_recall,
    resolve_json_pointer,
)


class EvaluateMetricsTests(unittest.TestCase):
    def test_evaluation_blob_name_replaces_json_suffix(self):
        self.assertEqual(evaluation_blob_name("run/a00-0.json"), "run/a00-0.eval.json")

    def test_json_pointer_resolves_objects_and_arrays(self):
        value = {"turns": [{"answer": "done"}]}
        self.assertEqual(resolve_json_pointer(value, "/turns/0/answer"), "done")

    def test_retrieval_recall_matches_expected_evidence_by_id(self):
        metric = retrieval_recall(
            [{"id": "doc-a"}, {"id": "doc-b"}],
            [{"id": "doc-a"}, {"id": "doc-c"}],
        )
        self.assertEqual(metric["score"], 0.5)
        self.assertEqual(metric["missing_evidence"], ["id:doc-b"])

    def test_generation_correctness_scores_expected_facts_against_answer(self):
        metric = generation_correctness(
            "Dracula advances the influence track. Dracula matures vampires.",
            "Dracula wins by advancing the influence track after vampires mature.",
        )
        self.assertGreater(metric["score"], 0.7)
        self.assertLess(metric["score"], 1.0)

    def test_record_correctness_counts_union_of_leaf_properties(self):
        metric = record_correctness({"a": 1, "b": {"c": 2}}, {"a": 1, "b": {"c": 3}, "d": 4})
        self.assertEqual(metric["matching_properties"], 1)
        self.assertEqual(metric["total_properties"], 3)
        self.assertEqual(metric["score"], 0.333333)

    def test_evaluate_artifact_uses_explicit_ground_truth_paths(self):
        artifact = {
            "ground_truth": {
                "output": {
                    "turns": [
                        {
                            "answer": "Dracula wins by advancing influence.",
                            "evidence": [{"id": "objective"}],
                        }
                    ]
                },
                "evaluation": {
                    "evidence_path": "/turns/0/evidence",
                    "answer_path": "/turns/0/answer",
                },
            },
            "inference": {
                "status": "completed",
                "output": {
                    "turns": [
                        {
                            "answer": "Dracula wins by advancing influence.",
                            "evidence": [{"id": "objective"}],
                        }
                    ]
                },
            },
        }

        result = evaluate_artifact(artifact, source_blob="run/c00-0.json")

        self.assertEqual(result["status"], "evaluated")
        self.assertEqual(result["metrics"]["retrieval_recall"]["score"], 1.0)
        self.assertEqual(result["metrics"]["generation_correctness"]["score"], 1.0)
        self.assertEqual(result["metrics"]["record_correctness"]["score"], 1.0)


if __name__ == "__main__":
    unittest.main()
