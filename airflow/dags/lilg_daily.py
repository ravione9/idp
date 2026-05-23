"""
LILG Daily Pipeline DAG
=======================
Runs at 00:30 IST every day.

Task order:
  1. refresh_holiday_calendar
  2. ingest_hrms_roster
  3. ingest_truein_attendance
  4. ingest_leave_records
  5. run_activity_aggregator
  6. run_risk_engine
  7. send_manager_digest
  8. send_hrbp_digest

All tasks call LILG internal API endpoints with X-Internal-Token auth.
On failure: sends SNS alert. Retries: 3. Retry delay: 5 minutes.
"""

from __future__ import annotations

import json
import os
from datetime import timedelta

import boto3
import pendulum
from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.providers.http.operators.http import SimpleHttpOperator
from airflow.utils.context import Context

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
LILG_BASE_URL = os.environ.get("LILG_INTERNAL_BASE_URL", "http://lilg-api:8080")
INTERNAL_TOKEN = os.environ.get("LILG_INTERNAL_TOKEN", "change-me")
SNS_ALERT_ARN = os.environ.get("LILG_SNS_ALERT_ARN", "")
AWS_REGION = os.environ.get("AWS_DEFAULT_REGION", "ap-south-1")

IST = pendulum.timezone("Asia/Kolkata")

DEFAULT_ARGS = {
    "owner":              "lilg-platform",
    "depends_on_past":    False,
    "retries":            3,
    "retry_delay":        timedelta(seconds=300),
    "retry_exponential_backoff": True,
    "max_retry_delay":    timedelta(hours=1),
    "email_on_failure":   False,
    "email_on_retry":     False,
}

INTERNAL_HEADERS = {
    "Content-Type":    "application/json",
    "X-Internal-Token": INTERNAL_TOKEN,
}


# ---------------------------------------------------------------------------
# Callbacks
# ---------------------------------------------------------------------------
def on_failure_callback(context: Context) -> None:
    """Send SNS alert when any task fails."""
    if not SNS_ALERT_ARN:
        return

    dag_id   = context["dag"].dag_id
    task_id  = context["task_instance"].task_id
    run_id   = context["run_id"]
    exc      = context.get("exception")

    message = json.dumps({
        "dag_id":  dag_id,
        "task_id": task_id,
        "run_id":  run_id,
        "error":   str(exc) if exc else "Unknown error",
    })

    try:
        sns = boto3.client("sns", region_name=AWS_REGION)
        sns.publish(
            TopicArn = SNS_ALERT_ARN,
            Subject  = f"[LILG] DAG failure: {dag_id}/{task_id}",
            Message  = message,
        )
    except Exception as e:  # noqa: BLE001
        print(f"Failed to send SNS alert: {e}")


def refresh_holiday_calendar_fn(**context: object) -> None:
    """
    Pull the holiday calendar from HRMS and upsert into lilg DB.
    Called as a PythonOperator so we can use the HRMS client directly
    rather than going through the LILG API (the endpoint is a direct DB write).
    In practice, SimpleHttpOperator is sufficient for most tasks; this one
    is kept as Python to demonstrate mixing both patterns.
    """
    import requests  # type: ignore[import-untyped]

    resp = requests.post(
        f"{LILG_BASE_URL}/api/internal/ingest/hrms",
        headers=INTERNAL_HEADERS,
        json={"mode": "holiday_calendar_only"},
        timeout=120,
    )
    resp.raise_for_status()
    result = resp.json()
    print(f"Holiday calendar refreshed: {result}")


