#!/usr/bin/env bash
# ABOUTME: 按“制品先行、元数据后发”顺序发布双变体 stable updater，并回读 S3 与 CDN。

set -euo pipefail

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "::error::${name} is required"
    exit 1
  fi
}

require_file() {
  local file_path="$1"
  if [ ! -f "$file_path" ]; then
    echo "::error::Required updater release file is missing: ${file_path}"
    exit 1
  fi
}

require_env FLOATBOAT_VERSION
require_env DEEPSEEK_VERSION

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
WORKSPACE_ROOT="${GITHUB_WORKSPACE:-$(pwd)}"
ARTIFACT_DIR="${ARTIFACT_DIR:-${WORKSPACE_ROOT}/out/make}"
METADATA_ROOT="${METADATA_ROOT:-${WORKSPACE_ROOT}/dist}"
RELEASE_BUCKET="${RELEASE_BUCKET:-aoe-desktop-releases}"
RELEASE_BASE_URL="${RELEASE_BASE_URL:-https://release.aoe.chat}"
CLOUDFRONT_DISTRIBUTION_ID="${CLOUDFRONT_DISTRIBUTION_ID:-EOFLQQ0A8KCX1}"
METADATA_VERIFIER="${METADATA_VERIFIER:-${SCRIPT_DIR}/verify-update-metadata.cjs}"

artifact_files=(
  "${ARTIFACT_DIR}/Floatboat-${FLOATBOAT_VERSION}-arm64.dmg"
  "${ARTIFACT_DIR}/Floatboat-${FLOATBOAT_VERSION}-x64.dmg"
  "${ARTIFACT_DIR}/Floatboat-Setup-${FLOATBOAT_VERSION}-x64.exe"
  "${ARTIFACT_DIR}/Floatboat-${FLOATBOAT_VERSION}-arm64.zip"
  "${ARTIFACT_DIR}/Floatboat-${FLOATBOAT_VERSION}-x64.zip"
  "${ARTIFACT_DIR}/Floatboat-DeepSeek-Agent-${DEEPSEEK_VERSION}-arm64.dmg"
  "${ARTIFACT_DIR}/Floatboat-DeepSeek-Agent-${DEEPSEEK_VERSION}-x64.dmg"
  "${ARTIFACT_DIR}/Floatboat-DeepSeek-Agent-Setup-${DEEPSEEK_VERSION}-x64.exe"
  "${ARTIFACT_DIR}/Floatboat-DeepSeek-Agent-${DEEPSEEK_VERSION}-arm64.zip"
  "${ARTIFACT_DIR}/Floatboat-DeepSeek-Agent-${DEEPSEEK_VERSION}-x64.zip"
)
artifact_keys=(
  "Floatboat-${FLOATBOAT_VERSION}-arm64.dmg"
  "Floatboat-${FLOATBOAT_VERSION}-x64.dmg"
  "Floatboat-Setup-${FLOATBOAT_VERSION}-x64.exe"
  "Floatboat-${FLOATBOAT_VERSION}-arm64.zip"
  "Floatboat-${FLOATBOAT_VERSION}-x64.zip"
  "deepseek-agent/Floatboat-DeepSeek-Agent-${DEEPSEEK_VERSION}-arm64.dmg"
  "deepseek-agent/Floatboat-DeepSeek-Agent-${DEEPSEEK_VERSION}-x64.dmg"
  "deepseek-agent/Floatboat-DeepSeek-Agent-Setup-${DEEPSEEK_VERSION}-x64.exe"
  "deepseek-agent/Floatboat-DeepSeek-Agent-${DEEPSEEK_VERSION}-arm64.zip"
  "deepseek-agent/Floatboat-DeepSeek-Agent-${DEEPSEEK_VERSION}-x64.zip"
)
metadata_files=(
  "${METADATA_ROOT}/latest-mac.yml"
  "${METADATA_ROOT}/latest.yml"
  "${METADATA_ROOT}/deepseek-agent/deepseek-agent-mac.yml"
  "${METADATA_ROOT}/deepseek-agent/deepseek-agent.yml"
)
metadata_keys=(
  "latest-mac.yml"
  "latest.yml"
  "deepseek-agent/deepseek-agent-mac.yml"
  "deepseek-agent/deepseek-agent.yml"
)

