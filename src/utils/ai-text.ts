/**
 * The structured plain-text reporting format used across MCP tool output.
 * Tools emit header lines plus per-result blocks; `result_count` mirrors
 * the number of blocks so consumers can spot truncation.
 */
export type AiScalar = string | number | boolean | null | undefined

export type AiTextField = {
  key: string
  value: AiScalar
}

export type AiTextListField = {
  key: string
  values: AiScalar[]
}

export type AiTextMultilineField = {
  key: string
  value: string | null | undefined
}

export type AiTextBlock = {
  header?: string
  fields?: AiTextField[]
  listFields?: AiTextListField[]
  multilineFields?: AiTextMultilineField[]
}

export function renderAiTextReport(
  reportType: string,
  queryKey: string,
  queryValue: string,
  blocks: AiTextBlock[],
  topFields: AiTextField[] = []
): string {
  const lines = [
    `report_type: ${reportType}`,
    `${queryKey}: ${queryValue}`,
    `result_count: ${blocks.length}`,
  ]

  // The three emitters below are the only places a block writes a line, so the
  // layout rules (blank-list placeholder, per-line indent, omission of an empty
  // header) each live in exactly one spot.
  const emitScalarField = (key: string, value: AiScalar): void => {
    lines.push(`${key}: ${formatAiScalar(value)}`)
  }

  const emitListField = (listField: AiTextListField): void => {
    lines.push(`${listField.key}:`)
    if (listField.values.length === 0) {
      lines.push('- none')
      return
    }

    for (const item of listField.values) {
      lines.push(`- ${formatAiScalar(item)}`)
    }
  }

  const emitMultilineField = (field: AiTextMultilineField): void => {
    lines.push(`${field.key}:`)
    const body = field.value?.trim()
    if (!body) {
      lines.push('  unknown')
      return
    }

    for (const line of body.split(/\r?\n/)) {
      lines.push(`  ${line}`)
    }
  }

  for (const field of topFields) {
    emitScalarField(field.key, field.value)
  }

  lines.push('')

  blocks.forEach((block, index) => {
    lines.push(`[result_${index + 1}]`)
    if (block.header) {
      lines.push(`result_label: ${block.header}`)
    }

    for (const field of block.fields ?? []) {
      emitScalarField(field.key, field.value)
    }

    for (const listField of block.listFields ?? []) {
      emitListField(listField)
    }

    for (const field of block.multilineFields ?? []) {
      emitMultilineField(field)
    }

    const lastBlockIndex = blocks.length - 1
    if (index !== lastBlockIndex) {
      lines.push('')
    }
  })

  return lines.join('\n')
}

/** Renders a scalar for output: booleans verbatim, blanks/nulls to fallback. */
export function formatAiScalar(value: AiScalar, fallback = 'unknown'): string {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'boolean') return value ? 'true' : 'false'

  const rendered = String(value).trim()
  const isEmpty = rendered.length === 0
  return isEmpty ? fallback : rendered
}
