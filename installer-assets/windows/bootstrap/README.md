# Windows Bootstrap Installer Assets

These assets are used by the RC Windows bootstrap installer. The installer page is a native NSIS/Win32 page, so build output is always 24-bit BMP even when designers provide PNG, JPG, or GIF source assets.

## Welcome Image

- File: `welcome-product.bmp`
- Size: `164 x 314 px`
- Format: 24-bit BMP
- Use: NSIS welcome/finish side image via `MUI_WELCOMEFINISHPAGE_BITMAP`
- Transparency: not supported; flatten onto the final background before export

## Product Carousel Area

- Display area: `500 x 304 px`
- Position in installer window: `x=92, y=92`
- Output format used by NSIS: 24-bit BMP
- Runtime output names: `bootstrap-carousel-001.bmp`, `bootstrap-carousel-002.bmp`, ...
- Maximum frames: `24`

## Optional Remote Carousel ZIP

RC bootstrap installers can also fetch extra carousel frames at runtime from:

`https://release.aoe.chat/rc/Floatboat-Installer-RC-carousel.zip`

This is intentionally optional. The installer always shows the bundled frames first, and if the remote ZIP cannot be downloaded, opened, or converted, installation continues with the bundled frames.

ZIP requirements for the current product image package:

- Accepted image extensions: `.png`, `.jpg`, `.jpeg`, `.bmp`
- Root `1.*`: welcome side image, `164 x 314 px`, exported at runtime as `bootstrap-welcome-product.bmp`
- Root `2.*`: first product carousel frame, `500 x 304 px`
- `zh/`: Chinese product carousel frames, `500 x 304 px`
- `en/`: English product carousel frames, `500 x 304 px`
- Maximum carousel frames: `24`
- Maximum ZIP size: `50 MB`

Runtime language selection:

- Chinese Windows installer locale (`zh-CN`) uses frames from `zh/`.
- Any non-Chinese locale uses frames from `en/`.
- The carousel sequence is root `2.*` first, then the selected language directory sorted by numeric filename first and filename second.

Replacing the ZIP at the same CDN URL updates future installer runs without rebuilding the small installer. For local testing, set `FLOATBOAT_BOOTSTRAP_CAROUSEL_ZIP_URL` before launching the installer to override the default URL.

Legacy flat numeric carousel ZIPs are still accepted as a fallback when no localized `zh/` or `en/` frames are present.

The build script chooses the first available carousel source in this order:

1. `carousel.gif`
2. `carousel-frames/`
3. Three static images: `carousel-work.*`, `carousel-combo.*`, `carousel-tacit.*`

## Option A: Single GIF Source

- File: `carousel.gif`
- Size: `500 x 304 px`
- Maximum frames: `24`
- Recommended frame count: `8-15`
- Recommended loop duration: `1-3 seconds`
- Transparency: avoid; flatten to final background

The script extracts GIF frames and converts each frame to a numbered BMP for NSIS playback.

## Option B: Explicit Frame Sequence

- Directory: `carousel-frames/`
- Accepted extensions: `.png`, `.jpg`, `.jpeg`, `.bmp`
- Size per frame: `500 x 304 px`
- Maximum files: `24`
- Naming: zero-padded lexical order, for example:
  - `frame-001.png`
  - `frame-002.png`
  - `frame-003.png`

This is the most controllable animated option because the designer can pick exactly which frames ship.

## Option C: Static Fallback Carousel

Use these three files if no GIF or frame directory is present:

- `carousel-work.png|jpg|jpeg|bmp`
- `carousel-combo.png|jpg|jpeg|bmp`
- `carousel-tacit.png|jpg|jpeg|bmp`

Each file must be `500 x 304 px`. The build script converts them to numbered BMP files and the installer rotates between them.

## File Size Guidance

Each `500 x 304` 24-bit BMP output frame is about `456 KB`. A 24-frame animation adds about `10.9 MB` before installer compression. Keep frame count low for the small installer.

## Unused Legacy Asset

`product-panel.bmp` is currently not referenced by the RC bootstrap installer script or the desktop installer build chain. Keep it only as a design reference unless a future installer layout explicitly reuses it.
