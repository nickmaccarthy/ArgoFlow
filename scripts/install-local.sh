#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAB_DIR="${LOCAL_K8S_CLUSTER_DIR:-${HERE}/../../../local-k8s-cluster}"
TARGET="${LAB_DIR}/gitops/extensions/workflows"
VERSION="$(node --input-type=module -e "import('./package.json', {with: {type: 'json'}}).then(({default: pkg}) => process.stdout.write(pkg.version))")"
BUNDLE="extension-workflows-${VERSION}.js"

npm --prefix "${HERE}" run build
mkdir -p "${TARGET}"
find "${TARGET}" -maxdepth 1 -type f -name 'extension-workflows*.js' -exec mv {} {}.disabled \;
install -m 0644 "${HERE}/dist/extension-workflows.js" "${TARGET}/${BUNDLE}"
helmfile --kube-context colima -f "${LAB_DIR}/helmfile.yaml" apply --selector name=argo-cd
kubectl --context colima -n argocd rollout status deploy/argo-cd-argocd-server --timeout=180s

echo "Installed ${BUNDLE}. Hard-refresh http://argocd.localhost and open workflows-extension-demo."
