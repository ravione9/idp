# Pod DNS — multiverse-application-helm chart patch (required)

## Symptom

Pods still show cluster DNS after `helm upgrade`:

```
nameserver 172.20.0.10
search it-idp.svc.cluster.local svc.cluster.local cluster.local ...
options ndots:5
```

Helm values `dnsPolicy` / `dnsConfig` have **no effect** until the chart template renders them on the Pod spec.

## Fix (`infra-platform/multiverse-application-helm`)

In API and worker Deployment templates (e.g. `multiverse/idp/templates/deployment-api.yaml`), inside `spec.template.spec`:

```yaml
      {{- if .Values.dnsPolicy }}
      dnsPolicy: {{ .Values.dnsPolicy }}
      {{- end }}
      {{- with .Values.dnsConfig }}
      dnsConfig:
        {{- toYaml . | nindent 8 }}
      {{- end }}
```

## Values (this repo — already on `main`)

- `deploy/multiverse/values-overlay.yaml` — merged by `deploy-prod`
- Reference copy in `values-lk-multiverse-platform-eks.yaml`

## Verify

```bash
kubectl -n it-idp rollout restart deploy/idp-api-autoscale
kubectl -n it-idp rollout status deploy/idp-api-autoscale --timeout=5m
kubectl -n it-idp exec deploy/idp-api-autoscale -c idp-api -- cat /etc/resolv.conf
```

Expected: `nameserver 192.168.32.3`, `search lenskart.in`, `ndots:2`.

## One-off test (before chart MR)

```bash
kubectl -n it-idp patch deployment idp-api-autoscale --type=json -p='[
  {"op":"replace","path":"/spec/template/spec/dnsPolicy","value":"None"},
  {"op":"add","path":"/spec/template/spec/dnsConfig","value":{
    "nameservers":["192.168.32.3"],
    "searches":["lenskart.in"],
    "options":[{"name":"ndots","value":"2"}]
  }}
]'
```

If the patch works but Helm deploy does not, the chart template change above is required.
