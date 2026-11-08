# Solutions4Society (societybooks)

Co-operative housing society accounting software by Shreedeep Solutions — live at https://sas.shreedeepsolutions.com

## Files on this site

| File | What it is |
|---|---|
| `index.html` | The page that opens the app (small). |
| `app.<build>.js` | The whole app. The number changes with every version, so browsers never mix an old app with a new page. |
| `mdb.<build>.js` | The Society MAXX reader. Loaded only when importing from MAXX. |
| `sw.js` | Keeps the app on each computer, so it opens instantly and works offline. Each new version installs itself in the background and shows "A new version is available — Update now". |
| `manifest.webmanifest`, `icon-*.png` | Install as an app on phones and computers. |
| `database.rules.json` | Firebase security rules (same as in the Firebase console). |
| `CNAME` | Custom domain for GitHub Pages. |

Old `app.*.js` / `mdb.*.js` files of earlier versions are deleted when a new version is published.

The data is not here — it lives in the Firebase Realtime Database.
