import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import notify
import run


class ModelPreflightTests(unittest.TestCase):
    def test_accepts_exact_free_tool_model(self) -> None:
        value = run.validate_model_metadata(
            {
                "data": {
                    "id": "cohere/north-mini-code:free",
                    "canonical_slug": "cohere/north-mini-code",
                    "supported_parameters": ["tools", "temperature"],
                    "pricing": {"prompt": "0", "completion": "0", "request": None},
                }
            },
            "cohere/north-mini-code:free",
        )
        self.assertTrue(value["supports_tools"])

    def test_rejects_paid_or_toolless_model(self) -> None:
        cases = [
            {"supported_parameters": ["tools"], "pricing": {"prompt": "0.1", "completion": "0"}},
            {"supported_parameters": [], "pricing": {"prompt": "0", "completion": "0"}},
        ]
        for partial in cases:
            with self.subTest(partial=partial):
                with self.assertRaises(run.CanaryFailure):
                    run.validate_model_metadata(
                        {"data": {"id": "m:free", **partial}}, "m:free"
                    )


class EventParsingTests(unittest.TestCase):
    def test_extracts_only_counts_and_token_totals(self) -> None:
        raw = b"\n".join(
            [
                json.dumps(
                    {"type": "text", "part": {"type": "text", "text": "private output"}}
                ).encode(),
                json.dumps({"type": "tool_use", "part": {"type": "tool"}}).encode(),
                json.dumps(
                    {
                        "type": "step_finish",
                        "part": {
                            "type": "step-finish",
                            "reason": "stop",
                            "tokens": {"input": 10, "output": 4, "reasoning": 2},
                        },
                    }
                ).encode(),
            ]
        )
        summary = run.parse_opencode_events(raw)
        self.assertEqual(summary["agent_steps"], 1)
        self.assertEqual(summary["tool_calls"], 1)
        self.assertEqual(summary["tokens"]["input"], 10)
        self.assertEqual(summary["text_characters"], len("private output"))
        self.assertEqual(summary["part_types"], {"text": 1, "tool": 1, "step-finish": 1})
        self.assertEqual(summary["finish_reasons"], {"stop": 1})
        self.assertNotIn("private output", json.dumps(summary))

    def test_extracts_bounded_retry_after(self) -> None:
        self.assertEqual(run.extract_retry_after_seconds(b"Retry-After: 17"), 17)
        self.assertEqual(run.extract_retry_after_seconds(b"Retry-After: 9999"), 300)
        self.assertEqual(run.extract_retry_after_seconds(b"no hint"), 60)


