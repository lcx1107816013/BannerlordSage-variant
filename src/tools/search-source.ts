// src/tools/search-source.ts
import { PathSandbox } from '../utils/path-sandbox'
import { AiTextBlock, renderAiTextReport } from '../utils/ai-text'

// ── RAISED FROM 120 TO 500 (deliberate behaviour change, ledger F22) ────────────────────────
//
// ripgrep runs without --sort, so matches arrive in worker-completion order and the slice below
// keeps the first N of an arbitrarily ordered list. Measured on our own BlBridge C# source, a
// 357-match query returned a DIFFERENT 120-match subset on all five runs, so the limit was
// discarding results unstably. 500 covers the observed case, making those queries complete and
// stable.
//
// A full 500-block response costs about 23,000 tokens (a block is ~182 chars), which is why it is
// not raised further. ★ This does not make the tool deterministic in general: above 500 the
// returned subset is still arbitrary, and the `truncated` field reports which case you are in.
const MAX_MATCH_RESULTS = 500

type RipgrepMatch = {
  filePath: string
  lineNumber: number | null
  lineText: string
  submatchCount: number
}

type RipgrepParse = {
  matches: RipgrepMatch[]
  uniqueFileCount: number
}

export async function searchSource(
  sandbox: PathSandbox,
  query: string,
  caseSensitive: boolean = false,
  filePattern?: string
) {
  const process = Bun.spawn(['rg', ...buildRipgrepArgs(query, caseSensitive, filePattern)], {
    cwd: sandbox.basePath,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])

  // ripgrep reports 0 for "found matches" and 1 for "found nothing"; anything
  // else is a real failure.
  const ripgrepFailed = exitCode !== 0 && exitCode !== 1
  if (ripgrepFailed) {
    throw new Error(`ripgrep failed while searching source: ${stderrText.trim() || `exit code ${exitCode}`}`)
  }

  const parsed = parseRipgrepJson(stdoutText)
  const returnedMatches = parsed.matches.slice(0, MAX_MATCH_RESULTS)
  const blocks: AiTextBlock[] = returnedMatches.map((match, position) => ({
    header: `match_${position + 1}`,
    fields: [
      { key: 'file_path', value: match.filePath },
      { key: 'line_number_1based', value: match.lineNumber },
      { key: 'submatch_count', value: match.submatchCount },
    ],
    multilineFields: [{ key: 'line_text', value: match.lineText }],
  }))

  const overLimit = parsed.matches.length > MAX_MATCH_RESULTS
  const text = renderAiTextReport('source_search', 'query_text', query, blocks, [
    { key: 'case_sensitive', value: renderBoolean(caseSensitive) },
    { key: 'file_pattern', value: filePattern || '(none)' },
    { key: 'unique_file_count', value: parsed.uniqueFileCount },
    { key: 'total_matches_found', value: parsed.matches.length },
    { key: 'matches_returned', value: Math.min(parsed.matches.length, MAX_MATCH_RESULTS) },
    { key: 'match_limit', value: MAX_MATCH_RESULTS },
    { key: 'truncated', value: renderBoolean(overLimit) },
  ])

  return { content: [{ type: 'text' as const, text }] }
}

/** The JSON mode plus line numbers and no color; case and path filters are flags. */
function buildRipgrepArgs(query: string, caseSensitive: boolean, filePattern?: string): string[] {
  const args = ['--json', '--line-number', '--color', 'never', caseSensitive ? '-s' : '-i']
  if (filePattern) {
    args.push('-g', filePattern)
  }
  args.push('-e', query, '.')
  return args
}

function renderBoolean(value: boolean): string {
  return value ? 'true' : 'false'
}

function parseRipgrepJson(stdoutText: string): RipgrepParse {
  const matches: RipgrepMatch[] = []
  const uniqueFiles = new Set<string>()

  for (const rawLine of stdoutText.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue

    let event: any
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }

    if (event?.type !== 'match') continue

    const data = event.data ?? {}
    const filePath = data.path?.text
    if (typeof filePath !== 'string' || filePath.length === 0) continue

    const normalizedPath = stripLeadingDotSlash(filePath)

    uniqueFiles.add(normalizedPath)
    matches.push({
      filePath: normalizedPath,
      lineNumber: typeof data.line_number === 'number' ? data.line_number : null,
      lineText: typeof data.lines?.text === 'string' ? data.lines.text.trimEnd() : '',
      submatchCount: Array.isArray(data.submatches) ? data.submatches.length : 0,
    })
  }

  // ── ★ SORT HERE, so the result is DETERMINED rather than merely whatever ripgrep emitted ──
  //
  // Measured before adding this: ripgrep's match SET is identical on every run, and only the
  // EMISSION ORDER varies (it reports in worker-completion order, and --sort is not passed). So
  // there was never a defined order to preserve — every run of the original already differed.
  //
  // That is why sorting is not a divergence from anything: it replaces undefined behaviour with
  // defined behaviour, and it is what makes the truncation below meaningful. The alternative,
  // relying on ripgrep's own --sort, would serialise the search and cost throughput for no
  // benefit, since the same total order is available here for free.
  //
  // The key is (filePath, lineNumber, lineText). Path first because a reader scanning a result
  // wants each file's hits together; line number next so a file reads top to bottom; lineText as
  // the final term only so the order is TOTAL — two events that agree on all three are identical
  // data, so their relative order cannot matter.
  //
  // The path comparison is a plain code-unit comparison, not localeCompare: the choice here must
  // not depend on the host's locale (see the localization port for the measured case where
  // localeCompare differs by locale).
  matches.sort(compareRipgrepMatches)

  return {
    matches,
    uniqueFileCount: uniqueFiles.size,
  }
}

/** `./x` and `.\\x` both denote a path inside the sandbox, so the marker drops. */
function stripLeadingDotSlash(filePath: string): string {
  return filePath.replace(/^[.][\\/]/, '').replaceAll('\\', '/')
}

/**
 * Total order over matches. A null line number sorts after every real one
 * (MAX_SAFE_INTEGER stands in for "unknown"), and the line text is the final
 * tiebreaker purely so two events that agree on path and line still compare.
 */
function compareRipgrepMatches(left: RipgrepMatch, right: RipgrepMatch): number {
  if (left.filePath !== right.filePath) {
    return left.filePath < right.filePath ? -1 : 1
  }

  const leftLine = left.lineNumber ?? Number.MAX_SAFE_INTEGER
  const rightLine = right.lineNumber ?? Number.MAX_SAFE_INTEGER
  if (leftLine !== rightLine) {
    return leftLine - rightLine
  }

  if (left.lineText !== right.lineText) {
    return left.lineText < right.lineText ? -1 : 1
  }

  return 0
}
