"""Azure Functions entry points for authenticated GitHub workflow telemetry."""

from __future__ import annotations

import json
import os
import re
from functools import lru_cache
from typing import Any
from urllib.parse import quote

import azure.functions as func
import requests
from azure.core.exceptions import ResourceExistsError
from azure.data.tables import TableClient, UpdateMode
from azure.identity import DefaultAzureCredential

from github_webhook import normalize_event, supported_event, verify_signature

app = func.FunctionApp()
_DELIVERY_ID = re.compile(r"^[A-Za-z0-9-]{1,128}$")


@lru_cache(maxsize=1)
def _credential() -> DefaultAzureCredential:
    client_id = os.environ.get("AZURE_CLIENT_ID") or None
    return DefaultAzureCredential(managed_identity_client_id=client_id)


def _table() -> TableClient:
    account = os.environ["WEBHOOK_STORAGE_ACCOUNT"]
    name = os.environ.get("GITHUB_DELIVERY_TABLE", "GitHubWebhookDeliveries")
    return TableClient(
        endpoint=f"https://{account}.table.core.windows.net",
        table_name=name,
        credential=_credential(),
    )


def _upload(record: dict[str, Any]) -> None:
    endpoint = os.environ["SAMASARA_AZURE_LOGS_ENDPOINT"].rstrip("/")
    rule_id = os.environ["SAMASARA_AZURE_DCR_ID"]
    stream = os.environ.get("SAMASARA_WORKFLOW_STREAM", "Custom-SamasaraWorkflow")
    token = _credential().get_token("https://monitor.azure.com/.default").token
    response = requests.post(
        f"{endpoint}/dataCollectionRules/{quote(rule_id, safe='')}/streams/{quote(stream, safe='')}?api-version=2023-01-01",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json=[record],
        timeout=10,
    )
    response.raise_for_status()


@app.function_name(name="ReceiveGitHubWebhook")
@app.route(route="github/webhook", methods=["POST"], auth_level=func.AuthLevel.ANONYMOUS)
@app.queue_output(
    arg_name="output",
    queue_name="github-webhooks",
    connection="AzureWebJobsStorage",
)
def receive_github_webhook(req: func.HttpRequest, output: func.Out[str]) -> func.HttpResponse:
    body = req.get_body()
    secret = os.environ.get("GITHUB_WEBHOOK_SECRET", "")
    if not verify_signature(secret, body, req.headers.get("X-Hub-Signature-256")):
        return func.HttpResponse("invalid signature", status_code=401)

    delivery_id = req.headers.get("X-GitHub-Delivery", "")
    event_name = req.headers.get("X-GitHub-Event", "")
    if not _DELIVERY_ID.fullmatch(delivery_id):
        return func.HttpResponse("invalid delivery id", status_code=400)
    if not supported_event(event_name):
        return func.HttpResponse(status_code=204)
    try:
        payload = req.get_json()
    except ValueError:
        return func.HttpResponse("invalid JSON", status_code=400)
    if not isinstance(payload, dict):
        return func.HttpResponse("expected JSON object", status_code=400)
    try:
        record = normalize_event(event_name, payload, delivery_id)
    except (TypeError, ValueError):
        return func.HttpResponse("invalid event payload", status_code=400)

    output.set(json.dumps({"deliveryId": delivery_id, "record": record}))
    return func.HttpResponse(status_code=202)


@app.function_name(name="ProcessGitHubWebhook")
@app.queue_trigger(
    arg_name="message",
    queue_name="github-webhooks",
    connection="AzureWebJobsStorage",
)
def process_github_webhook(message: func.QueueMessage) -> None:
    envelope = json.loads(message.get_body().decode("utf-8"))
    delivery_id = envelope["deliveryId"]
    table = _table()
    entity = {"PartitionKey": "github", "RowKey": delivery_id, "Status": "processing"}
    try:
        table.create_entity(entity)
    except ResourceExistsError:
        if int(message.dequeue_count or 1) <= 1:
            return
        table.upsert_entity(entity, mode=UpdateMode.REPLACE)

    try:
        _upload(envelope["record"])
        entity["Status"] = "completed"
        table.update_entity(entity, mode=UpdateMode.REPLACE)
    except Exception:
        table.delete_entity("github", delivery_id)
        raise
