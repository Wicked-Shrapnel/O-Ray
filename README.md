# Test Plan Writer

An X-Ray-style test plan editor for Obsidian.

## Installation

1. Copy `main.js`, `manifest.json`, and `styles.css` into an Obsidian vault at `.obsidian/plugins/test-plan-writer/`.
2. Enable **Test Plan Writer** in Obsidian's community plugins settings.

## Development

Install dependencies and run the development build:

```bash
npm install
npm run dev
```

Create a production build with:

```bash
npm run build
```

This repository intentionally does not include vault-specific `data.json` settings or test-plan files.
