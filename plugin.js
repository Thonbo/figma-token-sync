// ─── Design Token Sync — Generic Figma Plugin ─────────────────────────────────
//
// Supports full W3C DTCG token set:
//   COLOR   → Figma Variable (COLOR)
//   FLOAT   → Figma Variable (FLOAT) — spacing, radius, fontSize, fontWeight, etc.
//   STRING  → Figma Variable (STRING) — fontFamily
//   SHADOW  → Figma Effect Style
//
// Alias tokens ({path.to.token}) are created as proper Figma variable aliases.
//
// ─────────────────────────────────────────────────────────────────────────────

figma.showUI(__html__, { width: 440, height: 600, title: 'Design Token Sync' })

// ── Type maps ─────────────────────────────────────────────────────────────────

const FLOAT_TYPES = new Set([
  'spacing', 'sizing', 'dimension', 'borderRadius', 'borderWidth',
  'fontSizes', 'lineHeights', 'fontWeights', 'letterSpacing',
  'paragraphSpacing', 'opacity', 'number', 'duration',
])
const STRING_TYPES = new Set(['fontFamilies', 'fontFamily'])
const SHADOW_TYPES = new Set(['boxShadow', 'shadow'])

function getFigmaVariableType(type) {
  if (type === 'color') return 'COLOR'
  if (FLOAT_TYPES.has(type)) return 'FLOAT'
  if (STRING_TYPES.has(type)) return 'STRING'
  return null
}

// ── Value converters ──────────────────────────────────────────────────────────

function toFigmaColor(value) {
  if (typeof value === 'object' && value !== null && 'colorSpace' in value) {
    const [r, g, b] = value.components || [0, 0, 0]
    return { r, g, b, a: value.alpha ?? 1 }
  }
  const str = String(value)
  const rgba = str.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/)
  if (rgba) {
    return {
      r: parseFloat(rgba[1]) / 255,
      g: parseFloat(rgba[2]) / 255,
      b: parseFloat(rgba[3]) / 255,
      a: rgba[4] !== undefined ? parseFloat(rgba[4]) : 1,
    }
  }
  const hex = str.replace('#', '')
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
    a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
  }
}

function toFigmaFloat(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'object' && value !== null && 'value' in value) {
    if (value.unit === 'rem') return value.value * 16
    return value.value
  }
  const str = String(value).trim()
  if (str.endsWith('rem')) return parseFloat(str) * 16
  if (str.endsWith('px')) return parseFloat(str)
  if (str.endsWith('ms')) return parseFloat(str)
  if (str.endsWith('%')) return parseFloat(str) / 100
  if (str.endsWith('em')) return parseFloat(str)
  return parseFloat(str) || 0
}

function toFigmaString(value) {
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

// ── Alias detection ───────────────────────────────────────────────────────────

function isAlias(value) {
  return typeof value === 'string' && /^\{[^}]+\}$/.test(value.trim())
}

function aliasPath(value) {
  // '{color.primitive.blue-500}' → 'color/primitive/blue-500'
  return value.trim().slice(1, -1).replace(/\./g, '/')
}

// ── Shadow parser ─────────────────────────────────────────────────────────────

