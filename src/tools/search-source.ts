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

export async function searchSource(
  sandbox: PathSandbox,
  query: string,
  caseSensitive: boolean = false,
  filePattern?: string
) {
  const args = ['--json', '--line-number', '--color', 'never']
  if (caseSensitive) args.push('-s')
  else args.push('-i')

  if (filePattern) args.push('-g', filePattern)
  args.push('-e', query, '.')

  const proc = Bun.spawn(['rg', ...args], {
    cwd: sandbox.basePath,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  if (exitCode !== 0 && exitCode !== 1) {
    throw new Error(`ripgrep failed while searching source: ${stderrText.trim() || `exit code ${exitCode}`}`)
  }

  const parsed = parseRipgrepJson(stdoutText)
  const blocks: AiTextBlock[] = parsed.matches.slice(0, MAX_MATCH_RESULTS).map((match, index) => ({
    header: `match_${index + 1}`,
    fields: [
      { key: 'file_path', value: match.filePath },
      { key: 'line_number_1based', value: match.lineNumber },
      { key: 'submatch_count', value: match.submatchCount },
    ],
    multilineFields: [{ key: 'line_text', value: match.lineText }],
  }))

  const text = renderAiTextReport('source_search', 'query_text', query, blocks, [
    { key: 'case_sensitive', value: caseSensitive ? 'true' : 'false' },
    { key: 'file_pattern', value: filePattern || '(none)' },
    { key: 'unique_file_count', value: parsed.uniqueFileCount },
    { key: 'total_matches_found', value: parsed.matches.length },
    { key: 'matches_returned', value: Math.min(parsed.matches.length, MAX_MATCH_RESULTS) },
    { key: 'match_limit', value: MAX_MATCH_RESULTS },
    { key: 'truncated', value: parsed.matches.length > MAX_MATCH_RESULTS ? 'true' : 'false' },
  ])

  return { content: [{ type: 'text' as const, text }] }
}

function parseRipgrepJson(stdoutText: string): { matches: RipgrepMatch[]; uniqueFileCount: number } {
  const matches: RipgrepMatch[] = []
  const uniqueFiles = new Set<string>()

  for (const line of stdoutText.split(/\r?\n/)) {
    const trimmed = line.trim()
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

    const normalizedPath = filePath.replace(/^[.][\\/]/, '').replaceAll('\\', '/')

    uniqueFiles.add(normalizedPath)
    matches.push({
      filePath: normalizedPath,
      lineNumber: typeof data.line_number === 'number' ? data.line_number : null,
      lineText: typeof data.lines?.text === 'string' ? data.lines.text.trimEnd() : '',
      submatchCount: Array.isArray(data.submatches) ? data.submatches.length : 0,
    })
  }

  return {
    matches,
    uniqueFileCount: uniqueFiles.size,
  }
}
