{{/* Names, labels and the settings every app pod shares. */}}

{{- define "hekate.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "hekate.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "hekate.labels" -}}
app.kubernetes.io/name: {{ include "hekate.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "hekate.selector" -}}
app.kubernetes.io/name: {{ include "hekate.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "hekate.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}

{{- define "hekate.secretName" -}}
{{- .Values.secrets.existingSecret | default (include "hekate.fullname" .) -}}
{{- end -}}

{{- define "hekate.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- .Values.serviceAccount.name | default (include "hekate.fullname" .) -}}
{{- else -}}
{{- .Values.serviceAccount.name | default "default" -}}
{{- end -}}
{{- end -}}

{{- define "hekate.publicUrl" -}}
{{- required "publicUrl is required, such as https://review.example.com" .Values.publicUrl -}}
{{- end -}}

{{/* A secret key as an environment variable. */}}
{{- define "hekate.secretEnv" -}}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: {{ .secret }}
      key: {{ .key }}
{{- end -}}

{{/* The keys every app container has, from the release's Secret or the one named by `secret`. */}}
{{- define "hekate.env" -}}
{{- $secret := .secret | default (include "hekate.secretName" .root) -}}
{{- with .root -}}
{{- include "hekate.secretEnv" (dict "name" "MASTER_KEY" "secret" $secret "key" "master-key") }}
{{ include "hekate.secretEnv" (dict "name" "AUTH_SECRET" "secret" $secret "key" "auth-secret") }}
{{ include "hekate.secretEnv" (dict "name" "HEKATE_SETUP_CODE" "secret" $secret "key" "setup-code") }}
{{- if .Values.database.cloudnativepg.enabled }}
{{- $cluster := printf "%s-db-app" (include "hekate.fullname" .) }}
{{ include "hekate.secretEnv" (dict "name" "DATABASE_URL" "secret" $cluster "key" "uri") }}
{{- else }}
{{ include "hekate.secretEnv" (dict "name" "DATABASE_URL" "secret" $secret "key" "database-url") }}
{{- if or .Values.database.directUrl .Values.secrets.existingSecret }}
- name: DATABASE_DIRECT_URL
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: database-direct-url
      optional: true
{{- end }}
{{- end }}
{{- if not .Values.storage.volume.enabled }}
- name: STORAGE_MEDIA_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: s3-access-key-id
      optional: true
- name: STORAGE_MEDIA_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: s3-secret-access-key
      optional: true
{{- end }}
- name: SMTP_URL
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: smtp-url
      optional: true
- name: METRICS_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: metrics-token
      optional: true
{{- end -}}
{{- end -}}

{{/* The pod's security: no root, nothing gained, nothing written but its scratch space. */}}
{{- define "hekate.podSecurity" -}}
runAsNonRoot: true
runAsUser: 10001
runAsGroup: 10001
fsGroup: 10001
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "hekate.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
runAsNonRoot: true
runAsUser: 10001
runAsGroup: 10001
capabilities:
  drop: [ALL]
{{- end -}}

{{/* Scratch space in memory, and the media volume when there is one. */}}
{{- define "hekate.volumes" -}}
- name: tmp
  emptyDir:
    medium: Memory
    sizeLimit: 256Mi
- name: work
  emptyDir:
    medium: Memory
    sizeLimit: {{ .workSize }}
{{- if .root.Values.storage.volume.enabled }}
- name: media
  persistentVolumeClaim:
    claimName: {{ .root.Values.storage.volume.existingClaim | default (printf "%s-media" (include "hekate.fullname" .root)) }}
{{- end }}
{{- end -}}

{{- define "hekate.volumeMounts" -}}
- name: tmp
  mountPath: /tmp
- name: work
  mountPath: /tmp/hekate-work
{{- if .Values.storage.volume.enabled }}
- name: media
  mountPath: /data
{{- end }}
{{- end -}}
