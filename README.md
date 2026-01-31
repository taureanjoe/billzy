# billzy

**Scan → Parse → Split.** No account. No saving. No backend.

A static, mobile-first web app that lets you upload receipt images, parse them with client-side OCR, and split the bill among up to 20 people. Everything runs in the browser; nothing is stored or sent to a server.

## Features

- **Upload receipts** — JPG, PNG; drag & drop or tap to browse; multiple receipts at once
- **OCR parsing** — Client-side (Tesseract.js); extracts items and prices into a table
- **Parsing feedback** — Warnings when items are uncertain, total doesn’t match, or prices are missing
- **Manual correction** — Edit item names and prices; add or remove rows
- **People** — Add up to 20 people (names only for the session)
- **Assign items** — Checkboxes to assign each line item to one or more people (shared = split equally)
- **Auto split** — Instant per-person totals
- **Export** — Copy result as text or download as CSV

## Run locally

Open `index.html` in a browser, or use a simple static server:

```bash
# Python
python3 -m http.server 8000

# Node (npx)
npx serve .
```

Then visit `http://localhost:8000` (or the port shown).

## Deploy on GitHub Pages

1. Push this repo to GitHub.
2. **Settings → Pages** → Source: **Deploy from a branch**.
3. Branch: **main** (or **master**), folder: **/ (root)**.
4. Save. The site will be at `https://<username>.github.io/<repo>/`.

No build step required — plain HTML, CSS, and JS with Tesseract.js loaded from a CDN.

## Tech

- HTML5, CSS3 (mobile-first), vanilla JS
- [Tesseract.js](https://tesseract.projectnaptha.com/) for in-browser OCR
- No frameworks, no backend, no cookies or storage

## License

See [LICENSE](LICENSE).
