#!/usr/bin/env bash
# ABOUTME: 校验并发布 UOS 双架构安装包，独立于商店登录、官网指针和客户端 updater。
set -euo pipefail

fail() { echo "::error::$*" >&2; exit 1; }
[ -n "${VERSION:-}" ] || fail 'VERSION is required'
case "${UOS_CHANNEL:-}" in
  rc)
    [[ "$VERSION" =~ ^([0-9]+\.[0-9]+\.[0-9]+)-rc\.([0-9]+)$ ]] || fail 'RC requires version X.Y.Z-rc.N'
    package_version="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}"
    prefix='internal/rc/uos'
    ;;
  stable)
    [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(\.[1-9][0-9]*)?$ ]] || fail 'Stable requires version X.Y.Z or X.Y.Z.N'
    package_version="$VERSION"
    [[ "$package_version" == *.*.*.* ]] || package_version="${package_version}.0"
    prefix='uos'
    ;;
  *) fail 'UOS_CHANNEL must be rc or stable' ;;
esac

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
UOS_ARTIFACT_DIR="${UOS_ARTIFACT_DIR:-${GITHUB_WORKSPACE:-$(pwd)}/artifacts/uos}"
AWS_S3_BUCKET="${AWS_S3_BUCKET:-aoe-desktop-releases}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
CLOUDFRONT_DISTRIBUTION_ID="${CLOUDFRONT_DISTRIBUTION_ID:-EOFLQQ0A8KCX1}"
INSTALLER_DOWNLOAD_BASE_URL="${INSTALLER_DOWNLOAD_BASE_URL:-https://release.aoe.chat}"
INSTALLER_DOWNLOAD_BASE_URL="${INSTALLER_DOWNLOAD_BASE_URL%/}"
node - "$INSTALLER_DOWNLOAD_BASE_URL" <<'NODE'
const url = new URL(process.argv[2]);
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
  throw new Error('Installer download base must be an HTTPS URL without credentials, query or fragment');
}
NODE

temporary_dir=$(mktemp -d)
trap 'rm -rf "$temporary_dir"' EXIT
architectures=(amd64 arm64)
packages=(); keys=(); sizes=(); hashes=(); checksums=(); exists=()
digest() {
  node - "$1" "$2" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
(async () => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(process.argv[2])) hash.update(chunk);
  process.stdout.write(hash.digest(process.argv[3]));
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
NODE
}

# 双包全部通过本地校验后才允许任何远端写入，避免另一架构缺失时产生部分发布。
for arch in "${architectures[@]}"; do
  package="$UOS_ARTIFACT_DIR/Floatboat-${VERSION}-${arch}.deb"
  [ -f "$package" ] && [ ! -L "$package" ] || fail "Missing regular UOS $arch package: $package"
  size=$(wc -c < "$package" | tr -d ' ')
  [ "$size" -gt 0 ] && [ "$size" -le 5368709120 ] || fail "Unsupported UOS package size: $package"
  members=$(ar t "$package")
  [ "$members" = $'debian-binary\ncontrol.tar.gz\ndata.tar.gz' ] || fail "UOS package must use gzip control/data archives: $package"
  [ "$(ar p "$package" debian-binary)" = '2.0' ] || fail "Invalid Debian package marker: $package"
  ar p "$package" control.tar.gz > "$temporary_dir/control.tar.gz"
  node - "$SCRIPT_DIR" "$temporary_dir/control.tar.gz" "$package_version" "$arch" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { parseTar, parseControl } = require(path.join(process.argv[2], 'uos-publication-manifest.cjs'));
const entries = parseTar(zlib.gunzipSync(fs.readFileSync(process.argv[3]), { maxOutputLength: 1024 * 1024 }));
const entry = entries.get('control');
assert.ok(entry && ['0', '\0'].includes(entry.type), 'UOS control must be a regular file');
const control = parseControl(entry.data.toString('utf8'));
assert.equal(control.get('Package'), 'com.floatboat.desktop', 'UOS application identity mismatch');
assert.equal(control.get('Version'), process.argv[4], 'UOS package version mismatch');
assert.equal(control.get('Architecture'), process.argv[5], 'UOS architecture mismatch');
NODE
  packages+=("$package")
  keys+=("$prefix/$(basename "$package")")
  sizes+=("$size")
  hashes+=("$(digest "$package" hex)")
  checksums+=("$(digest "$package" base64)")
