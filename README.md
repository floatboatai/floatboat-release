Welcome to the community of [Floatboat](https://floatboat.ai). We release nighly builds here. You can try on to get the latest laboratory features, along with some unexpected crashes🤣. 
You can report the issues here, or contact us at contact@floatboat.ai


> This page is still in construction.  

## RC Windows bootstrap carousel

The RC Windows bootstrap installer can load optional campaign carousel frames from:

`https://release.aoe.chat/rc/Floatboat-Installer-RC-carousel.zip`

Replace that ZIP to update campaign images without rebuilding the small installer. The current ZIP layout is:

- `1.bmp`: welcome product image (`164 x 314`)
- `2.bmp`: first product carousel image (`500 x 304`)
- `zh/`: Chinese carousel images shown after `2.bmp`
- `en/`: English carousel images shown after `2.bmp`

The small installer selects `zh/` when Windows is using the Chinese installer locale; all other locales use `en/`.
