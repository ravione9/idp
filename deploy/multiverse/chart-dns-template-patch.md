# Pod DNS — multiverse-application-helm chart patch (required)

## Symptom

After `helm upgrade`, pods still show cluster DNS:

```
nameserver 172.20.0.10
search it-idp.svc.cluster.local svc.cluster.local cluster.local ...
options ndots:5
```

Values like `dnsPolicy` / `dnsConfig` in Helm values **do nothing** until the chart template renders them on the Pod spec.

## Fix (in `infra-platform/multiverse-application-helm`)

Add to **API and worker** Deployment templates (e.g. `multiverse/idp/templates/deployment-api.yaml`), inside `spec.template.spec` (same level as `containers:`):

```yaml
      {{- if .Values.dnsPolicy }}
      dnsPolicy: {{ .Values.dnsPolicy }}
      {{- end }}
      {{- with .Values.dnsConfig }}
      dnsConfig:
        {{- toYaml . | nindent 8 }}
      {{- end }}
```

Merge the same block into the worker deployment template if workers also need on-prem DNS.

## Values (idp repo)

`deploy/multiverse/values-overlay.yaml` — applied by GitLab `deploy-prod` via:

```bash
helm upgrade ... \
  -f ./helm/multiverse/idp/values-lk-multiverse-platform-eks.yaml \
  -f deploy/multiverse/values-overlay.yaml
```

## Verify after chart MR + idp deploy

```bash
kubectl -n it-idp rollout restart deploy/idp-api-autoscale
kubectl -n it-idp rollout status deploy/idp-api-autoscale --timeout=5m
kubectl -n it-idp exec deploy/idp-api-autoscale -c idp-api -- cat /etc/resolv.conf
```

Expected:

```
search lenskart.in ...
nameserver 192.168.32.3
options ndots:2
```

## One-off test (before chart fix)

```bash
kubectl -n it-idp patch deployment idp-api-autoscale --type=json -p='[
  {"op":"replace","path":"/spec/template/spec/dnsPolicy","value":"None"},
  {"op":"add","path":"/spec/template/spec/dnsConfig","value":{
    "nameservers":["192.168.32.3"],
    "searches":["lenskart.in"],
    "options":[{"name":"ndots","value":"2"}]
  }}
]'
kubectl -n it-idp rollout status deployment/idp-api-autoscale --timeout=5m
```

If this patch works but Helm deploy does not, the chart template patch above is the missing piece.