done

verify_s3() {
  local index="$1" response="$2"
  [ "$(jq -r '.ContentLength' "$response")" = "${sizes[$index]}" ] || fail "S3 size mismatch: ${keys[$index]}"
  [ "$(jq -r '.ChecksumSHA256 // empty' "$response")" = "${checksums[$index]}" ] || fail "S3 SHA256 mismatch: ${keys[$index]}"
  [ "$(jq -r '.ChecksumType // "FULL_OBJECT"' "$response")" = 'FULL_OBJECT' ] || fail "S3 checksum is not a full object digest: ${keys[$index]}"
  [ "$(jq -r '.CacheControl // empty' "$response")" = 'public,max-age=31536000,immutable' ] || fail "S3 cache policy mismatch: ${keys[$index]}"
  [ "$(jq -r '.ContentType // empty' "$response")" = 'application/vnd.debian.binary-package' ] || fail "S3 content type mismatch: ${keys[$index]}"
}
read_s3() {
  aws s3api head-object --bucket "$AWS_S3_BUCKET" --key "${keys[$1]}" --checksum-mode ENABLED --output json
}
for index in 0 1; do
  if read_s3 "$index" > "$temporary_dir/head.json" 2> "$temporary_dir/head.error"; then
    verify_s3 "$index" "$temporary_dir/head.json"
    exists+=(true)
  elif grep -Eq '\((404|NoSuchKey|NotFound)\)' "$temporary_dir/head.error"; then
    exists+=(false)
  else
    fail "Unable to check existing S3 object: ${keys[$index]}"
  fi
done

for index in 0 1; do
  if [ "${exists[$index]}" = false ]; then
    # 版本地址不可覆盖；并发任务只有在内容完全相同时才能复用获胜对象。
    aws s3api put-object --bucket "$AWS_S3_BUCKET" --key "${keys[$index]}" \
      --body "${packages[$index]}" --if-none-match '*' \
      --checksum-algorithm SHA256 --checksum-sha256 "${checksums[$index]}" \
      --content-type application/vnd.debian.binary-package \
      --cache-control public,max-age=31536000,immutable --output json > "$temporary_dir/put.json" || \
      echo '::warning::UOS upload returned an error; verifying the immutable object before continuing'
  fi
  read_s3 "$index" > "$temporary_dir/head.json"
  verify_s3 "$index" "$temporary_dir/head.json"
done

invalidation_id=$(aws cloudfront create-invalidation --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --paths "/${keys[0]}" "/${keys[1]}" --query 'Invalidation.Id' --output text)
aws cloudfront wait invalidation-completed --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" --id "$invalidation_id" || \
  echo '::warning::CloudFront waiter unavailable; full CDN content verification remains required'

for index in 0 1; do
  url="$INSTALLER_DOWNLOAD_BASE_URL/${keys[$index]}"
  downloaded="$temporary_dir/${architectures[$index]}.deb"
  curl --fail --silent --show-error --location --retry 6 --retry-all-errors \
    --connect-timeout 15 --max-time 1200 --header 'Cache-Control: no-cache' \
    --header 'Accept-Encoding: identity' --output "$downloaded" "$url"
  [ "$(wc -c < "$downloaded" | tr -d ' ')" = "${sizes[$index]}" ] || fail "CDN size mismatch: ${keys[$index]}"
  [ "$(digest "$downloaded" hex)" = "${hashes[$index]}" ] || fail "CDN SHA256 mismatch: ${keys[$index]}"
done

for index in 0 1; do
  url="$INSTALLER_DOWNLOAD_BASE_URL/${keys[$index]}"
  echo "UOS ${architectures[$index]}: $url"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then printf 'uos_%s_url=%s\n' "${architectures[$index]}" "$url" >> "$GITHUB_OUTPUT"; fi
done
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    printf '\n### UOS 安装包（%s）\n\n' "$VERSION"
    for index in 0 1; do
      printf -- '- [%s 安装包](%s/%s) — SHA-256: `%s`\n' "${architectures[$index]}" "$INSTALLER_DOWNLOAD_BASE_URL" "${keys[$index]}" "${hashes[$index]}"
    done
  } >> "$GITHUB_STEP_SUMMARY"
fi
