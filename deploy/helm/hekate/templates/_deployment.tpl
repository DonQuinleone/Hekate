{{/* One Deployment for a role (decision 189): api answers requests, worker runs the jobs. */}}
{{- define "hekate.deployment" -}}
{{- $root := .root -}}
{{- $role := .role -}}
{{- $values := index $root.Values $role -}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "hekate.fullname" $root }}-{{ $role }}
  namespace: {{ $root.Release.Namespace }}
  labels:
    {{- include "hekate.labels" $root | nindent 4 }}
    app.kubernetes.io/component: {{ $role }}
spec:
  {{- if not $values.autoscaling.enabled }}
  replicas: {{ $values.replicas }}
  {{- end }}
  revisionHistoryLimit: 5
  strategy:
    type: RollingUpdate
    rollingUpdate:
      {{- if eq $role "api" }}
      # A new replica is ready before an old one stops: no gap in service (decision 193).
      maxSurge: 1
      maxUnavailable: 0
      {{- else }}
      # A worker's jobs finish or go back to the queue before its replacement starts.
      maxSurge: 0
      maxUnavailable: 1
      {{- end }}
  selector:
    matchLabels:
      {{- include "hekate.selector" $root | nindent 6 }}
      app.kubernetes.io/component: {{ $role }}
  template:
    metadata:
      labels:
        {{- include "hekate.selector" $root | nindent 8 }}
        app.kubernetes.io/component: {{ $role }}
      annotations:
        # A changed setting rolls the pods.
        checksum/config: {{ include (print $root.Template.BasePath "/configmap.yaml") $root | sha256sum }}
        {{- if not $root.Values.secrets.existingSecret }}
        checksum/secret: {{ include (print $root.Template.BasePath "/secret.yaml") $root | sha256sum }}
        {{- end }}
        {{- with $values.podAnnotations }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
    spec:
      serviceAccountName: {{ include "hekate.serviceAccountName" $root }}
      automountServiceAccountToken: false
      {{- with $root.Values.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      terminationGracePeriodSeconds: {{ $root.Values.terminationGracePeriodSeconds }}
      securityContext:
        {{- include "hekate.podSecurity" $root | nindent 8 }}
      containers:
        - name: {{ $role }}
          image: {{ include "hekate.image" $root }}
          imagePullPolicy: {{ $root.Values.image.pullPolicy }}
          securityContext:
            {{- include "hekate.containerSecurity" $root | nindent 12 }}
          envFrom:
            - configMapRef:
                name: {{ include "hekate.fullname" $root }}
          env:
            - name: ROLE
              value: {{ $role }}
            {{- if eq $role "api" }}
            # Replicas that start together migrate once, one after another (decision 177).
            - name: MIGRATE_ON_START
              value: "true"
            {{- else }}
            - name: MIGRATE_ON_START
              value: "false"
            - name: WORKER_CONCURRENCY
              value: {{ $values.concurrency | quote }}
            {{- with $values.lanes }}
            - name: WORKER_LANES
              value: {{ . | quote }}
            {{- end }}
            {{- end }}
            {{- include "hekate.env" (dict "root" $root) | nindent 12 }}
          ports:
            - name: http
              containerPort: 3000
          # Migrating may take a while on the first start of a release.
          startupProbe:
            httpGet: { path: /api/health, port: http }
            periodSeconds: 5
            failureThreshold: 60
          livenessProbe:
            httpGet: { path: /api/health, port: http }
            periodSeconds: 15
            timeoutSeconds: 5
          # Answers stopping as soon as the pod is told to stop, so it leaves the Service first.
          readinessProbe:
            httpGet: { path: /api/health/ready, port: http }
            periodSeconds: 5
            timeoutSeconds: 5
          resources:
            {{- toYaml $values.resources | nindent 12 }}
          volumeMounts:
            {{- include "hekate.volumeMounts" $root | nindent 12 }}
      volumes:
        {{- include "hekate.volumes" (dict "root" $root "workSize" $values.workSize) | nindent 8 }}
      {{- with $values.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $values.tolerations }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $values.affinity }}
      affinity:
        {{- toYaml . | nindent 8 }}
      {{- end }}
{{- end -}}