class GateAndClassificationTests(unittest.TestCase):
    def test_workflow_maps_secrets_to_canonical_canary_environment(self) -> None:
        workflow = (
            Path(__file__).resolve().parents[3]
            / ".github"
            / "workflows"
            / "opencode-e2e.yml"
        ).read_text()
        self.assertIn(
            "NOTARYD_E2E_API_KEY: ${{ secrets.NOTARY_E2E_API_KEY }}",
            workflow,
        )
        self.assertIn(
            "NOTARYD_E2E_SLACK_WEBHOOK_URL: "
            "${{ secrets.NOTARY_SLACK_WEBHOOK_URL }}",
            workflow,
        )

    def test_parser_exposes_the_canonical_notaryd_option(self) -> None:
        with patch.object(sys, "argv", ["run.py", "--notaryd", "/tmp/notaryd"]):
            arguments = run.parse_arguments()
        self.assertEqual(arguments.notaryd, "/tmp/notaryd")
        self.assertFalse(hasattr(arguments, "llm_notaryd"))

    def test_notarization_uses_the_trace_wait_command(self) -> None:
        canary = run.Canary.__new__(run.Canary)
        canary.cli = ["notaryctl", "--json"]
        canary.environment = {}
        canary.arguments = SimpleNamespace(notarization_timeout=60)

        with (
            patch.object(
                run,
                "run_json",
                side_effect=[
                    {"operation": {"operation_id": "op-1", "state": "succeeded"}},
                    RuntimeError("stop after notarization"),
                ],
            ) as run_json,
            patch.object(run.time, "sleep"),
            self.assertRaisesRegex(RuntimeError, "stop after notarization"),
        ):
            canary.notarize_verify_share(
                [{"trace_id": "trc-1"}],
                {"notarizations": [], "shares": []},
            )

        self.assertEqual(
            run_json.call_args_list[0].args[0],
            ["notaryctl", "--json", "traces", "notarize", "trc-1", "--wait"],
        )

    def test_notarization_uses_canonical_verification_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            canary = run.Canary.__new__(run.Canary)
            canary.cli = [
                "notaryctl",
                "--json",
                "--config",
                "/private/config.toml",
            ]
            canary.environment = {}
            canary.arguments = SimpleNamespace(
                notarization_timeout=60,
                share_timeout=60,
            )
            canary.admin_origin = "http://127.0.0.1:8788"
            canary.root = Path(directory)
            result = {"notarizations": [], "shares": []}
            download = MagicMock()
            download.read.return_value = b"trace-package"
            download.__enter__.return_value = download

            with (
                patch.object(
                    run,
                    "run_json",
                    side_effect=[
                        {
                            "operation": {
                                "operation_id": "op-1",
                                "state": "succeeded",
                            }
                        },
                        {"outcome": "passed", "trace_id": "trc-1"},
                        {},
                        {
                            "trace_id": "trc-1",
                            "progress": "shared",
                            "package_url": "https://example.test/package.llmtrace",
                            "share_url": "https://example.test/s/trc-1",
                        },
                        {"outcome": "passed", "trace_id": "trc-1"},
                    ],
                ) as run_json,
                patch.object(run.urllib.request, "urlopen", return_value=download),
            ):
                canary.notarize_verify_share([{"trace_id": "trc-1"}], result)

        self.assertEqual(len(result["notarizations"]), 1)
        self.assertEqual(len(result["shares"]), 1)
        self.assertEqual(
            run_json.call_args_list[-1].args[0][:-1],
            [
                "notaryctl",
                "--json",
                "--config",
                "/private/config.toml",
                "traces",
                "verify",
            ],
        )

    def test_canary_publications_are_listed(self) -> None:
        self.assertEqual(run.SHARE_VISIBILITY, "listed")

    def test_disclosure_scanner_reports_names_and_counts_only(self) -> None:
        value = {
            "header": "Authorization: Bearer token-value",
            "path": "/home/runner/work/private",
            "contact": "person@example.com",
        }
        violations = run.scan_disclosure(value)
        self.assertEqual(
            set(violations),
            {"authorization_value", "home_or_runner_path", "email_address"},
        )
        self.assertNotIn("token-value", json.dumps(violations))

    def test_diff_allowlist_is_exact(self) -> None:
        self.assertTrue(run.validate_changed_files(["retry_after.py"]))
        self.assertFalse(run.validate_changed_files([]))
        self.assertFalse(run.validate_changed_files(["retry_after.py", "TASK.md"]))

    def test_classifies_transient_and_auth_provider_failures(self) -> None:
        self.assertEqual(
            run.classify_provider_failure([{"http_status": 429}]),
            "provider_rate_limited",
        )
        self.assertEqual(
            run.classify_provider_failure([{"http_status": 503}]),
            "model_unavailable",
        )
        self.assertEqual(
            run.classify_provider_failure([{"http_status": 401}]),
            "provider_auth_failed",
        )

    def test_retries_one_successful_response_that_made_no_tool_call(self) -> None:
        self.assertEqual(
            run.classify_attempt_failure([{"http_status": 200}], 0, 0, False),
            ("agent_no_tool_call", True),
        )
        self.assertEqual(
            run.classify_attempt_failure([{"http_status": 200}], 1, 0, False),
            ("agent_task_failed", False),
        )

    def test_retries_post_task_exit_only_for_an_eligible_trace_set(self) -> None:
        self.assertEqual(
            run.classify_attempt_failure(
                [{"http_status": 200, "notarization_eligible": True}], 1, 4, True
            ),
            ("agent_post_task_error", True),
        )
        self.assertEqual(
            run.classify_attempt_failure(
                [{"http_status": 200, "notarization_eligible": False}], 1, 4, True
            ),
            ("agent_task_failed", False),
        )

    def test_agent_environment_drops_unrelated_credentials(self) -> None:
        value = run.scrub_agent_environment(
            {"PATH": "/bin", "OPENAI_API_KEY": "paid", "GITHUB_TOKEN": "secret"},
            "free",
        )
        self.assertEqual(value["OPENROUTER_API_KEY"], "free")
        self.assertNotIn("OPENAI_API_KEY", value)
        self.assertNotIn("GITHUB_TOKEN", value)

    def test_daemon_environment_drops_unrelated_credentials(self) -> None:
        value = run.scrub_sensitive_environment(
            {"PATH": "/bin", "OPENAI_API_KEY": "paid", "GITHUB_TOKEN": "secret"}
        )
        self.assertEqual(value, {"PATH": "/bin"})

    def test_cleanup_removes_private_tree(self) -> None:
        root = Path(tempfile.mkdtemp())
        (root / "secret").write_text("value", encoding="utf-8")
        run.cleanup_private_path(root)
        self.assertFalse(root.exists())


class NotificationTests(unittest.TestCase):
    def test_payload_is_compact_and_contains_only_public_links(self) -> None:
        payload = notify.slack_payload(
            {
                "status": "passed",
                "model": {"requested_openrouter_model": "model:free"},
                "summary": {
                    "attempt_count": 1,
                    "model_turns": 2,
                    "eligible_traces": 2,
                    "tokens": {"input": 10, "output": 4},
                    "opencode_wall_ms": 1200,
                    "proof_wall_ms": 2300,
                },
                "total_wall_ms": 5000,
                "shares": [
                    {
                        "trace_id": "trc-1",
                        "share_url": "https://example.test/s/share-1",
                    }
                ],
            }
        )
        encoded = json.dumps(payload)
        self.assertIn("trc-1", encoded)
        self.assertLess(len(encoded), 3000)


if __name__ == "__main__":
    unittest.main()
