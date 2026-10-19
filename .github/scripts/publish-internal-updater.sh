#!/usr/bin/env bash
# ABOUTME: 发布 Floatboat 内部 Nightly/RC updater，并在完整验证后可选地切换预发布轨道。
set -euo pipefail
fail() {
  echo "::error::$*"
  exit 1
}

require_env() {
  [ -n "${!1:-}" ] || fail "$1 is required"
}

require_file() {
  [ -f "$1" ] || fail "Required internal updater file is missing: $1"
}
require_env TRACK
require_env FLOATBOAT_VERSION

case "$TRACK" in
  nightly)
    [[ "$FLOATBOAT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-n\.[0-9]{8}-[0-9A-Za-z]+$ ]] || \
      fail "Nightly 轨道版本格式无效：${FLOATBOAT_VERSION}；必须为 X.Y.Z-n.YYYYMMDD-标识"
    ;;
  rc)
    [[ "$FLOATBOAT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$ ]] || \
      fail "RC 轨道版本格式无效：${FLOATBOAT_VERSION}；必须为 X.Y.Z-rc.N"
    ;;
  *)
    fail "TRACK must be nightly or rc"
    ;;
esac
PREFERRED_PRERELEASE="${PREFERRED_PRERELEASE:-unchanged}"
case "$PREFERRED_PRERELEASE" in
  unchanged) ;;
  nightly | rc)
    [ "$PREFERRED_PRERELEASE" = "$TRACK" ] || fail "PREFERRED_PRERELEASE 非 unchanged 时必须与 TRACK 一致"
    ;;
  *) fail "PREFERRED_PRERELEASE must be unchanged, nightly, or rc" ;;
