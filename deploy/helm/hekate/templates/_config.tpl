{{/* The settings (the ConfigMap's data) and the keys (the Secret's), shared by the release's own
     ConfigMap and Secret and by the migration hook's copies, which carry this upgrade's values. */}}

{{- define "hekate.configData" -}}
{{- $s3 := .Values.storage.s3 -}}
PUBLIC_URL: {{ include "hekate.publicUrl" . | quote }}
# No settings file: everything is configured here, and the image's /config belongs to its
# own user, not the one the pods run as. Tools that want a home directory get scratch space.
HEKATE_SETTINGS_FILE: /tmp/hekate.env
HOME: /tmp
# Client addresses from X-Forwarded-For only behind a proxy that sets it: the Ingress
# controller by default. Exposed directly, a client could claim any address.
{{- if kindIs "bool" .Values.trustProxy }}
TRUST_PROXY: {{ .Values.trustProxy | quote }}
{{- else }}
TRUST_PROXY: {{ .Values.ingress.enabled | quote }}
{{- end }}
# Workspace subdomains (#176) with the Ingress's wildcard host.
WORKSPACE_SUBDOMAINS: {{ and .Values.ingress.enabled .Values.ingress.wildcard | quote }}
MAIL_FROM: {{ .Values.mail.from | quote }}
{{- with .Values.mail.microsoft.tenant }}
MAIL_GRAPH_TENANT: {{ . | quote }}
{{- end }}
{{- with .Values.mail.microsoft.clientId }}
MAIL_GRAPH_CLIENT_ID: {{ . | quote }}
{{- end }}
{{- with .Values.mail.mailcoach.url }}
MAIL_MAILCOACH_URL: {{ . | quote }}
{{- end }}
STORAGE_BACKENDS: media
{{- if .Values.storage.volume.enabled }}
STORAGE_MEDIA_DRIVER: local
STORAGE_MEDIA_PATH: /data/storage
{{- else }}
STORAGE_MEDIA_DRIVER: s3
STORAGE_MEDIA_BUCKET: {{ required "storage.s3.bucket is required, or turn on storage.volume" $s3.bucket | quote }}
{{- with $s3.region }}
STORAGE_MEDIA_REGION: {{ . | quote }}
{{- end }}
{{- with $s3.endpoint }}
STORAGE_MEDIA_ENDPOINT: {{ . | quote }}
{{- end }}
STORAGE_MEDIA_FORCE_PATH_STYLE: {{ $s3.forcePathStyle | quote }}
{{- with $s3.prefix }}
STORAGE_MEDIA_PREFIX: {{ . | quote }}
{{- end }}
{{- end }}
MIGRATE_ALLOW_DESTRUCTIVE: {{ .Values.migrations.allowDestructive | quote }}
{{- range $name, $value := .Values.env }}
{{ $name }}: {{ $value | quote }}
{{- end }}
{{- end -}}

{{- define "hekate.secretData" -}}
master-key: {{ required "secrets.masterKey is required (openssl rand -base64 32), or name secrets.existingSecret" .Values.secrets.masterKey | quote }}
setup-code: {{ required "setupCode is required: three groups of four letters and digits, such as 7KQ2-M9XD-4HPW" .Values.setupCode | quote }}
auth-secret: {{ required "secrets.authSecret is required (openssl rand -hex 32), or name secrets.existingSecret" .Values.secrets.authSecret | quote }}
{{- if not .Values.database.cloudnativepg.enabled }}
database-url: {{ required "database.url is required, or turn on database.cloudnativepg" .Values.database.url | quote }}
{{- with .Values.database.directUrl }}
database-direct-url: {{ . | quote }}
{{- end }}
{{- end }}
{{- with .Values.storage.s3.accessKeyId }}
s3-access-key-id: {{ . | quote }}
{{- end }}
{{- with .Values.storage.s3.secretAccessKey }}
s3-secret-access-key: {{ . | quote }}
{{- end }}
{{- with .Values.mail.smtpUrl }}
smtp-url: {{ . | quote }}
{{- end }}
{{- with .Values.mail.microsoft.clientSecret }}
mail-graph-client-secret: {{ . | quote }}
{{- end }}
{{- with .Values.mail.mailcoach.token }}
mail-mailcoach-token: {{ . | quote }}
{{- end }}
{{- with .Values.metricsToken }}
metrics-token: {{ . | quote }}
{{- end }}
{{- end -}}
