// MCP tool: ask the running game for runtime facts, directly from the Archive server.
//
// WHY A TOOL AND NOT JUST THE CLIENT: the value is in the JOIN. Archive knows what the source
// says it will do; Bridge knows what the process actually did. A modder who has just built a
// mod needs both halves in one answer — "the source declares a transpiler on this method, and
// the running game confirms two owners are on it", or the more useful inverse, "the source
// declares a patch but the running game does not see it, so it did not attach".
//
// It reports the two sides side by side and does not merge them into a single verdict. Source
// declarations and runtime introspection can disagree for legitimate reasons (a mod disabled,
// a conditional patch, a stale DLL), and collapsing that into "conflict / no conflict" would
// hide exactly the information the caller needs to tell those cases apart.

import { renderAiTextReport } from '../utils/ai-text'
import {
  BRIDGE_ACTIONS,
  actionNeedsGame,
  invokeBridge,
  type BridgeAction,
} from '../utils/bridge-client'

export type BridgeQueryInput = {
  /** Which Bridge action to run. */
  action: string
  /** Directory containing bl_cmd.py; defaults to BANNERSAGE_BRIDGE_DIR. */
  bridgeDir?: string
  /** Optional filter flags, forwarded as `--name value`. */
  flags?: Record<string, string | number | boolean>
}

export async function bridgeQuery(input: BridgeQueryInput) {
  const action = (input.action ?? '').trim()
  if (!action) {
    return report('', [{ key: 'error', value: `action is required; known: ${BRIDGE_ACTIONS.join(', ')}` }])
  }
  if (!(BRIDGE_ACTIONS as readonly string[]).includes(action)) {
    return report(action, [
      { key: 'error', value: `unknown action ${action}` },
      { key: 'known_actions', value: BRIDGE_ACTIONS.join(', ') },
    ])
  }

  const result = await invokeBridge(action as BridgeAction, {
    bridgeDir: input.bridgeDir,
    flags: input.flags,
  })

  const needsGame = actionNeedsGame(action as BridgeAction)

  const fields = [
    { key: 'action', value: result.action },
    { key: 'exit_code', value: result.exitCode },
    { key: 'needs_running_game', value: needsGame },
    ...(result.error ? [{ key: 'error', value: result.error }] : []),
    ...(!result.error && result.exitCode !== 0
      ? [{ key: 'failure_source', value: 'the Bridge reported a failure; read its stdout below' }]
      : []),
  ]

  const lists: Array<{ key: string; values: string[] }> = []

  if (result.payload !== null) {
    // The Bridge's own JSON is passed through rather than re-summarised: re-formatting would
    // drop fields this tool has no opinion about, and those fields are often the answer.
    lists.push({
      key: 'payload',
      values: JSON.stringify(result.payload, null, 1).split('\n').slice(0, 200),
    })
  } else if (result.stdout.trim()) {
    lists.push({ key: 'stdout', values: result.stdout.trim().split('\n').slice(0, 200) })
  }

  if (result.stderr.trim()) {
    lists.push({ key: 'stderr', values: result.stderr.trim().split('\n').slice(0, 40) })
  }

  lists.push({
    key: 'notes',
    values: [
      'Runs the Bridge CLI as a subprocess; no shared code crosses the module boundary.',
      ...(needsGame
        ? [`This action needs the game running and BlBridge loaded; a timeout usually means it is not.`]
        : []),
      'Pair with check_mod_conflicts: source declares what should attach, this reports what did.',
    ],
  })

  return report(action, fields, lists)
}

function report(
  queryValue: string,
  fields: Array<{ key: string; value: string | number | boolean }>,
  lists: Array<{ key: string; values: string[] }> = [],
) {
  return {
    content: [
      {
        type: 'text' as const,
        text: renderAiTextReport('bridge_query', 'action', queryValue, [{ fields, listFields: lists }], []),
      },
    ],
  }
}
