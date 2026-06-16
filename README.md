Welcome to the community of [Floatboat](https://floatboat.ai). We release nighly builds here. You can try on to get the latest laboratory features, along with some unexpected crashes🤣. 
You can report the issues here, or contact us at contact@floatboat.ai


> This page is still in construction.  

## Test Builds

Manual `Release` and `Nightly Build` workflow runs support `build_profile=test`.
Test builds write the repository secret `TEST_BUILD_ENV_FILE` to the checked-out
source repository as `.env` before packaging.

```bash
gh secret set TEST_BUILD_ENV_FILE -R floatboatai/floatboat-release < /path/to/.env

gh workflow run release.yml -R floatboatai/floatboat-release \
  -f repo_ref=dev \
  -f version=0.4.2-test.1 \
  -f platforms=macos,windows \
  -f is_rc=true \
  -f build_profile=test \
  -f package_set=app
```

Use `build_profile=release` for normal RC or official release builds. Test
release builds are always marked as GitHub pre-releases and do not upload
installers to the production S3/CDN bucket. With `package_set=auto`, test
builds only build the app packages selected by `platforms`; test launcher
packages are skipped.

Use `package_set=launcher` to build only test launcher packages:

```bash
gh workflow run release.yml -R floatboatai/floatboat-release \
  -f repo_ref=dev \
  -f version=0.4.2-launcher.1 \
  -f platforms=macos,windows \
  -f is_rc=true \
  -f build_profile=test \
  -f package_set=launcher
```

`package_set=auto` keeps the default behavior: `build_profile=test` builds app
packages only, while normal release builds include both app and launcher
packages. `package_set=all` builds both explicitly.
