// Resolves a Bannerlord localization token ({=ID}Fallback Text) against the
// XML language index and the C# source index: every language the token
// appears in, plus up to ten source-side usages.
import { renderAiTextReport } from '../utils/ai-text'
import { parseLocalizationToken, resolveLocalizationDetails } from '../utils/localization'

/** Source-side usages rendered before the rest collapses to a count. */
const SOURCE_ENTRY_DISPLAY_LIMIT = 10

export async function resolveLocalization(text: string, languages?: string[]) {
  const token = parseLocalizationToken(text)
  if (!token) {
    return singleText(
      'Input text is not a Bannerlord localization token. Expected format: {=str_id}Fallback Text'
    )
  }

  const details = resolveLocalizationDetails(text, languages)
  const fields = [
    { key: 'localization_id', value: token.id },
    { key: 'query_text', value: text },
    { key: 'token_fallback', value: token.fallback || '(empty)' },
    { key: 'preferred_languages', value: languages?.join(', ') || 'default' },
    { key: 'xml_entry_count', value: details.xmlEntries.length },
    { key: 'source_entry_count', value: details.sourceEntries.length },
  ]

  // Bounded output: past ten source hits only the overflow count is noted.
  const omittedSourceEntries = details.sourceEntries.length - SOURCE_ENTRY_DISPLAY_LIMIT
  if (omittedSourceEntries > 0) {
    fields.push({ key: 'source_entries_omitted', value: omittedSourceEntries })
  }

  const blocks = [
    {
      header: 'localization_summary',
      fields,
      listFields: [
        { key: 'xml_entries', values: details.xmlEntries.map(renderXmlEntry) },
        {
          key: 'source_entries',
          values: details.sourceEntries.slice(0, SOURCE_ENTRY_DISPLAY_LIMIT).map(renderSourceEntry),
        },
      ],
    },
  ]

  return singleText(renderAiTextReport('localization_resolution', 'query_localization_token', text, blocks))
}

/** Wraps a rendered report (or a flat message) in the reply shape. */
function singleText(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

/** One language row; a row with no file path reads as "unknown". */
function renderXmlEntry(row: { language: string; text: string; filePath: string | null }): string {
  return `language=${row.language} | text=${row.text} | file_path=${row.filePath || 'unknown'}`
}

/**
 * One source usage. The stored line and column are 0-based and are rendered
 * 1-based, which is why each is incremented at the point of display.
 */
function renderSourceEntry(row: {
  fallbackText: string
  contextKind: string
  assemblyName: string
  filePath: string
  lineNumber: number
  columnNumber: number
}): string {
  const line1Based = row.lineNumber + 1
  const column1Based = row.columnNumber + 1
  return `fallback_text=${row.fallbackText} | context_kind=${row.contextKind} | assembly=${row.assemblyName} | file_path=${row.filePath}:${line1Based}:${column1Based}`
}
