# Favicon options (file / large-file themed)

Downloaded from [IconsDB](https://www.iconsdb.com/) (free, no attribution required).
All are 32×32 `.ico` files, 32-bit RGBA with a real, transparent alpha channel
(verified — none have an opaque background).

These replace the old email-themed icons that were copied over from the
EmailDeliveryHero sister app. Large File Bridge is about **large files**, so the
tab icon should read as *a file / something large*, not an envelope.

**Currently active:** `document.ico` → copied to `../favicon.ico`
(a filled page with text lines — the clearest, least-ambiguous "file" at 16px
and reads well on both light and dark browser tabs).

## Preview

See `_montage.png` in this folder — it shows every option rendered on a white
tab (top row) and a dark tab (bottom row), left-to-right in catalog order.

## Switch to a different one

From `code/packages/frontend/`:

```sh
cp public/favicons/<one-of-the-files-below> public/favicon.ico
# then regenerate the derived PNGs from the new favicon:
magick public/favicon.ico -resize 32x32 public/favicon-32x32.png
magick public/favicon.ico -resize 160x160 -background white -gravity center -extent 180x180 public/apple-touch-icon.png
```

Then hard-refresh the browser (favicons cache aggressively).

## Catalog

| File | Style | Notes |
|------|-------|-------|
| `document.ico` | filled page with text lines, royal blue | **active** — clearest "file", best small-size legibility |
| `file.ico` | blank page, folded corner | minimal, clean silhouette |
| `copy.ico` | two stacked pages | reads as "files" (plural) — fits a large-file app |
| `archive.ico` | page with a zipper | ties to the app's compression feature |
| `box.ico` | 3D box / package | best for "something large" — distinctive silhouette |
| `database.ico` | stacked cylinders | data / storage feel |
| `hard-drive.ico` | disk drive | storage device; plainer rectangle at 16px |
| `save.ico` | floppy disk | classic "save" metaphor; a bit dated |
