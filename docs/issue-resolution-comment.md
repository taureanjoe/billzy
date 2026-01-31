# Comment to add when resolving the parsing issue

Copy the text below and paste it as a **comment** on the GitHub issue, then close the issue.

---

**Parsing has been improved in the latest release.** We've made two changes to reduce missing items:

1. **"Love Street" and similar items** — Lines containing words like "street" are no longer skipped unless they look like real addresses (e.g. end with a zip code or start with a street number). Item names such as "Love Street" are now parsed correctly.

2. **Split lines** — When the receipt image has the item name on one line and the price on the next (e.g. "D-Chili Shrimp" then "18.00"), we now merge them into a single line item.

**Note:** Some item names may still be dropped or misread when the image quality is low or the text is unclear. **For best results, use a high-quality, well-lit image of the receipt.** OCR works best with clear, legible text. You can always tap any item to edit its name or price manually after parsing.

---

After posting this comment, click **"Close issue"** to mark the issue as resolved.
