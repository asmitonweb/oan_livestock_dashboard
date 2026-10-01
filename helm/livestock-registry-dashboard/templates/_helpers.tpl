{{- define "dashboard.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "dashboard.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "dashboard.labels" -}}
{{ include "dashboard.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* A VirtualService http route to the dashboards Service for one host. */}}
{{- define "dashboard.httpRoute" -}}
- headers:
    request:
      set:
        x-forwarded-host: {{ .host | quote }}
        x-forwarded-proto: https
  match:
    - uri:
        prefix: /
  route:
    - destination:
        host: {{ include "dashboard.fullname" .root }}
        port:
          number: {{ .root.Values.service.port }}
{{- end -}}

{{- define "dashboard.serviceAccountName" -}}
{{ include "dashboard.fullname" . }}
{{- end -}}

{{- define "dashboard.ecrRefresher" -}}
{{ include "dashboard.fullname" . }}-ecr-refresh
{{- end -}}

{{/* ECR registry host (<account>.dkr.ecr.<region>.amazonaws.com): ecrPullSecret.registry, else the host of image.repository. */}}
{{- define "dashboard.ecrRegistry" -}}
{{- $registry := .Values.ecrPullSecret.registry | default (first (splitList "/" (toString .Values.image.repository))) -}}
{{- if not (contains ".dkr.ecr." $registry) -}}
{{- fail (printf "ecrPullSecret: %q is not an ECR registry host; set ecrPullSecret.registry or disable ecrPullSecret" $registry) -}}
{{- end -}}
{{- $registry -}}
{{- end -}}

{{/* Job spec that fetches an ECR token and writes the pull secret. Takes dict root, serviceAccount. */}}
{{- define "dashboard.ecrJobSpec" -}}
{{- $v := .root.Values.ecrPullSecret -}}
{{- $registry := include "dashboard.ecrRegistry" .root -}}
backoffLimit: 2
activeDeadlineSeconds: 300
template:
  metadata:
    labels:
      app.kubernetes.io/name: {{ .root.Chart.Name }}-ecr-refresh
      app.kubernetes.io/instance: {{ .root.Release.Name }}
  spec:
    serviceAccountName: {{ .serviceAccount }}
    restartPolicy: Never
    initContainers:
      - name: get-token
        image: {{ $v.awsCliImage }}
        command: ["/bin/sh", "-c", "aws ecr get-login-password --region {{ index (splitList "." $registry) 3 }} > /token/ecr"]
        volumeMounts:
          - name: token
            mountPath: /token
    containers:
      - name: write-secret
        image: {{ $v.kubectlImage }}
        command:
          - /bin/sh
          - -c
          - |
            set -eu
            kubectl create secret docker-registry {{ $v.name }} \
              --namespace {{ .root.Release.Namespace }} \
              --docker-server={{ $registry }} \
              --docker-username=AWS \
              --docker-password="$(cat /token/ecr)" \
              --dry-run=client -o yaml | kubectl apply -f -
        volumeMounts:
          - name: token
            mountPath: /token
            readOnly: true
    volumes:
      - name: token
        emptyDir:
          medium: Memory
{{- end -}}

{{/* The image reference (repository and tag are required). */}}
{{- define "dashboard.image" -}}
"{{ required "image.repository is required" .Values.image.repository }}:{{ required "image.tag is required" .Values.image.tag }}"
{{- end -}}

{{/* imagePullSecrets: the release's ECR pull secret first, then any others. */}}
{{- define "dashboard.imagePullSecrets" -}}
{{- $pullSecrets := .Values.imagePullSecrets }}
{{- if .Values.ecrPullSecret.enabled }}
{{- $pullSecrets = prepend $pullSecrets (dict "name" .Values.ecrPullSecret.name) }}
{{- end }}
{{- with $pullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/* Settings shared by the server and the IAM registration job. */}}
{{- define "dashboard.appEnv" -}}
- name: PUBLIC_URL
  value: {{ required "publicUrl is required" .Values.publicUrl | quote }}
- name: IAM_URL
  value: {{ required "iam.url is required" .Values.iam.url | quote }}
- name: DASHBOARD_CLIENT_ID
  value: {{ .Values.access.clientId | quote }}
{{- end -}}

{{/* Secret holding the Keycloak client secret: iamRegister.clientSecret.name, else the release's own. */}}
{{- define "dashboard.clientSecretName" -}}
{{- .Values.iamRegister.clientSecret.name | default (printf "%s-client" (include "dashboard.fullname" .)) -}}
{{- end -}}

{{/* Token endpoint the IAM registration logs in at: iamRegister.tokenUrl, else keycloakSetup.url + realm. */}}
{{- define "dashboard.tokenUrl" -}}
{{- if .Values.iamRegister.tokenUrl -}}
{{- .Values.iamRegister.tokenUrl -}}
{{- else -}}
{{- printf "%s/realms/%s/protocol/openid-connect/token" (trimSuffix "/" (required "iamRegister.tokenUrl or keycloakSetup.url is required" .Values.keycloakSetup.url)) (required "keycloakSetup.realm is required" .Values.keycloakSetup.realm) -}}
{{- end -}}
{{- end -}}
