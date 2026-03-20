# Agent SDK transpilation / build

Source: `packages/agent-sdk/package.json` and `packages/agent-sdk/tsup.config.ts`.

## Build pipeline

- `npm run build` runs:
  - `build:bundle`: `tsup --config tsup.config.ts`
  - `build:types`: `tsc -p tsconfig.json`
- Output directory: `dist/`
- Bundles include `src/index.ts` and `src/browser.ts`.
- Formats: ESM + CJS with `.mjs` / `.cjs` extensions.
- Source maps enabled, ES2022 target.

## Key scripts

```bash
npm run build -w @smolpaws/agent-sdk
npm run build:bundle -w @smolpaws/agent-sdk
npm run build:types -w @smolpaws/agent-sdk
```
