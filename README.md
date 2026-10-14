# trustchain

An offline tool for drawing a chain of trust for password storage (which databases hold which keys, and which keys unlock which databases) and proving it has no circular dependency.

The design is specified in [`docs/DESIGN.md`](docs/DESIGN.md).

## Privacy and limits

- The app is static files. It makes **no network requests**, which a strict Content Security Policy (`connect-src 'none'`) enforces.
- It models *where* secrets live. **Do not enter real secrets.** It warns about text that looks like a pasted key or token, but it cannot recognise word-based secrets such as seed phrases or passphrases.
- Saving work is planned for a later release, encrypted at rest in your browser. Until then nothing is stored: closing the tab discards the diagram.
- It **cannot** protect you from malware on your device, malicious browser extensions, a compromised browser, or someone watching your screen.

## Hosting

> **Warning:** do not deploy this app to `tuna-guven.github.io` (or any `<account>.github.io` address). All GitHub Pages sites of an account share one browser origin, so any other site on it could take over the app or read its data. The app will be served from a dedicated custom domain; until then the deploy workflow is parked in `.github/disabled-workflows/`, where GitHub does not run it. See [`docs/DESIGN.md`](docs/DESIGN.md) section 10.7.

## Run locally

```bash
npm ci
npm run build
npm run preview   # serves dist/ on 127.0.0.1 only
```

Any static file server bound to localhost works. There is no backend.

## Verify a build

```bash
npm ci && npm run build
```

Then compare `dist/` with the deployed files.

## Development

See [`CLAUDE.md`](CLAUDE.md) for commands and rules. Run `npm run check` before every commit.

## License

GPL-3.0-or-later. See [`LICENSE`](LICENSE).
