/**
 * MyWorkbench lane plugin — HOST half.
 *
 * One packaged DSH agent-preset plugin that owns the MyWorkbench specialist
 * delegation tools. Each tool starts a child under that lane's own agent preset
 * (`my-workbench-explorer`, `my-workbench-fixer`, …), where the specialist
 * persona and the lane's read-only tool set are composed — DSH 0.2.x has no
 * per-request `persona`/`toolFilter`; a child's identity and tools come from the
 * preset it mounts (`dsh-subagent` README, "Child presets").
 *
 * Mounted by ONE row inside the MyWorkbench orchestrator preset's plugin list
 * (`agents/backends/dsh/orchestrator-preset.cordis.yml`, installed into
 * `<DSH_HOME>/cordis.patch.yml` by `my-workbench --dsh`):
 *
 *     - id: lanes
 *       name: <file: URL of this module, baked at install time>
 *
 * `my-workbench --dsh` also installs seven child preset declarations beside the
 * orchestrator preset; each one composes the lane's persona (rendered from
 * `agents/prompts/<lane>.md`) and only the tools that lane may use. Nothing here
 * grants or withholds a tool: the preset composition is the enforcement.
 *
 * ── NO PACKAGE IMPORTS ─────────────────────────────────────────────────────
 * This module imports only its two generated sibling modules. A plugin mounted
 * from a `file:` URL under `<DSH_HOME>` cannot resolve a harness package by bare
 * name, and baking an absolute path to the harness's own `dsh-tools` copy would
 * tie the install to one DSH installation and version. The tool definitions are
 * therefore plain `ToolDefinition` objects — the registry accepts a raw
 * definition and projects `parameters` as model-facing JSON Schema — and the
 * row config is read as-is (no schemastery schema). Everything the plugin needs
 * arrives through `ctx.tools` and `ctx.subagents`.
 *
 * @module my-workbench-lanes
 */

import { LANE_PROMPTS } from './prompts.generated.js'
import { LANES } from './roster.generated.js'

/** Plugin name reported to the loader. */
export const name = 'my-workbench-lanes'

/**
 * Hard dependencies. `tools` and `subagents` are provided by the profile
 * (dsh-base mounts the registries), so a preset-scoped row resolves the host
 * instance.
 */
export const inject = ['tools', 'subagents']

/** Child preset id this lane's tool delegates to. */
const PRESET_PREFIX = 'my-workbench-'

// ── helpers ─────────────────────────────────────────────────────────────────