esac
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"; WORKSPACE_ROOT="${GITHUB_WORKSPACE:-$(pwd)}"
ARTIFACT_DIR="${ARTIFACT_DIR:-$WORKSPACE_ROOT/out/make}"; METADATA_ROOT="${METADATA_ROOT:-$WORKSPACE_ROOT/dist}"; METADATA_VERIFIER="${METADATA_VERIFIER:-$SCRIPT_DIR/verify-update-metadata.cjs}"
YAML_HELPER="${YAML_HELPER:-$SCRIPT_DIR/internal-updater-yaml.cjs}"
RELEASE_BUCKET="${RELEASE_BUCKET:-aoe-desktop-releases}"; RELEASE_BASE_URL="${RELEASE_BASE_URL:-https://release.aoe.chat}"; CLOUDFRONT_DISTRIBUTION_ID="${CLOUDFRONT_DISTRIBUTION_ID:-EOFLQQ0A8KCX1}"; PREFIX="internal/$TRACK"
for file in "$METADATA_ROOT/latest-mac.yml" "$METADATA_ROOT/latest.yml" "$METADATA_VERIFIER" "$YAML_HELPER"; do require_file "$file"; done
read_metadata_artifacts() {
  node "$YAML_HELPER" list-artifacts "$1"
}
mapfile -t mac_artifacts < <(read_metadata_artifacts "$METADATA_ROOT/latest-mac.yml"); mapfile -t win_artifacts < <(read_metadata_artifacts "$METADATA_ROOT/latest.yml"); artifact_names=("${mac_artifacts[@]}" "${win_artifacts[@]}")
arm64_zip=false; windows_exe=false
for name in "${artifact_names[@]}"; do [[ "$name" != *DeepSeek* && "$name" == Floatboat-* ]] || fail "内部 feed 绝不允许 DeepSeek 或非 Floatboat 制品：$name"; case "$name" in *.dmg|*.zip|*.exe);;*) fail "内部 feed 不允许的制品类型：$name";; esac; [[ "$name" != *-arm64.zip ]] || arm64_zip=true; [[ "$name" != Floatboat-Setup-*-x64.exe ]] || windows_exe=true; require_file "$ARTIFACT_DIR/$name"; done
[ "$arm64_zip" = true ] || fail "内部 feed 缺少 Floatboat arm64 updater ZIP"; [ "$windows_exe" = true ] || fail "内部 feed 缺少 Floatboat Windows x64 EXE"
verify_metadata(){ local root="$1" name; local args=(); for name in "${mac_artifacts[@]}";do args+=(--expected-artifact "$name");done; node "$METADATA_VERIFIER" --metadata "$root/latest-mac.yml" --artifact-dir "$ARTIFACT_DIR" --release-version "$FLOATBOAT_VERSION" "${args[@]}" --forbid-release-notes; args=();for name in "${win_artifacts[@]}";do args+=(--expected-artifact "$name");done;node "$METADATA_VERIFIER" --metadata "$root/latest.yml" --artifact-dir "$ARTIFACT_DIR" --release-version "$FLOATBOAT_VERSION" "${args[@]}" --forbid-release-notes; }
verify_metadata "$METADATA_ROOT"
verify_s3(){ local file="$1" key="$2" cache="$3" type="${4:-}" response size; response=$(aws s3api head-object --bucket "$RELEASE_BUCKET" --key "$key" --output json);size=$(wc -c < "$file"|tr -d ' ');[ "$(jq -r .ContentLength<<<"$response")" = "$size" ]||fail "S3 object size mismatch: $key";[ -n "$(jq -r '.ETag // empty'<<<"$response")" ]||fail "S3 ETag missing: $key";[ "$(jq -r '.CacheControl // empty'<<<"$response")" = "$cache" ]||fail "S3 cache mismatch: $key";[ -z "$type" ]||[ "$(jq -r '.ContentType // empty'<<<"$response")" = "$type" ]||fail "S3 type mismatch: $key"; }
for name in "${artifact_names[@]}";do aws s3 cp "$ARTIFACT_DIR/$name" "s3://$RELEASE_BUCKET/$PREFIX/$name" --no-progress --checksum-algorithm SHA256 --cache-control public,max-age=31536000,immutable;done
for name in "${artifact_names[@]}";do verify_s3 "$ARTIFACT_DIR/$name" "$PREFIX/$name" public,max-age=31536000,immutable;done
for name in latest-mac.yml latest.yml;do aws s3 cp "$METADATA_ROOT/$name" "s3://$RELEASE_BUCKET/$PREFIX/$name" --no-progress --checksum-algorithm SHA256 --content-type application/yaml --cache-control no-cache,no-store,must-revalidate;verify_s3 "$METADATA_ROOT/$name" "$PREFIX/$name" no-cache,no-store,must-revalidate application/yaml;done
invalidate(){ local response id;response=$(aws cloudfront create-invalidation --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" --paths "$@" --output json);id=$(jq -r .Invalidation.Id<<<"$response");aws cloudfront wait invalidation-completed --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" --id "$id"||echo '::warning::CloudFront waiter unavailable; CDN verification remains authoritative';};invalidate "/$PREFIX/*"
curl_common=(--fail --silent --show-error --location --retry 6 --retry-all-errors --retry-delay 5 --connect-timeout 15 --max-time 120 --header "Cache-Control: no-cache");published=$(mktemp -d)
for name in latest-mac.yml latest.yml;do curl "${curl_common[@]}" --output "$published/$name" "$RELEASE_BASE_URL/$PREFIX/$name";done;verify_metadata "$published"
for name in "${artifact_names[@]}";do headers=$(mktemp);curl "${curl_common[@]}" --head --dump-header "$headers" --output /dev/null "$RELEASE_BASE_URL/$PREFIX/$name";remote=$(awk 'BEGIN{IGNORECASE=1}/^content-length:/{v=$2;gsub("\r","",v)}END{print v}' "$headers");local_size=$(wc -c<"$ARTIFACT_DIR/$name"|tr -d ' ');[ "$remote" = "$local_size" ]||fail "CDN artifact size mismatch: $name";done
if [ "$PREFERRED_PRERELEASE" != unchanged ];then channel=$(mktemp);printf 'schemaVersion: 1\npreferredPrerelease: %s\n' "$PREFERRED_PRERELEASE">"$channel";aws s3 cp "$channel" "s3://$RELEASE_BUCKET/internal/channel.yml" --no-progress --checksum-algorithm SHA256 --content-type application/yaml --cache-control no-cache,no-store,must-revalidate;verify_s3 "$channel" internal/channel.yml no-cache,no-store,must-revalidate application/yaml;invalidate /internal/channel.yml;remote_channel=$(mktemp);curl "${curl_common[@]}" --output "$remote_channel" "$RELEASE_BASE_URL/internal/channel.yml";node "$YAML_HELPER" verify-channel "$remote_channel" "$PREFERRED_PRERELEASE"
fi
echo "✅ Floatboat internal $TRACK updater 已发布并验证；preferredPrerelease=$PREFERRED_PRERELEASE"
