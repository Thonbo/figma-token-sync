// ─── Design Token Sync — Generic Figma Plugin ─────────────────────────────────
//
// Works with any React / Next.js / Tailwind project that has a
// Token Studio–format design-tokens.json.
//
// Flow:
//   1. UI fetches tokens (URL or paste)
//   2. UI sends parsed [{name, value, type}] to this plugin
//   3. Plugin creates/updates a Variable collection
//   4. Optionally scans all nodes and binds fills/strokes by color match
//
// ─────────────────────────────────────────────────────────────────────────────

figma.showUI(__html__, { width: 420, height: 540, title: 'Design Token Sync' })

const TOLERANCE = 0.015

function toFigmaColor(cssValue) {
  // rgba(r, g, b, a)
  const rgba = cssValue.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/)
  if (rgba) {
    return {
      r: parseInt(rgba[1]) / 255,
      g: parseInt(rgba[2]) / 255,
      b: parseInt(rgba[3]) / 255,
      a: rgba[4] !== undefined ? parseFloat(rgba[4]) : 1,
    }
  }
  // #RRGGBB or #RGB
  const hex = cssValue.replace('#', '')
  if (hex.length === 3) {
    return {
      r: parseInt(hex[0] + hex[0], 16) / 255,
      g: parseInt(hex[1] + hex[1], 16) / 255,
      b: parseInt(hex[2] + hex[2], 16) / 255,
      a: 1,
    }
  }
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
    a: 1,
  }
}

function colorClose(a, b) {
  return (
    Math.abs(a.r - b.r) < TOLERANCE &&
    Math.abs(a.g - b.g) < TOLERANCE &&
    Math.abs(a.b - b.b) < TOLERANCE &&
    Math.abs((a.a ?? 1) - (b.a ?? 1)) < TOLERANCE
  )
}

function paintToRGBA(paint) {
  if (paint.type !== 'SOLID') return null
  const { r, g, b } = paint.color
  const a = (paint.opacity ?? 1) * (paint.color.a ?? 1)
  return { r, g, b, a }
}

function* walkNodes(node) {
  yield node
  if ('children' in node) for (const child of node.children) yield* walkNodes(child)
}

function sendProgress(msg) {
  figma.ui.postMessage({ type: 'progress', message: msg })
}

figma.ui.onmessage = async (msg) => {
  if (msg.type !== 'create-variables') return

  const { tokens, collectionName, bindNodes } = msg

  try {
    sendProgress(`Setting up collection "${collectionName}" …`)

    // ── 1. Find or create the variable collection ──────────────────────────
    let collection = figma.variables
      .getLocalVariableCollections()
      .find(c => c.name === collectionName)

    if (collection) {
      sendProgress(`Collection "${collectionName}" exists — updating variables …`)
    } else {
      collection = figma.variables.createVariableCollection(collectionName)
      collection.renameMode(collection.defaultModeId, 'Default')
    }

    const modeId = collection.defaultModeId

    // ── 2. Build lookup of existing variables ──────────────────────────────
    const existing = {}
    for (const v of figma.variables.getLocalVariables('COLOR')) {
      if (v.variableCollectionId === collection.id) existing[v.name] = v
    }

    // ── 3. Create / update variables ───────────────────────────────────────
    const variableMap = {}
    let created = 0, updated = 0

    for (const [name, token] of tokens) {
      const figmaColor = toFigmaColor(token.value)
      let variable = existing[name]
      if (!variable) {
        variable = figma.variables.createVariable(name, collection, 'COLOR')
        if (token.description) variable.description = token.description
        created++
      } else {
        updated++
      }
      variable.setValueForMode(modeId, figmaColor)
      variableMap[name] = variable
    }

    sendProgress(`${created} created, ${updated} updated · ${bindNodes ? 'binding nodes …' : 'skipping node binding'}`)

    if (!bindNodes) {
      figma.ui.postMessage({ type: 'done', created, updated, bound: 0 })
      figma.notify(`✅ ${created} vars created, ${updated} updated`, { timeout: 5000 })
      return
    }

    // ── 4. Build color → variable index ───────────────────────────────────
    const colorIndex = {}
    const colorPriority = {}
    const PRIORITY_ORDER = ['body', 'chat', 'header', 'chart', 'brand', 'semantic', 'primitive']

    for (const [name, token] of tokens) {
      const fc = toFigmaColor(token.value)
      const key = `${fc.r.toFixed(3)},${fc.g.toFixed(3)},${fc.b.toFixed(3)},${fc.a.toFixed(3)}`
      const group = name.split('/')[0]
      const pri = PRIORITY_ORDER.indexOf(group) >= 0 ? PRIORITY_ORDER.indexOf(group) : 99
      if (!(key in colorPriority) || pri < colorPriority[key]) {
        colorIndex[key] = variableMap[name]
        colorPriority[key] = pri
      }
    }

    function findVar(paint) {
      const rgba = paintToRGBA(paint)
      if (!rgba) return null
      const key = `${rgba.r.toFixed(3)},${rgba.g.toFixed(3)},${rgba.b.toFixed(3)},${rgba.a.toFixed(3)}`
      if (colorIndex[key]) return colorIndex[key]
      for (const [name, token] of tokens) {
        if (colorClose(rgba, toFigmaColor(token.value))) return variableMap[name]
      }
      return null
    }

    // ── 5. Walk all nodes on current page ─────────────────────────────────
    let bound = 0

    for (const node of walkNodes(figma.currentPage)) {
      for (const prop of ['fills', 'strokes']) {
        if (!(prop in node) || !Array.isArray(node[prop]) || !node[prop].length) continue
        try {
          const newPaints = []
          let changed = false
          for (const paint of node[prop]) {
            if (paint.type !== 'SOLID') { newPaints.push(paint); continue }
            const v = findVar(paint)
            if (v) {
              newPaints.push(figma.variables.setBoundVariableForPaint(paint, 'color', v))
              changed = true
            } else {
              newPaints.push(paint)
            }
          }
          if (changed) { node[prop] = newPaints; bound++ }
        } catch (_) { /* locked/instance nodes — skip */ }
      }
    }

    figma.ui.postMessage({ type: 'done', created, updated, bound })
    figma.notify(`✅ ${created} vars created · ${bound} nodes bound`, { timeout: 6000 })

  } catch (err) {
    figma.ui.postMessage({ type: 'error', message: err.message })
    figma.notify(`❌ ${err.message}`, { error: true })
  }
}
