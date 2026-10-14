package report

import "testing"

func TestRenderMatchesTsLayout(t *testing.T) {
	blocks := []Block{
		{
			Header: "match_1",
			Fields: []Field{
				{Key: "module_name", Value: "Native"},
				{Key: "file_path", Value: "Modules/Native/a.xml"},
			},
			MultilineFields: []Field{{Key: "snippet", Value: "line1\r\nline2"}},
		},
		{
			Header:          "match_2",
			Fields:          []Field{{Key: "file_path", Value: ""}},
			ListFields:      []ListField{{Key: "tags", Values: []string{}}},
			MultilineFields: []Field{{Key: "text", Value: "   "}},
		},
	}
	got := Render("xml_search", "query_text", "gauntlet ui", blocks, []Field{
		{Key: "fts_query", Value: `"gauntlet"* AND "ui"*`},
	})

	want := `report_type: xml_search
query_text: gauntlet ui
result_count: 2
fts_query: "gauntlet"* AND "ui"*

[result_1]
result_label: match_1
module_name: Native
file_path: Modules/Native/a.xml
snippet:
  line1
  line2

[result_2]
result_label: match_2
file_path: unknown
tags:
- none
text:
  unknown`

	if got != want {
		t.Fatalf("render mismatch:\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

func TestRenderEmptyBlocks(t *testing.T) {
	got := Render("xml_search", "query_text", "q", nil, []Field{{Key: "fts_query", Value: `""`}})
	want := "report_type: xml_search\nquery_text: q\nresult_count: 0\nfts_query: \"\"\n"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}
