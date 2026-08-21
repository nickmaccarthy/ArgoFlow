#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAB_DIR="${LOCAL_K8S_CLUSTER_DIR:-${HERE}/../../../local-k8s-cluster}"
TARGET_DIR="${LAB_DIR}/gitops/extensions/workflows"

if [ -d "${TARGET_DIR}" ]; then
  find "${TARGET_DIR}" -maxdepth 1 -type f -name 'extension-workflows*.js' -exec mv {} {}.disabled \;
fi
kubectl --context colima -n argocd rollout restart deploy/argo-cd-argocd-server
kubectl --context colima -n argocd rollout status deploy/argo-cd-argocd-server --timeout=180s

echo "Removed extension bundle. Hard-refresh http://argocd.localhost."
