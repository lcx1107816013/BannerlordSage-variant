package tools

import (
	"context"
	"database/sql"
	"regexp"
	"sort"
	"strings"

	"blore/internal/apidocs"
	"blore/internal/report"
	"blore/internal/sandbox"
)

// ─────────────────────────────────────────────────────────────────────────────
// search_bannerlord_knowledge — src/tools/search-knowledge.ts
//
// The natural-language entry point: it routes the query by intent, fans out to the
// three search surfaces (docs / api docs / decompiled source) and renders every
// sub-result into one report. Each sub-search is wrapped in safeSearch, so ONE branch
// failing degrades into an error BLOCK rather than failing the whole tool.
//
// ★ PINNED BECAUSE IT LOOKS LIKE SLOPPINESS IN THE ORIGINAL, AND IS NOT:
//   - resolveIntent's FINAL fallback is 'make_mod'. Every query — an API-looking one
//     aside — routes to make_mod, which searches docs AND api AND source. There is no
//     'docs-only' or 'source-only' path reachable from intent 'auto'.
//   - shouldSearchSource includes 'api': an api-routed query ALSO searches decompiled
//     source, because the TS treats the decompiled tree as the authority when the API
//     version mismatches.
//   - extractLikelySymbol BLACKLISTS 'Bannerlord','MCP','API','XML','UI' — but is
//     case-SENSITIVE about it: 'bannerlord' is a perfectly good candidate symbol and
//     survives the filter.
//   - trimNestedReport truncates at 80 lines and appends the fixed sentence
//     '... truncated nested report ...' — the sub-reports' own truncation still shows
//     inside those 80 lines, so a truncated nested report can itself be truncated.
// ─────────────────────────────────────────────────────────────────────────────

// KnowledgeIntent mirrors KnowledgeIntent: 'auto' resolves at runtime; the rest are
// the resolved values.
type KnowledgeIntent = string

const (
	IntentAuto     KnowledgeIntent = "auto"
	IntentMakeMod  KnowledgeIntent = "make_mod"
	IntentAPI      KnowledgeIntent = "api"
	IntentDocs     KnowledgeIntent = "docs"
	IntentSource   KnowledgeIntent = "source"
)

