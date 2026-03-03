# Design Token Sync — Figma Plugin

A generic Figma plugin that pushes design tokens from any React / Next.js / Tailwind project into Figma as native Variables.

## What it does

- Reads tokens from a **URL** (dev server or GitHub raw) or **pasted JSON**
- Accepts **Token Studio format** (`design-tokens.json` with `$value` / `$type`)
- Creates/updates a **Figma Variable collection** with all color tokens
- Optionally **binds every node** in the current page to matching variables

## Install

1. Open Figma → Plugins → Development → **Import plugin from manifest**
2. Select `manifest.json` from this folder
3. Run via Plugins → Development → **Design Token Sync**

## Usage

### From a running dev server (recommended)

Add this route to your Next.js app:

```ts
// src/app/api/tokens/route.ts
import { NextResponse } from 'next/server'
import tokens from '../../../../design-tokens.json'

export async function GET() {
  return NextResponse.json(tokens, {
    headers: { 'Access-Control-Allow-Origin': '*' },
  })
}
```

Then in the plugin, set the URL to `http://localhost:3000/api/tokens` and click **Fetch**.

### From GitHub (deployed tokens)

Point the URL at a raw GitHub URL:
```
https://raw.githubusercontent.com/your-org/your-repo/main/design-tokens.json
```

### Paste JSON

Switch to the **Paste JSON** tab and paste your `design-tokens.json` directly.

## Token format

Expects [Token Studio](https://tokens.studio) format:

```json
{
  "global": {
    "color": {
      "primitive": {
        "blue": { "$value": "#3B82F6", "$type": "color", "$description": "Primary brand" }
      },
      "body": {
        "bg": { "$value": "#080D1A", "$type": "color" }
      }
    }
  }
}
```

Set **Strip prefix** to `global/color` (default) so variable names become `primitive/blue`, `body/bg`, etc.

## Options

| Option | Description |
|--------|-------------|
| Collection name | Name of the Figma Variable collection (one per project) |
| Strip prefix | Removes a path prefix from token names |
| Bind nodes | Scans all nodes on the current page and binds fills/strokes to matching variables |

## Sync workflow

```
design-tokens.json  →  [this plugin]  →  Figma Variables
                    ←  pull-from-figma.mjs  ←  Figma Variables (source of truth)
```
