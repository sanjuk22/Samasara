"""Pure validation and normalization for GitHub Actions webhook telemetry."""

from __future__ import annotations

import hashlib
import hmac
from datetime import datetime, timezone
from typing import Any, Mapping

_SUPPORTED_EVENTS = frozenset({"workflow_run", "check_run", "workflow_job"})


def verify_signature(secret: str, body: bytes, supplied: str | None) -> bool:
    if not secret or not supplied or not supplied.startswith("sha256="):
        return False
    expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, supplied)


def supported_event(event_name: str | None) -> bool:
    return bool(event_name in _SUPPORTED_EVENTS)


def _text(value: Any, maximum: int = 512) -> str:
    return str(value or "")[:maximum]


def _timestamp(value: Any) -> str | None:
    text = _text(value, 64)
    if not text:
        return None
    parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _duration_ms(started_at: str | None, completed_at: str | None) -> int | None:
    if not started_at or not completed_at:
        return None
    start = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
    end = datetime.fromisoformat(completed_at.replace("Z", "+00:00"))
    return max(0, round((end - start).total_seconds() * 1000))


def normalize_event(
    event_name: str,
    payload: Mapping[str, Any],
    delivery_id: str,
    *,
    received_at: datetime | None = None,
) -> dict[str, Any]:
    if event_name not in _SUPPORTED_EVENTS:
        raise ValueError("unsupported GitHub webhook event")
    subject = payload.get(event_name)
    if not isinstance(subject, Mapping):
        raise ValueError(f"payload is missing {event_name}")

    repository = payload.get("repository")
    repository = repository if isinstance(repository, Mapping) else {}
    sender = payload.get("sender")
    sender = sender if isinstance(sender, Mapping) else {}

    if event_name == "workflow_run":
        workflow_name = _text(subject.get("name"), 256)
        workflow_run_id = _text(subject.get("id"), 64)
        job_name = ""
        branch = _text(subject.get("head_branch"), 256)
        commit_sha = _text(subject.get("head_sha"), 64).lower()
        started_at = _timestamp(subject.get("run_started_at") or subject.get("created_at"))
        completed_at = _timestamp(subject.get("updated_at")) if subject.get("conclusion") else None
    elif event_name == "workflow_job":
        workflow_name = _text(subject.get("workflow_name"), 256)
        workflow_run_id = _text(subject.get("run_id"), 64)
        job_name = _text(subject.get("name"), 256)
        branch = _text(subject.get("head_branch"), 256)
        commit_sha = _text(subject.get("head_sha"), 64).lower()
        started_at = _timestamp(subject.get("started_at"))
        completed_at = _timestamp(subject.get("completed_at"))
    else:
        check_suite = subject.get("check_suite")
        check_suite = check_suite if isinstance(check_suite, Mapping) else {}
        workflow_name = ""
        workflow_run_id = _text(check_suite.get("id"), 64)
        job_name = _text(subject.get("name"), 256)
        branch = _text(check_suite.get("head_branch"), 256)
        commit_sha = _text(subject.get("head_sha") or check_suite.get("head_sha"), 64).lower()
        started_at = _timestamp(subject.get("started_at"))
        completed_at = _timestamp(subject.get("completed_at"))

    actor = _text(sender.get("login"), 320).strip().lower()
    now = received_at or datetime.now(timezone.utc)
    return {
        "TimeGenerated": now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "Repository": _text(repository.get("full_name"), 256),
        "WorkflowName": workflow_name,
        "WorkflowRunId": workflow_run_id,
        "JobName": job_name,
        "EventName": event_name,
        "ActorHash": hashlib.sha256(actor.encode()).hexdigest() if actor else "",
        "CommitSha": commit_sha,
        "Branch": branch,
        "Status": _text(subject.get("status"), 64),
        "Conclusion": _text(subject.get("conclusion"), 64),
        "StartedAt": started_at,
        "CompletedAt": completed_at,
        "DurationMs": _duration_ms(started_at, completed_at),
        "RunUrl": _text(subject.get("html_url"), 1024),
        "DeliveryId": delivery_id,
        "Payload": {
            "action": _text(payload.get("action"), 64),
            "repository_id": repository.get("id"),
            "installation_id": (payload.get("installation") or {}).get("id")
            if isinstance(payload.get("installation"), Mapping)
            else None,
        },
    }