// SearchKnowledge mirrors searchKnowledge(sandbox, query, intent, limit).
//
// db is the game index (searchDocs and searchApiDocs both query it); state carries the
// installed-version fields SearchAPIDocs renders; box is the assets sandbox the source
// search runs in. The TS closes over getDb()/getGamePaths()/loadSetupState — those are
// the caller's job here, exactly as in the registry wiring.
func SearchKnowledge(ctx context.Context, db *sql.DB, state apidocs.GameState, box *sandbox.Sandbox, query, intent string, limit int) (string, error) {
	normalizedQuery := report.TrimJS(query)
	resolvedIntent := resolveKnowledgeIntent(normalizedQuery, intent)

	officialDocsQuery := buildOfficialDocsQuery(normalizedQuery, resolvedIntent)
	communityDocsQuery := buildCommunityDocsQuery(normalizedQuery, resolvedIntent)
	apiQuery := buildKnowledgeAPIQuery(normalizedQuery, resolvedIntent)
	sourceQuery := buildKnowledgeSourceQuery(normalizedQuery, resolvedIntent)

	clamped := clampKnowledgeLimit(limit)

	var ownKnowledge, officialDocs, communityDocs, apiDocs, sourceMatches *knowledgeSubResult

	if shouldSearchDocs(resolvedIntent) {
		ownKnowledge = safeSearch("own_knowledge", func() (string, error) {
			return SearchDocs(db, normalizedQuery, "own", clamped)
		})
		officialDocs = safeSearch("official_docs", func() (string, error) {
			return SearchDocs(db, officialDocsQuery, "official", clamped)
		})
		communityDocs = safeSearch("community_docs", func() (string, error) {
			return SearchDocs(db, communityDocsQuery, "community", clamped)
		})
	}
	if shouldSearchAPI(resolvedIntent) {
		apiDocs = safeSearch("official_api_docs", func() (string, error) {
			return SearchAPIDocs(db, state, apiQuery, "", "", clamped)
		})
	}
	if shouldSearchSource(resolvedIntent) {
		sourceMatches = safeSearch("local_decompiled_source", func() (string, error) {
			return SearchSource(ctx, box.BasePath(), sourceQuery, false, "*.cs")
		})
	}

	blocks := make([]report.Block, 0, 5)
	for _, r := range []*knowledgeSubResult{ownKnowledge, officialDocs, communityDocs, apiDocs, sourceMatches} {
		if b := buildKnowledgeResultBlock(r); b != nil {
			blocks = append(blocks, *b)
		}
	}

	// ★ THE SCOPE VALUES ARE BARE WORDS, NOT THE '(skipped)' PLACEHOLDER. The TS
	// passes 'skipped' and the scope sentences as plain strings; only the QUERY fields
	// use the parenthesized fallback. report.Format renders absent as 'unknown' and
	// the parenthesized form here is a literal string, so both spellings are Text.
	docsScope := "skipped"
	apiScope := "skipped"
	sourceScope := "skipped"
	if shouldSearchDocs(resolvedIntent) {
		docsScope = "own_knowledge_first_then_official_community"
	}
	if shouldSearchAPI(resolvedIntent) {
		apiScope = "official_api_symbols_reference_only_if_version_mismatch"
	}
	if shouldSearchSource(resolvedIntent) {
		sourceScope = "local_decompiled_source_authority"
	}

	topFields := []report.Field{
		{Key: "resolved_intent", Value: report.Text(resolvedIntent)},
	}
	if shouldSearchDocs(resolvedIntent) {
		topFields = append(topFields,
			report.Field{Key: "official_docs_query", Value: report.Text(officialDocsQuery)},
			report.Field{Key: "community_docs_query", Value: report.Text(communityDocsQuery)},
		)
	} else {
		topFields = append(topFields,
			report.Field{Key: "official_docs_query", Value: report.Text("(skipped)")},
			report.Field{Key: "community_docs_query", Value: report.Text("(skipped)")},
		)
	}
	if shouldSearchAPI(resolvedIntent) {
		topFields = append(topFields, report.Field{Key: "api_query", Value: report.Text(apiQuery)})
	} else {
		topFields = append(topFields, report.Field{Key: "api_query", Value: report.Text("(skipped)")})
	}
	if shouldSearchSource(resolvedIntent) {
		topFields = append(topFields, report.Field{Key: "source_query", Value: report.Text(sourceQuery)})
	} else {
		topFields = append(topFields, report.Field{Key: "source_query", Value: report.Text("(skipped)")})
	}
	topFields = append(topFields,
		report.Field{Key: "docs_scope", Value: report.Text(docsScope)},
		report.Field{Key: "api_scope", Value: report.Text(apiScope)},
		report.Field{Key: "source_scope", Value: report.Text(sourceScope)},
		report.Field{Key: "usage_rule", Value: report.Text(
			"For Bannerlord mod implementation decisions, prefer local decompiled source when official API version does not exactly match the installed game.")},
	)

	return report.Render("bannerlord_knowledge_search", "request_text", normalizedQuery, blocks, topFields), nil
}

// knowledgeSubResult mirrors safeSearch's return: {label, ok, text}.
type knowledgeSubResult struct {
	Label string
	OK    bool
	Text  string
}

// safeSearch mirrors safeSearch: the error MESSAGE becomes the text of an !ok result,
// so a failing branch renders as an error block instead of rejecting the whole tool.
func safeSearch(label string, search func() (string, error)) *knowledgeSubResult {
	text, err := search()
	if err != nil {
		return &knowledgeSubResult{Label: label, OK: false, Text: err.Error()}
	}
	return &knowledgeSubResult{Label: label, OK: true, Text: report.TrimJS(text)}
}

// buildKnowledgeResultBlock mirrors buildResultBlock: the key is 'results' when ok and
// 'error' when not, and the text goes through trimNestedReport (80 lines + the fixed
// truncation sentence).
func buildKnowledgeResultBlock(r *knowledgeSubResult) *report.Block {
	if r == nil {
		return nil
	}
	key := "error"
	if r.OK {
		key = "results"
	}
	return &report.Block{
		Header: r.Label,
		Fields: []report.Field{
			{Key: "search_ok", Value: report.Bool(r.OK)},
			{Key: "source", Value: report.Text(r.Label)},
		},
		MultilineFields: []report.Field{
			{Key: key, Value: report.Text(trimNestedReport(r.Text))},
		},
	}
}

