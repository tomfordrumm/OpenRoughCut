# OpenRoughCut website

The light-mode landing page for [OpenRoughCut](https://github.com/tomfordrumm/OpenRoughCut). It is a single responsive route built with Next-compatible React, vinext, and the Sites runtime.

## Local development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

The local site is available at `http://localhost:3000`.

## Validation

```bash
npm test
```

This creates the production build and verifies the server-rendered page, core content, GitHub links, and release download targets.

## Hosting

The public site is deployed at [orc.yhub.net](https://orc.yhub.net). Run `npm run deploy:yhub` to build and publish an update using the ignored local `.env` credentials. The site itself does not require a database, object storage, or visitor authentication.

Release downloads are served directly from the [OpenRoughCut v0.1.3 GitHub release](https://github.com/tomfordrumm/OpenRoughCut/releases/tag/v0.1.3).
