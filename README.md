# trustchain

An offline tool for drawing a chain of trust for password storage (which databases hold which keys, and which keys unlock which databases) and proving it has no circular dependency.

The design is specified in [`docs/DESIGN.md`](docs/DESIGN.md).

## Privacy and limits

- The app is static files. It makes **no network requests**, which a strict Content Security Policy (`connect-src 'none'`) enforces.
- It models *where* secrets live. **Do not enter real secrets.**
- Saved work is encrypted at rest in your browser.
- It **cannot** protect you from malware on your device, malicious browser extensions, a compromised browser, or someone watching your screen.

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

GPL-3.0. See [`LICENSE`](LICENSE).
