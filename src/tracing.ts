/**
 * OpenTelemetry for SigNoz (HTTP OTLP :4318).
 * Activated when OTEL_EXPORTER_OTLP_ENDPOINT is set (via Helm signoz block).
 * Must load before Express/Redis/MySQL so auto-instrumentation can hook in.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

let sdk: NodeSDK | undefined;

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });
  sdk.start();
}

export async function shutdownTracing(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
  }
}
