import hashlib
import hmac
import unittest
from datetime import datetime, timezone

from github_webhook import normalize_event, supported_event, verify_signature


class GitHubWebhookTests(unittest.TestCase):
    def test_signature_validation_uses_exact_body(self):
        body = b'{"action":"completed"}'
        signature = "sha256=" + hmac.new(b"secret", body, hashlib.sha256).hexdigest()
        self.assertTrue(verify_signature("secret", body, signature))
        self.assertFalse(verify_signature("secret", body + b" ", signature))
        self.assertFalse(verify_signature("secret", body, "sha256=bad"))

    def test_supported_events_are_explicit(self):
        self.assertTrue(supported_event("workflow_run"))
        self.assertTrue(supported_event("check_run"))
        self.assertTrue(supported_event("workflow_job"))
        self.assertFalse(supported_event("push"))

    def test_normalizes_workflow_run_without_raw_actor(self):
        record = normalize_event(
            "workflow_run",
            {
                "action": "completed",
                "repository": {"id": 17, "full_name": "EEOC/example"},
                "sender": {"login": "octocat"},
                "installation": {"id": 91},
                "workflow_run": {
                    "id": 42,
                    "name": "CI",
                    "head_branch": "main",
                    "head_sha": "ABCDEF1234",
                    "status": "completed",
                    "conclusion": "failure",
                    "run_started_at": "2026-09-30T12:00:00Z",
                    "updated_at": "2026-09-30T12:02:03Z",
                    "html_url": "https://github.com/EEOC/example/actions/runs/42",
                },
            },
            "delivery-1",
            received_at=datetime(2026, 9, 30, 12, 2, 4, tzinfo=timezone.utc),
        )

        self.assertEqual(record["Repository"], "EEOC/example")
        self.assertEqual(record["WorkflowName"], "CI")
        self.assertEqual(record["WorkflowRunId"], "42")
        self.assertEqual(record["CommitSha"], "abcdef1234")
        self.assertEqual(record["DurationMs"], 123000)
        self.assertEqual(record["DeliveryId"], "delivery-1")
        self.assertEqual(record["ActorHash"], hashlib.sha256(b"octocat").hexdigest())
        self.assertNotIn("octocat", str(record))


if __name__ == "__main__":
    unittest.main()
