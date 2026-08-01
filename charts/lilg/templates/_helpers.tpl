{{- define "lilg.labels" -}}
app.kubernetes.io/name: lilg
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{- define "lilg.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag }}
{{- end }}