/** Human-readable text of one thrown value. */
function errorText(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

/** Concatenate the text blocks of one subagent result. */
function textOf(result) {
  const parts = []
  if (result !== null && typeof result === 'object' && Array.isArray(result.output)) {
    for (const block of result.output) {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('')
}

/**
 * One lane's pinned route, or undefined for "inherit the session's route".
 *
 * Empty strings mean inherit — the installed JSON file keeps every lane visible
 * and lets a user clear one by emptying it instead of deleting a key.
 *
 * @param {{ provider?: unknown, model?: unknown, reasoningEffort?: unknown } | undefined} pin - configured pin.
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined} the route override.
 */
function routeOf(pin) {
  if (pin === null || pin === undefined || typeof pin !== 'object') return undefined
  const provider = typeof pin.provider === 'string' ? pin.provider.trim() : ''
  const model = typeof pin.model === 'string' ? pin.model.trim() : ''
  if (provider === '' || model === '') return undefined
  const effort = typeof pin.reasoningEffort === 'string' ? pin.reasoningEffort.trim() : ''
  return effort === '' ? { provider, model } : { provider, model, reasoningEffort: effort }
}

/** Printable form of a lane's route, for tool output. */
function routeText(route) {
  if (route === undefined) return 'inherit'
  return route.provider + '/' + route.model + (route.reasoningEffort === undefined ? '' : ' · ' + route.reasoningEffort)
}

/**
 * This lane's specialist prompt, taken from the generated prompt module that
 * `my-workbench --dsh` renders out of `agents/prompts/*.md`.
 *
 * @param {string} laneKey - roster key.
 * @returns {string} the specialist prompt.
 * @throws {Error} when the lane has no prompt — a packaging bug, and one that must
 *   fail the mount loudly rather than delegate without an identity.
 */
function lanePrompt(laneKey) {
  const value = LANE_PROMPTS[laneKey]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('my-workbench-lanes: lane "' + laneKey + '" has no persona; src/prompts.generated.js was not rendered (run `my-workbench --dsh`)')
  }
  return value
}

// ── activation ──────────────────────────────────────────────────────────────

/**
 * Whether `startActivation` takes the flat request (0.2.1-rc.3 and later) or the
 * nested `request` field of 0.2.1-rc.2. Resolved by the first call, because the
 * service exposes no shape or version of its own.
 */
let flatSpec = true

/**
 * Start one lane activation, tolerating both request shapes.
 *
 * DSH 0.2.1-rc.2 takes `{ provider, label, request: {...}, signal, delivery }`;
 * the next release flattens the task options onto the spec. Both shapes were
 * released, so both are supported: a flat call that fails with a TypeError
 * (the nested implementation dereferences `spec.request`) is retried once in
 * the nested shape and the answer is remembered for the process.
 *
 * @param {object} ctx - the preset-scoped plugin context.
 * @param {{ provider: string, label: string }} head - provider and label.
 * @param {object} task - prompt, parent, agentPreset, agentOptions, maxDepth.
 * @param {AbortSignal} signal - caller lifetime.
 * @param {"parent" | "caller"} delivery - completion delivery target.
 * @returns {Promise<object>} the activation.
 */
async function startLane(ctx, head, task, signal, delivery) {
  if (flatSpec) {
    try {
      return await ctx.subagents.startActivation({ ...head, ...task, signal, delivery })
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
      flatSpec = false
    }
  }
  return ctx.subagents.startActivation({ ...head, request: task, signal, delivery })
}

/**
 * Await one activation's result, cancelling the activation when the caller's
 * signal aborts (a published activation is not cancelled by its caller's
 * signal; `dispose()` is the only way to stop it).
 *
 * @param {object} activation - the started activation.
 * @param {AbortSignal} signal - the tool call's signal.
 * @returns {Promise<object>} the subagent result.
 */
function awaitLane(activation, signal) {
  if (signal === undefined) return activation.result
  if (signal.aborted) {
    void activation.dispose().catch(() => {})
    return Promise.reject(signal.reason ?? new Error('aborted'))
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      void activation.dispose().catch(() => {})
      reject(signal.reason ?? new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    activation.result.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

// ── the tool ────────────────────────────────────────────────────────────────

/**
 * Build one lane's model-facing delegation tool.
 *
 * @param {object} ctx - the preset-scoped plugin context (for `ctx.subagents`).
 * @param {object} lane - rendered roster entry (`key`, `tool`, `zh`).
 * @param {(key: string) => object | undefined} pinOf - live pin reader.
 * @param {number} maxDepth - child depth budget from the row config.
 * @returns {object} a registry-ready raw ToolDefinition.
 */
function laneTool(ctx, lane, pinOf, maxDepth) {
  const preset = PRESET_PREFIX + lane.key
  return {
    name: lane.tool,
    description:
      'Delegate to the ' + lane.key + ' specialist (' + lane.zh + ') of the MyWorkbench roster. The child runs under the ' + preset + ' preset, which carries that specialist\'s persona and its restricted tool set. ' +
      'Starts the child in the background by default and returns its name; pass run_in_background: false to wait for the final report instead.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The complete, self-contained task for this specialist.' },
        run_in_background: {
          type: 'boolean',
          description: 'Defaults to true: start a background child and return its name. Set false to wait for the final text.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value) }]
      },
    },
    async execute(args, exec) {
      const task = args !== null && typeof args === 'object' ? args : {}
      if (typeof task.prompt !== 'string' || task.prompt.trim() === '') {
        throw new Error(lane.tool + ': prompt must be a non-empty string')
      }
      const parent = exec.agent
      if (parent === undefined) throw new Error(lane.tool + ': this tool needs a calling agent')
      const background = task.run_in_background !== false
      const route = routeOf(pinOf(lane.key))
      const request = {
        prompt: [{ type: 'text', text: task.prompt }],
        parent,
        agentPreset: preset,
        maxDepth,
      }
      if (route !== undefined) request.agentOptions = route
      let activation
      try {
        activation = await startLane(ctx, { provider: 'spawn', label: lane.key + ' lane' }, request, exec.signal, background ? 'parent' : 'caller')
      } catch (error) {
        throw new Error('lane ' + lane.key + ' (' + routeText(route) + ') could not start: ' + errorText(error))
      }
      const handle = String(activation.name ?? activation.childId)
      if (background) {
        return (
          'started subagent ' + handle + ' — lane ' + lane.key + ' (' + lane.zh + '), route ' + routeText(route) +
          '. Continue it with send_message; its completion notice carries the report.'
        )
      }
      try {
        const result = await awaitLane(activation, exec.signal)
        const text = textOf(result)
        const stopReason = result !== null && typeof result === 'object' ? result.stopReason : undefined
        if (stopReason !== undefined && stopReason !== 'completed') {
          const diagnostic = result.diagnostic === undefined ? '' : ': ' + String(result.diagnostic)
          throw new Error('lane ' + lane.key + ' ended with ' + String(stopReason) + diagnostic + (text === '' ? '' : '\n\n' + text))
        }
        return text === '' ? '(lane ' + lane.key + ' returned no text; route ' + routeText(route) + ')' : text
      } finally {
        try {
          await activation.dispose()
        } catch {
          // cleanup is best-effort once the run settled
        }
      }
    },
  }
}

// ── the plugin ──────────────────────────────────────────────────────────────

/**
 * Register one delegation tool per specialist.
 *
 * @param {object} ctx - the preset-scoped plugin context.
 * @param {{ maxDepth?: number, pins?: Record<string, object> }} [config] - row config.
 */
export function apply(ctx, config) {
  const settings = config !== null && typeof config === 'object' ? config : {}
  const maxDepth = Number.isInteger(settings.maxDepth) && settings.maxDepth >= 0 ? settings.maxDepth : 1
  const pins = settings.pins !== null && typeof settings.pins === 'object' ? settings.pins : {}
  const pinOf = (key) => (Object.hasOwn(pins, key) ? pins[key] : undefined)

  // Validate every generated persona once, at registration: a missing prompt
  // module is a packaging bug and must fail the mount, not degrade a delegation.
  // The plugin never passes a persona — the child's preset carries it — but a
  // lane whose prompt did not render would mount with no identity at all.
  for (const lane of LANES) lanePrompt(lane.key)

  for (const lane of LANES) ctx.tools.register(laneTool(ctx, lane, pinOf, maxDepth))
}