for file_path in "${artifact_files[@]}" "${metadata_files[@]}" "$METADATA_VERIFIER"; do
  require_file "$file_path"
done

verify_metadata_set() {
  local metadata_root="$1"
  node "$METADATA_VERIFIER" \
    --metadata "${metadata_root}/latest-mac.yml" \
    --artifact-dir "$ARTIFACT_DIR" \
    --release-version "$FLOATBOAT_VERSION" \
    --expected-artifact "Floatboat-${FLOATBOAT_VERSION}-arm64.dmg" \
    --expected-artifact "Floatboat-${FLOATBOAT_VERSION}-x64.dmg" \
    --expected-artifact "Floatboat-${FLOATBOAT_VERSION}-arm64.zip" \
    --expected-artifact "Floatboat-${FLOATBOAT_VERSION}-x64.zip"
  node "$METADATA_VERIFIER" \
    --metadata "${metadata_root}/latest.yml" \
    --artifact-dir "$ARTIFACT_DIR" \
    --release-version "$FLOATBOAT_VERSION" \
    --expected-artifact "Floatboat-Setup-${FLOATBOAT_VERSION}-x64.exe"
  node "$METADATA_VERIFIER" \
    --metadata "${metadata_root}/deepseek-agent/deepseek-agent-mac.yml" \
    --artifact-dir "$ARTIFACT_DIR" \
    --release-version "$DEEPSEEK_VERSION" \
    --expected-artifact "Floatboat-DeepSeek-Agent-${DEEPSEEK_VERSION}-arm64.dmg" \
    --expected-artifact "Floatboat-DeepSeek-Agent-${DEEPSEEK_VERSION}-x64.dmg" \
    --expected-artifact "Floatboat-DeepSeek-Agent-${DEEPSEEK_VERSION}-arm64.zip" \
    --expected-artifact "Floatboat-DeepSeek-Agent-${DEEPSEEK_VERSION}-x64.zip"
  node "$METADATA_VERIFIER" \
    --metadata "${metadata_root}/deepseek-agent/deepseek-agent.yml" \
    --artifact-dir "$ARTIFACT_DIR" \
    --release-version "$DEEPSEEK_VERSION" \
    --expected-artifact "Floatboat-DeepSeek-Agent-Setup-${DEEPSEEK_VERSION}-x64.exe"
}

echo "🔎 Rechecking all four local updater metadata files before S3 mutation"
verify_metadata_set "$METADATA_ROOT"

verify_s3_object() {
  local file_path="$1"
  local key="$2"
  local expected_cache_control="$3"
  local expected_content_type="${4:-}"
  local expected_size remote_size etag cache_control content_type response

  expected_size=$(wc -c < "$file_path" | tr -d ' ')
  response=$(aws s3api head-object \
    --bucket "$RELEASE_BUCKET" \
    --key "$key" \
    --output json)
  remote_size=$(jq -r '.ContentLength' <<<"$response")
  etag=$(jq -r '.ETag // empty' <<<"$response")
  cache_control=$(jq -r '.CacheControl // empty' <<<"$response")
  content_type=$(jq -r '.ContentType // empty' <<<"$response")

  if [ "$remote_size" != "$expected_size" ]; then
    echo "::error::S3 object size mismatch for ${key}: local=${expected_size}, remote=${remote_size}"
    exit 1
  fi
  if [ -z "$etag" ]; then
    echo "::error::S3 object ETag is missing for ${key}"
    exit 1
  fi
  if [ "$cache_control" != "$expected_cache_control" ]; then
    echo "::error::S3 object cache policy mismatch for ${key}: ${cache_control}"
    exit 1
  fi
  if [ -n "$expected_content_type" ] && [ "$content_type" != "$expected_content_type" ]; then
    echo "::error::S3 object content type mismatch for ${key}: ${content_type}"
    exit 1
  fi
  echo "  ✅ S3 ${key}: ${remote_size} bytes, ETag ${etag}"
}