function parseShadowEffects(value) {
  const shadows = Array.isArray(value) ? value : [value]
  const effects = []

  for (const s of shadows) {
    if (s === 'none' || s === null) continue

    if (typeof s === 'object' && 'x' in s) {
      // Token Studio format: { x, y, blur, spread, color, type }
      const color = toFigmaColor(s.color)
      effects.push({
        type: s.type === 'innerShadow' ? 'INNER_SHADOW' : 'DROP_SHADOW',
        color: { r: color.r, g: color.g, b: color.b, a: color.a },
        offset: { x: parseFloat(s.x) || 0, y: parseFloat(s.y) || 0 },
        radius: parseFloat(s.blur) || 0,
        spread: parseFloat(s.spread) || 0,
        visible: true,
        blendMode: 'NORMAL',
      })
    } else if (typeof s === 'string') {
      // Basic CSS string parsing: '0 4px 6px -1px rgba(0,0,0,0.1)'
      const isInner = s.includes('inset')
      const clean = s.replace('inset', '').trim()
      const m = clean.match(/(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px(?:\s+(-?[\d.]+)px)?\s+(rgba?\([^)]+\)|#[\da-f]+)/i)
      if (m) {
        const color = toFigmaColor(m[5])
        effects.push({
          type: isInner ? 'INNER_SHADOW' : 'DROP_SHADOW',
          color: { r: color.r, g: color.g, b: color.b, a: color.a },
          offset: { x: parseFloat(m[1]), y: parseFloat(m[2]) },
          radius: parseFloat(m[3]),
          spread: parseFloat(m[4] || '0'),
          visible: true,
          blendMode: 'NORMAL',
        })
      }
    }
  }
  return effects
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function* walkNodes(node) {
  yield node
  if ('children' in node) for (const child of node.children) yield* walkNodes(child)
}

function sendProgress(msg) {
  figma.ui.postMessage({ type: 'progress', message: msg })
}

// ── Main ──────────────────────────────────────────────────────────────────────

figma.ui.onmessage = async (msg) => {
  if (msg.type !== 'sync') return

  const { tokens, collectionName, bindNodes } = msg
  // tokens: [[name, { value, type, description }], ...]

  try {
    // ── 1. Collection ────────────────────────────────────────────────────────
    sendProgress(`Setting up "${collectionName}" …`)

    let collection = figma.variables
      .getLocalVariableCollections()
      .find(c => c.name === collectionName)

    if (!collection) {
      collection = figma.variables.createVariableCollection(collectionName)
      collection.renameMode(collection.defaultModeId, 'Default')
    }

    const modeId = collection.defaultModeId

    // ── 2. Index existing variables ──────────────────────────────────────────
    const existing = {}
    for (const v of figma.variables.getLocalVariables()) {
      if (v.variableCollectionId === collection.id) existing[v.name] = v
    }

    // ── 3. Sort tokens into buckets ──────────────────────────────────────────
    const tokenMap = Object.fromEntries(tokens)
    const variableTokens = []
    const shadowTokens   = []

    for (const [name, token] of tokens) {
      const figmaType = getFigmaVariableType(token.type)
      if (figmaType)                    variableTokens.push([name, token, figmaType])
      else if (SHADOW_TYPES.has(token.type)) shadowTokens.push([name, token])
    }

    // Non-aliases before aliases (aliases need the source variable to exist first)
    const base    = variableTokens.filter(([, t]) => !isAlias(t.value))
    const aliased = variableTokens.filter(([, t]) =>  isAlias(t.value))

    let created = 0, updated = 0, stylesMade = 0, errors = 0
    const variableByName = {}

    // ── 4. Base variables ────────────────────────────────────────────────────
    sendProgress(`Creating ${base.length} base variables …`)

    for (const [name, token, figmaType] of base) {
      try {
        let variable = existing[name]
        if (!variable) {
          variable = figma.variables.createVariable(name, collection, figmaType)
          if (token.description) variable.description = token.description
          created++
        } else {
          updated++
        }
        variableByName[name] = variable

        let val
        if (figmaType === 'COLOR')  val = toFigmaColor(token.value)
        if (figmaType === 'FLOAT')  val = toFigmaFloat(token.value)
        if (figmaType === 'STRING') val = toFigmaString(token.value)
        variable.setValueForMode(modeId, val)
      } catch (e) { errors++; console.error(`[base] ${name}:`, e.message) }
    }

    // ── 5. Alias variables ───────────────────────────────────────────────────
    sendProgress(`Resolving ${aliased.length} alias variables …`)

    for (const [name, token, figmaType] of aliased) {
      try {
        let variable = existing[name]
        if (!variable) {
          variable = figma.variables.createVariable(name, collection, figmaType)
          if (token.description) variable.description = token.description
          created++
        } else {
          updated++
        }
        variableByName[name] = variable

        const refName = aliasPath(token.value)
        const sourceVar = variableByName[refName]

        if (sourceVar) {
          // True Figma alias — updates when source changes
          variable.setValueForMode(modeId, figma.variables.createVariableAlias(sourceVar))
        } else {
          // Source not yet created — fall back to resolved value
          const src = tokenMap[refName]
          if (src) {
            let val
            if (figmaType === 'COLOR')  val = toFigmaColor(src.value)
            if (figmaType === 'FLOAT')  val = toFigmaFloat(src.value)
            if (figmaType === 'STRING') val = toFigmaString(src.value)
            variable.setValueForMode(modeId, val)
          }
        }
      } catch (e) { errors++; console.error(`[alias] ${name}:`, e.message) }
    }

    // ── 6. Shadow effect styles ───────────────────────────────────────────────
    if (shadowTokens.length) {
      sendProgress(`Creating ${shadowTokens.length} shadow styles …`)
      const existingStyles = {}
      for (const s of figma.getLocalEffectStyles()) existingStyles[s.name] = s

      for (const [name, token] of shadowTokens) {
        try {
          const effects = parseShadowEffects(token.value)
          if (!effects.length) continue
          let style = existingStyles[name]
          if (!style) { style = figma.createEffectStyle(); style.name = name; stylesMade++ }
          style.effects = effects
          if (token.description) style.description = token.description
        } catch (e) { errors++; console.error(`[shadow] ${name}:`, e.message) }
      }
    }

    sendProgress(`${created} created, ${updated} updated, ${stylesMade} styles${errors ? `, ${errors} errors` : ''}`)

    if (!bindNodes) {
      figma.ui.postMessage({ type: 'done', created, updated, stylesMade, bound: 0, errors })
      figma.notify(`✅ ${created} vars created, ${updated} updated, ${stylesMade} styles`, { timeout: 5000 })
      return
    }

    // ── 7. Color → variable index for node binding ───────────────────────────
    const colorIndex    = {}
    const colorPriority = {}
    const PRIORITY_ORDER = ['component', 'semantic', 'body', 'chat', 'header', 'chart', 'brand', 'primitive']

    for (const [name, token, figmaType] of base) {
      if (figmaType !== 'COLOR') continue
      const fc = toFigmaColor(token.value)
      const key = `${fc.r.toFixed(3)},${fc.g.toFixed(3)},${fc.b.toFixed(3)},${fc.a.toFixed(3)}`
      const group = name.split('/')[0]
      const pri = PRIORITY_ORDER.indexOf(group) >= 0 ? PRIORITY_ORDER.indexOf(group) : 99
      if (!(key in colorPriority) || pri < colorPriority[key]) {
        colorIndex[key] = variableByName[name]
        colorPriority[key] = pri
      }
    }

    function paintToKey(paint) {
      if (paint.type !== 'SOLID') return null
      const { r, g, b } = paint.color
      const a = (paint.opacity ?? 1) * (paint.color.a ?? 1)
      return `${r.toFixed(3)},${g.toFixed(3)},${b.toFixed(3)},${a.toFixed(3)}`
    }

    // ── 8. Walk page and bind ────────────────────────────────────────────────
    let bound = 0
    sendProgress('Binding nodes to color variables …')

    for (const node of walkNodes(figma.currentPage)) {
      for (const prop of ['fills', 'strokes']) {
        if (!(prop in node) || !Array.isArray(node[prop]) || !node[prop].length) continue
        try {
          const newPaints = []
          let changed = false
          for (const paint of node[prop]) {
            if (paint.type !== 'SOLID') { newPaints.push(paint); continue }
            const v = colorIndex[paintToKey(paint)]
            if (v) {
              newPaints.push(figma.variables.setBoundVariableForPaint(paint, 'color', v))
              changed = true
            } else {
              newPaints.push(paint)
            }
          }
          if (changed) { node[prop] = newPaints; bound++ }
        } catch (_) { /* locked/instance nodes */ }
      }
    }

    figma.ui.postMessage({ type: 'done', created, updated, stylesMade, bound, errors })
    figma.notify(`✅ ${created} vars · ${stylesMade} styles · ${bound} nodes bound`, { timeout: 6000 })

  } catch (err) {
    figma.ui.postMessage({ type: 'error', message: err.message })
    figma.notify(`❌ ${err.message}`, { error: true })
  }
}
