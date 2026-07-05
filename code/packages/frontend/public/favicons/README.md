# Favicon options (email-themed)

Downloaded from [IconsDB](https://www.iconsdb.com/) (free, no attribution required).
All are 32×32 `.ico` files, 32-bit RGBA with a real, transparent alpha channel
(verified — none have an opaque background).

**Currently active:** `email-3-royalblue.ico` → copied to `../favicon.ico`
(a bold, filled envelope — stays legible at 16px and reads well on both light
and dark browser tabs).

## Preview

See `_montage.png` in this folder — it shows every option rendered on a white
tab (top row) and a dark tab (bottom row).

## Switch to a different one

From `code/packages/frontend/`:

```sh
cp public/favicons/<one-of-the-files-below> public/favicon.ico
```

Then hard-refresh the browser (favicons cache aggressively).

## Catalog

| File | Style | Notes |
|------|-------|-------|
| `email-3-royalblue.ico` | filled envelope, royal blue | **active** — bold, best small-size legibility |
| `email-blue.ico` | open envelope, caribbean blue | bright, classic email look |
| `email-message-cyan.ico` | filled envelope, cyan | similar to active, lighter |
| `email-2-green.ico` | sealed envelope, green | |
| `email-4-orange.ico` | open envelope w/ letter, orange | most detail — can blur at 16px |
| `email-5-purple.ico` | line-art envelope, purple | thin lines, faint when tiny |
| `email-black.ico` | open envelope outline, black | great on white, **poor on dark tabs** |
| `email-red.ico` | open envelope outline, red | thin outline style |
