"""
LILG Drift Detection Hourly DAG
================================
Runs every hour. Detects identity link drift between LILG DB and live
adapter state (stale last_synced_at, unexpected suspensions, orphan accounts).

Tasks:
  1. run_drift_detection — POST /api/internal/drift-detection

on_success_callback logs the drift_events count from the response.
"""

from __future__ import annotations

import json
import os
from datetime import timedelta

import pendulum
from airflow import DAG
from airflow.providers.http.operators.http import SimpleHttpOperator
from airflow.utils.context import Context

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
LILG_BASE_URL  = os.environ.get("LILG_INTERNAL_BASE_URL", "http://lilg-api:8080")
INTERNAL_TOKEN = os.environ.get("LILG_INTERNAL_TOKEN", "change-me")

IST = pendulum.timezone("Asia/Kolkata")

DEFAULT_ARGS = {
    "owner":              "lilg-platform",
    "depends_on_past":    False,
    "retries":            2,
    "retry_delay":        timedelta(seconds=120),
    "email_on_failure":   False,
    "email_on_retry":     False,
}

INTERNAL_HEADERS = {
    "Content-Type":     "application/json",
    "X-Internal-Token": INTERNAL_TOKEN,
}


# ---------------------------------------------------------------------------
# Callbacks
# ---------------------------------------------------------------------------
def on_drift_success(context: Context) -> None:
    """
    Log the drift_events count extracted from the task's XCom response.
    In production, push this metric to CloudWatch or Prometheus PushGateway.
    """
    try:
        ti   = context["task_instance"]
        # SimpleHttpOperator pushes the response text to XCom under 'return_value'
        raw  = ti.xcom_pull(task_ids="run_drift_detection", key="return_value")
        data = json.loads(raw) if isinstance(raw, str) else {}

        drift_events = data.get("drift_events", 0)
        checked      = data.get("checked", 0)
        duration_ms  = data.get("durationMs", 0)

        print(
            f"[LILG Drift] checked={checked}, drift_events={drift_events}, "
            f"durationMs={duration_ms}"
        )

        # Optionally push to CloudWatch
        import boto3  # noqa: PLC0415
        cw = boto3.client("cloudwatch", region_name=os.environ.get("AWS_DEFAULT_REGION", "ap-south-1"))
        cw.put_metric_data(
            Namespace  = "LILG",
            MetricData = [
                {
                    "MetricName": "DriftEvents",
                    "Value":      float(drift_events),
                    "Unit":       "Count",
                },
                {
                    "MetricName": "DriftChecked",
                    "Value":      float(checked),
                    "Unit":       "Count",
                },
            ],
        )
    except Exception as e:  # noqa: BLE001
        print(f"on_drift_success callback error (non-fatal): {e}")


# ---------------------------------------------------------------------------
# DAG definition
# ---------------------------------------------------------------------------
with DAG(
    dag_id              = "lilg_drift_hourly",
    description         = "LILG hourly identity link drift detection",
    start_date          = pendulum.datetime(2024, 1, 1, tz=IST),
    schedule            = "@hourly",
    catchup             = False,
    max_active_runs     = 1,
    default_args        = DEFAULT_ARGS,
    tags                = ["lilg", "drift", "hourly"],
    doc_md              = __doc__,
) as dag:

    run_drift_detection = SimpleHttpOperator(
        task_id              = "run_drift_detection",
        http_conn_id         = "lilg_internal_api",
        endpoint             = "/api/internal/drift-detection",
        method               = "POST",
        headers              = INTERNAL_HEADERS,
        data                 = json.dumps({}),
        response_check       = lambda resp: resp.status_code == 200,
        log_response         = True,
        on_success_callback  = on_drift_success,
        do_xcom_push         = True,
    )