echo "📤 Uploading ten immutable updater artifacts before publishing any live metadata"
for index in "${!artifact_files[@]}"; do
  aws s3 cp "${artifact_files[$index]}" "s3://${RELEASE_BUCKET}/${artifact_keys[$index]}" \
    --no-progress \
    --checksum-algorithm SHA256 \
    --cache-control "public,max-age=31536000,immutable"
done

echo "🔎 Verifying ten updater artifacts in S3"
for index in "${!artifact_files[@]}"; do
  verify_s3_object \
    "${artifact_files[$index]}" \
    "${artifact_keys[$index]}" \
    "public,max-age=31536000,immutable"
done

echo "📤 Publishing four live updater metadata files"
for index in "${!metadata_files[@]}"; do
  aws s3 cp "${metadata_files[$index]}" "s3://${RELEASE_BUCKET}/${metadata_keys[$index]}" \
    --no-progress \
    --checksum-algorithm SHA256 \
    --content-type "application/yaml" \
    --cache-control "no-cache,no-store,must-revalidate"
done

echo "🔎 Verifying four updater metadata objects in S3"
for index in "${!metadata_files[@]}"; do
  verify_s3_object \
    "${metadata_files[$index]}" \
    "${metadata_keys[$index]}" \
    "no-cache,no-store,must-revalidate" \
    "application/yaml"
done

echo "♻️ Invalidating CloudFront and waiting for completion"
invalidation=$(aws cloudfront create-invalidation \
  --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --paths "/*" \
  --output json)
echo "$invalidation" | jq '{Id: .Invalidation.Id, Status: .Invalidation.Status, CreateTime: .Invalidation.CreateTime}'
invalidation_id=$(jq -r '.Invalidation.Id' <<<"$invalidation")
aws cloudfront wait invalidation-completed \
  --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --id "$invalidation_id"
echo "  ✅ CloudFront invalidation completed: ${invalidation_id}"

curl_common=(
  --fail
  --silent
  --show-error
  --location
  --retry 6
  --retry-all-errors
  --retry-delay 5
  --connect-timeout 15
  --max-time 120
  --header "Cache-Control: no-cache"
)

published_metadata_root=$(mktemp -d)
mkdir -p "${published_metadata_root}/deepseek-agent"
for index in "${!metadata_keys[@]}"; do
  curl "${curl_common[@]}" \
    --output "${published_metadata_root}/${metadata_keys[$index]}" \
    "${RELEASE_BASE_URL}/${metadata_keys[$index]}"
done

echo "🔎 Verifying CDN metadata contents against local artifacts"
verify_metadata_set "$published_metadata_root"

verify_cdn_artifact() {
  local file_path="$1"
  local key="$2"
  local expected_size remote_size headers

  expected_size=$(wc -c < "$file_path" | tr -d ' ')
  headers=$(mktemp)
  curl "${curl_common[@]}" \
    --head \
    --dump-header "$headers" \
    --output /dev/null \
    "${RELEASE_BASE_URL}/${key}"
  remote_size=$(awk 'BEGIN { IGNORECASE=1 } /^content-length:/ { value=$2; gsub("\r", "", value) } END { print value }' "$headers")
  if [ -z "$remote_size" ] || [ "$remote_size" != "$expected_size" ]; then
    echo "::error::CDN artifact size mismatch for ${key}: local=${expected_size}, remote=${remote_size:-missing}"
    exit 1
  fi
  echo "  ✅ CDN ${key}: ${remote_size} bytes"
}

echo "🔎 Verifying all ten updater artifacts through CloudFront"
for index in "${!artifact_files[@]}"; do
  verify_cdn_artifact "${artifact_files[$index]}" "${artifact_keys[$index]}"
done

echo "✅ Floatboat and DeepSeek stable updater feeds are published and externally readable"
