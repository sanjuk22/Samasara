import hashlib
import hmac
import json
import os
import unittest
from unittest.mock import patch

from azure.core.exceptions import ResourceExistsError

import function_app


class Request:
    def __init__(self, body, headers):
        self._body = body
        self.headers = headers

    def get_body(self):
        return self._body

    def get_json(self):
        return json.loads(self._body)


class Output:
    value = None

    def set(self, value):
        self.value = value


class Message:
    def __init__(self, envelope, dequeue_count=1):
        self._body = json.dumps(envelope).encode()
        self.dequeue_count = dequeue_count

    def get_body(self):
        return self._body


class Table:
    def __init__(self, duplicate=False):
        self.duplicate = duplicate
        self.created = []
        self.updated = []
        self.deleted = []

    def create_entity(self, entity):
        if self.duplicate:
            raise ResourceExistsError("duplicate")
        self.created.append(dict(entity))

    def upsert_entity(self, entity, mode):
        self.created.append(dict(entity))

    def update_entity(self, entity, mode):
        self.updated.append(dict(entity))

    def delete_entity(self, partition_key, row_key):
        self.deleted.append((partition_key, row_key))


class FunctionBoundaryTests(unittest.TestCase):
    def setUp(self):
        os.environ["GITHUB_WEBHOOK_SECRET"] = "secret"

    def test_valid_delivery_queues_only_normalized_record(self):
        payload = {
            "action": "completed",
            "repository": {"id": 1, "full_name": "EEOC/example"},
            "sender": {"login": "octocat"},
            "workflow_run": {
                "id": 42,
                "name": "CI",
                "head_branch": "main",
                "head_sha": "abc1234",
                "status": "completed",
                "conclusion": "success",
                "run_started_at": "2026-09-30T12:00:00Z",
                "updated_at": "2026-09-30T12:01:00Z",
            },
        }
        body = json.dumps(payload).encode()
        signature = "sha256=" + hmac.new(b"secret", body, hashlib.sha256).hexdigest()
        output = Output()
        response = function_app.receive_github_webhook(Request(body, {
            "X-Hub-Signature-256": signature,
            "X-GitHub-Delivery": "delivery-42",
            "X-GitHub-Event": "workflow_run",
        }), output)

        self.assertEqual(response.status_code, 202)
        queued = json.loads(output.value)
        self.assertEqual(queued["deliveryId"], "delivery-42")
        self.assertEqual(queued["record"]["Repository"], "EEOC/example")
        self.assertNotIn("octocat", output.value)
        self.assertNotIn("payload", queued)

    def test_invalid_signature_is_not_queued(self):
        output = Output()
        response = function_app.receive_github_webhook(Request(b"{}", {
            "X-Hub-Signature-256": "sha256=bad",
            "X-GitHub-Delivery": "delivery-42",
            "X-GitHub-Event": "workflow_run",
        }), output)
        self.assertEqual(response.status_code, 401)
        self.assertIsNone(output.value)

    def test_worker_marks_successful_delivery_complete(self):
        table = Table()
        uploads = []
        envelope = {"deliveryId": "delivery-42", "record": {"DeliveryId": "delivery-42"}}
        with patch.object(function_app, "_table", return_value=table), patch.object(
            function_app, "_upload", side_effect=uploads.append
        ):
            function_app.process_github_webhook(Message(envelope))

        self.assertEqual(uploads, [{"DeliveryId": "delivery-42"}])
        self.assertEqual(table.updated[0]["Status"], "completed")

    def test_duplicate_first_delivery_is_not_uploaded_again(self):
        table = Table(duplicate=True)
        uploads = []
        envelope = {"deliveryId": "delivery-42", "record": {"DeliveryId": "delivery-42"}}
        with patch.object(function_app, "_table", return_value=table), patch.object(
            function_app, "_upload", side_effect=uploads.append
        ):
            function_app.process_github_webhook(Message(envelope))
        self.assertEqual(uploads, [])


if __name__ == "__main__":
    unittest.main()