# ---------------------------------------------------------------------------
# DAG definition
# ---------------------------------------------------------------------------
with DAG(
    dag_id          = "lilg_daily",
    description     = "LILG daily identity lifecycle pipeline",
    start_date      = pendulum.datetime(2024, 1, 1, tz=IST),
    schedule        = "30 0 * * *",
    catchup         = False,
    max_active_runs = 1,
    default_args    = DEFAULT_ARGS,
    tags            = ["lilg", "iga", "daily"],
    on_failure_callback = on_failure_callback,
    doc_md          = __doc__,
) as dag:

    # 1. Refresh holiday calendar
    t1_refresh_holidays = PythonOperator(
        task_id             = "refresh_holiday_calendar",
        python_callable     = refresh_holiday_calendar_fn,
        on_failure_callback = on_failure_callback,
    )

    # 2. Ingest HRMS roster
    t2_ingest_hrms = SimpleHttpOperator(
        task_id             = "ingest_hrms_roster",
        http_conn_id        = "lilg_internal_api",
        endpoint            = "/api/internal/ingest/hrms",
        method              = "POST",
        headers             = INTERNAL_HEADERS,
        data                = json.dumps({}),
        response_check      = lambda resp: resp.status_code == 200,
        log_response        = True,
        on_failure_callback = on_failure_callback,
    )

    # 3. Ingest True-in attendance
    t3_ingest_truein = SimpleHttpOperator(
        task_id             = "ingest_truein_attendance",
        http_conn_id        = "lilg_internal_api",
        endpoint            = "/api/internal/ingest/truein",
        method              = "POST",
        headers             = INTERNAL_HEADERS,
        data                = json.dumps({"delta": False}),
        response_check      = lambda resp: resp.status_code == 200,
        log_response        = True,
        on_failure_callback = on_failure_callback,
    )

    # 4. Ingest leave records
    t4_ingest_leave = SimpleHttpOperator(
        task_id             = "ingest_leave_records",
        http_conn_id        = "lilg_internal_api",
        endpoint            = "/api/internal/ingest/hrms",
        method              = "POST",
        headers             = INTERNAL_HEADERS,
        data                = json.dumps({"mode": "leave_records"}),
        response_check      = lambda resp: resp.status_code == 200,
        log_response        = True,
        on_failure_callback = on_failure_callback,
    )

    # 5. Run activity aggregator
    t5_aggregate = SimpleHttpOperator(
        task_id             = "run_activity_aggregator",
        http_conn_id        = "lilg_internal_api",
        endpoint            = "/api/internal/aggregate",
        method              = "POST",
        headers             = INTERNAL_HEADERS,
        data                = json.dumps({}),
        response_check      = lambda resp: resp.status_code == 200,
        log_response        = True,
        on_failure_callback = on_failure_callback,
    )

    # 6. Run risk engine
    t6_risk = SimpleHttpOperator(
        task_id             = "run_risk_engine",
        http_conn_id        = "lilg_internal_api",
        endpoint            = "/api/internal/risk-scan",
        method              = "POST",
        headers             = INTERNAL_HEADERS,
        data                = json.dumps({}),
        response_check      = lambda resp: resp.status_code == 200,
        log_response        = True,
        on_failure_callback = on_failure_callback,
    )

    # 7. Send manager digest
    t7_mgr_digest = SimpleHttpOperator(
        task_id             = "send_manager_digest",
        http_conn_id        = "lilg_internal_api",
        endpoint            = "/api/internal/digests/manager",
        method              = "POST",
        headers             = INTERNAL_HEADERS,
        data                = json.dumps({}),
        response_check      = lambda resp: resp.status_code == 200,
        log_response        = True,
        on_failure_callback = on_failure_callback,
    )

    # 8. Send HRBP digest (re-uses same endpoint with a role filter header)
    t8_hrbp_digest = SimpleHttpOperator(
        task_id             = "send_hrbp_digest",
        http_conn_id        = "lilg_internal_api",
        endpoint            = "/api/internal/digests/manager",
        method              = "POST",
        headers             = {**INTERNAL_HEADERS, "X-Digest-Role": "HRBP"},
        data                = json.dumps({"role": "HRBP"}),
        response_check      = lambda resp: resp.status_code == 200,
        log_response        = True,
        on_failure_callback = on_failure_callback,
    )

    # ---------------------------------------------------------------------------
    # Task dependencies
    # ---------------------------------------------------------------------------
    (
        t1_refresh_holidays
        >> t2_ingest_hrms
        >> [t3_ingest_truein, t4_ingest_leave]
        >> t5_aggregate
        >> t6_risk
        >> [t7_mgr_digest, t8_hrbp_digest]
    )
