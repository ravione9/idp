"""
LILG True-in Hourly Ingest DAG
================================
Runs every hour. Ingests delta attendance from True-in and re-aggregates.

Tasks:
  1. backpressure_sensor    — skip if outbox queue > 5000
  2. ingest_truein_hourly   — POST /api/internal/ingest/truein?delta=true
  3. run_activity_aggregator — POST /api/internal/aggregate (delta only)
"""

from __future__ import annotations

import json
import os
from datetime import timedelta

import pendulum
import requests  # type: ignore[import-untyped]
from airflow import DAG
from airflow.exceptions import AirflowSkipException
from airflow.operators.python import PythonOperator
from airflow.providers.http.operators.http import SimpleHttpOperator
from airflow.utils.context import Context

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
LILG_BASE_URL   = os.environ.get("LILG_INTERNAL_BASE_URL", "http://lilg-api:8080")
INTERNAL_TOKEN  = os.environ.get("LILG_INTERNAL_TOKEN", "change-me")
MAX_QUEUE_DEPTH = 5_000

IST = pendulum.timezone("Asia/Kolkata")

DEFAULT_ARGS = {
    "owner":              "lilg-platform",
    "depends_on_past":    False,
    "retries":            3,
    "retry_delay":        timedelta(seconds=300),
    "email_on_failure":   False,
    "email_on_retry":     False,
}

INTERNAL_HEADERS = {
    "Content-Type":     "application/json",
    "X-Internal-Token": INTERNAL_TOKEN,
}


# ---------------------------------------------------------------------------
# Backpressure sensor
# ---------------------------------------------------------------------------
def backpressure_sensor(**context: object) -> None:
    """
    Call the LILG queue health endpoint and raise AirflowSkipException
    if the pending queue depth exceeds MAX_QUEUE_DEPTH.
    This prevents avalanche-style outbox growth when adapters are degraded.
    """
    resp = requests.get(
        f"{LILG_BASE_URL}/api/internal/admin/health/queue",
        headers={"X-Internal-Token": INTERNAL_TOKEN},
        timeout=10,
    )
    resp.raise_for_status()

    data        = resp.json()
    queue_depth = data.get("queue_depth", 0)

    if queue_depth > MAX_QUEUE_DEPTH:
        raise AirflowSkipException(
            f"Outbox queue depth ({queue_depth}) exceeds threshold ({MAX_QUEUE_DEPTH}). "
            "Skipping True-in ingest to relieve backpressure."
        )

    print(f"Queue depth OK: {queue_depth} / {MAX_QUEUE_DEPTH}")


# ---------------------------------------------------------------------------
# DAG definition
# ---------------------------------------------------------------------------
with DAG(
    dag_id          = "lilg_truein_hourly",
    description     = "LILG hourly True-in attendance delta ingest",
    start_date      = pendulum.datetime(2024, 1, 1, tz=IST),
    schedule        = "@hourly",
    catchup         = False,
    max_active_runs = 1,
    default_args    = DEFAULT_ARGS,
    tags            = ["lilg", "truein", "hourly"],
    doc_md          = __doc__,
) as dag:

    # 1. Backpressure sensor
    t1_backpressure = PythonOperator(
        task_id         = "backpressure_sensor",
        python_callable = backpressure_sensor,
    )

    # 2. Delta ingest from True-in
    t2_ingest_truein = SimpleHttpOperator(
        task_id        = "ingest_truein_hourly",
        http_conn_id   = "lilg_internal_api",
        endpoint       = "/api/internal/ingest/truein",
        method         = "POST",
        headers        = INTERNAL_HEADERS,
        data           = json.dumps({"delta": True}),
        response_check = lambda resp: resp.status_code == 200,
        log_response   = True,
    )

    # 3. Re-aggregate activity (delta only — last 2 days)
    t3_aggregate = SimpleHttpOperator(
        task_id        = "run_activity_aggregator_delta",
        http_conn_id   = "lilg_internal_api",
        endpoint       = "/api/internal/aggregate",
        method         = "POST",
        headers        = INTERNAL_HEADERS,
        data           = json.dumps({"delta": True}),
        response_check = lambda resp: resp.status_code == 200,
        log_response   = True,
    )

    # Dependencies
    t1_backpressure >> t2_ingest_truein >> t3_aggregate