// trimNestedReport mirrors trimNestedReport: trim, split on /\r?\n/, keep 80 lines, and
// append the fixed sentence when there were more.
func trimNestedReport(text string) string {
	trimmed := report.TrimJS(text)
	lines := splitCRLFOrLF(trimmed)
	const maxLines = 80
	if len(lines) <= maxLines {
		return strings.Join(lines, "\n")
	}
	return strings.Join(lines[:maxLines], "\n") + "\n... truncated nested report ..."
}

func splitCRLFOrLF(s string) []string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.Split(s, "\n")
}

// ── intent routing ───────────────────────────────────────────────────────────

var (
	// resolveIntent regex 1: a call-shape `[a-z_][a-z0-9_.]*\s*\(` OR a keyword. Both are
	// case-INSENSITIVE in the TS.
	knCallShape   = regexp.MustCompile(`(?i)[a-z_][a-z0-9_.]*\s*\(`)
	knAPIKeywords = regexp.MustCompile(`(?i)\b(api|class|method|property|event|enum|interface)\b`)
	// regex 2 runs against the LOWERCASED query.
	knMakeModWords = regexp.MustCompile(`\b(harmony|patch|mod|module|submodule|gauntlet|ui|xml|asset|editor|campaignbehavior|behavior)\b`)
	// regex 3 runs against the RAW query (Chinese terms are case-moot anyway).
	knChineseMakeMod = regexp.MustCompile(`制作|开发|创建|做一个|做个|模组|mod|补丁|功能|界面|资源|编辑器|战役|行为`)
)

// resolveKnowledgeIntent mirrors resolveIntent. Order is the contract: call-shape/api
// keyword first, then english make_mod words against the LOWERED query, then the
// chinese pattern against the raw one, then the unconditional make_mod fallback.
func resolveKnowledgeIntent(query, intent string) string {
	if intent != IntentAuto {
		return intent
	}

	lowered := strings.ToLower(query)
	if knCallShape.MatchString(query) || knAPIKeywords.MatchString(query) {
		return IntentAPI
	}
	if knMakeModWords.MatchString(lowered) {
		return IntentMakeMod
	}
	if knChineseMakeMod.MatchString(query) {
		return IntentMakeMod
	}
	return IntentMakeMod
}

func shouldSearchDocs(intent string) bool {
	return intent == IntentMakeMod || intent == IntentDocs
}

func shouldSearchAPI(intent string) bool {
	return intent == IntentMakeMod || intent == IntentAPI
}

func shouldSearchSource(intent string) bool {
	return intent == IntentMakeMod || intent == IntentSource || intent == IntentAPI
}

// ── query builders ───────────────────────────────────────────────────────────

var (
	knGauntletUI  = regexp.MustCompile(`(?i)gauntlet|ui|界面|菜单|窗口|按钮`)
	knAssets      = regexp.MustCompile(`(?i)asset|资源|模型|材质|覆盖|替换`)
	knXmlData     = regexp.MustCompile(`(?i)xml|数据|兵种|物品|文化|王国`)
	knQuickStart  = regexp.MustCompile(`(?i)submodule|模块|模组|mod|制作|创建|开发|quick`)
	knHarmony     = regexp.MustCompile(`(?i)harmony|patch|补丁|修改方法`)
	knXmlRead     = regexp.MustCompile(`(?i)xml|数据|读取|注册`)
	knParty       = regexp.MustCompile(`(?i)party|队伍|部队|俘虏|招募|士兵`)
	knHero        = regexp.MustCompile(`(?i)hero|领主|英雄|家族|clan`)
)

// buildOfficialDocsQuery mirrors buildOfficialDocsQuery.
func buildOfficialDocsQuery(query, intent string) string {
	if intent == IntentDocs || intent == IntentMakeMod {
		switch {
		case knGauntletUI.MatchString(query):
			return "Gauntlet UI"
		case knAssets.MatchString(query):
			return "资产"
		case knXmlData.MatchString(query):
			return "XML"
		case knQuickStart.MatchString(query):
			return "快速入门"
		}
	}
	return query
}

