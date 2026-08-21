#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "${STAGE}"' EXIT

mkdir -p "${STAGE}/resources/argoflow"
cp "${ROOT}/dist/extension-workflows.js" "${STAGE}/resources/argoflow/extension-argoflow.js"
tar -czf "${ROOT}/dist/extension.tar.gz" -C "${STAGE}" resources

cd "${ROOT}/dist"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum extension.tar.gz >extension_checksums.txt
else
  shasum -a 256 extension.tar.gz >extension_checksums.txt
fi

echo "Created dist/extension.tar.gz and dist/extension_checksums.txt"
