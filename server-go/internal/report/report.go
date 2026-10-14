// Package report is a faithful port of src/utils/ai-text.ts.
//
// All query tools return plain key/value text reports, not JSON. The exact
// layout matters because downstream agents parse it; do not "improve" it.
package report

import (
	"strings"
)

// Field is a scalar key/value pair. An empty (or whitespace-only) value
// renders as "unknown", matching the TS treatment of null/undefined/"".
type Field struct {
	Key   string
	Value string
}

// ListField renders as "key:" followed by "- item" lines; an empty list
// renders "- none".
type ListField struct {
	Key    string
	Values []string
}

// Block is one [result_N] section of the report.
type Block struct {
	Header          string
	Fields          []Field
	ListFields      []ListField
	MultilineFields []Field
}

// FormatAiScalar mirrors formatAiScalar(): null/undefined/blank -> "unknown".
// Booleans/numbers are formatted by the caller before reaching this function.
func FormatAiScalar(value string) string {
	text := strings.TrimSpace(value)
	if text == "" {
		return "unknown"
	}
	return text
}

// Render mirrors renderAiTextReport(reportType, queryKey, queryValue, blocks, topFields).
func Render(reportType, queryKey, queryValue string, blocks []Block, topFields []Field) string {
	lines := []string{
		"report_type: " + reportType,
		queryKey + ": " + queryValue,
		"result_count: " + itoa(len(blocks)),
	}

	for _, f := range topFields {
		lines = append(lines, f.Key+": "+FormatAiScalar(f.Value))
	}

	lines = append(lines, "")

	for i, block := range blocks {
		lines = append(lines, "[result_"+itoa(i+1)+"]")
		if block.Header != "" {
			lines = append(lines, "result_label: "+block.Header)
		}

		for _, f := range block.Fields {
			lines = append(lines, f.Key+": "+FormatAiScalar(f.Value))
		}

		for _, lf := range block.ListFields {
			lines = append(lines, lf.Key+":")
			if len(lf.Values) == 0 {
				lines = append(lines, "- none")
				continue
			}
			for _, item := range lf.Values {
				lines = append(lines, "- "+FormatAiScalar(item))
			}
		}

		for _, mf := range block.MultilineFields {
			lines = append(lines, mf.Key+":")
			value := strings.TrimSpace(mf.Value)
			if value == "" {
				lines = append(lines, "  unknown")
				continue
			}
			for _, line := range splitLines(value) {
				lines = append(lines, "  "+line)
			}
		}

		if i < len(blocks)-1 {
			lines = append(lines, "")
		}
	}

	return strings.Join(lines, "\n")
}

// splitLines mirrors the JS split(/\r?\n/).
func splitLines(s string) []string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.Split(s, "\n")
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