// buildCommunityDocsQuery mirrors buildCommunityDocsQuery.
func buildCommunityDocsQuery(query, intent string) string {
	if intent == IntentDocs || intent == IntentMakeMod {
		switch {
		case knGauntletUI.MatchString(query):
			return "Gauntlet UI"
		case knXmlData.MatchString(query):
			return "SubModule XML"
		case knHarmony.MatchString(query):
			return "Harmony"
		case knAssets.MatchString(query):
			return "asset"
		case knQuickStart.MatchString(query):
			return "SubModule"
		}
	}
	return query
}

// buildKnowledgeAPIQuery mirrors buildApiQuery.
func buildKnowledgeAPIQuery(query, intent string) string {
	if symbol := extractLikelySymbol(query); symbol != "" {
		return symbol
	}

	if intent == IntentMakeMod || intent == IntentAPI {
		switch {
		case knGauntletUI.MatchString(query):
			return "Gauntlet"
		case knXmlRead.MatchString(query):
			return "MBObjectManager"
		case knParty.MatchString(query):
			return "MobileParty"
		case knHero.MatchString(query):
			return "Hero"
		}
		return "CampaignBehavior"
	}
	return query
}

// buildKnowledgeSourceQuery mirrors buildSourceQuery.
func buildKnowledgeSourceQuery(query, intent string) string {
	if symbol := extractLikelySymbol(query); symbol != "" {
		return symbol
	}

	if intent == IntentMakeMod || intent == IntentSource || intent == IntentAPI {
		switch {
		case knGauntletUI.MatchString(query):
			return "Gauntlet"
		case knXmlRead.MatchString(query):
			return "MBObjectManager"
		case knParty.MatchString(query):
			return "MobileParty"
		case knHero.MatchString(query):
			return "Hero"
		}
		return "CampaignBehavior"
	}

	// The english-word extraction: /[A-Za-z][A-Za-z0-9_.]{2,}/g, first match.
	if m := knEnglishWord.FindString(query); m != "" {
		return m
	}
	return query
}

var (
	knLikelySymbol = regexp.MustCompile(`\b[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*\b`)
	knEnglishWord  = regexp.MustCompile(`[A-Za-z][A-Za-z0-9_.]{2,}`)
)

// extractLikelySymbol mirrors extractLikelySymbol: all PascalCase-or-dotted candidates,
// minus the exact blacklist (CASE-SENSITIVE: 'bannerlord' survives), LONGEST first.
//
// ★ JS sort is STABLE and the comparator only compares lengths, so candidates of EQUAL
// length keep their match order; sort.SliceStable reproduces that.
//
// ★ MUTATION RECORD (per the parity README's four exits): swapping SliceStable for
// sort.Slice is EQUIVALENT-BY-ENUMERATION for the parity corpus but NOT in general.
// Measured on this Go toolchain: with n ≤ 12 elements Go's sort falls back to insertion
// sort, which never swaps when the comparator is false — so an all-tie or small-mixed
// array cannot observe the difference (a 15-symbol corpus with one longer element DID
// reorder: [LongerItem f6 h8 c3 d4 e5 a1 g7 b2 ...] vs the stable order). The corpus
// queries carry at most ~6 symbols, so the differential cannot catch this mutation;
// SliceStable stays because the TS sort IS stable, and this note is the evidence trail.
func extractLikelySymbol(query string) string {
	matches := knLikelySymbol.FindAllString(query, -1)
	if matches == nil {
		return ""
	}

	blacklist := map[string]bool{"Bannerlord": true, "MCP": true, "API": true, "XML": true, "UI": true}
	candidates := make([]string, 0, len(matches))
	for _, m := range matches {
		if !blacklist[m] {
			candidates = append(candidates, m)
		}
	}
	if len(candidates) == 0 {
		return ""
	}

	sort.SliceStable(candidates, func(i, j int) bool {
		return len(candidates[j]) < len(candidates[i])
	})
	return candidates[0]
}

// clampKnowledgeLimit mirrors clampLimit: the floor is 1, the ceiling 10, and an
// unusable value takes the default 5. Go ints cannot be NaN, so the unusable branch is
// the constant the caller passes — see ClampDocsLimit for the measured shape.
func clampKnowledgeLimit(limit int) int {
	if limit < 1 {
		return 1
	}
	if limit > 10 {
		return 10
	}
	return limit
}
