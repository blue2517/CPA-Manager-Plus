package monitoring

import (
	"context"
	"math"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

func TestAntigravityGeminiScopeMembership(t *testing.T) {
	tests := []struct {
		name, model, billing string
		argon, ordinary      bool
		unknown              bool
	}{
		{name: "ordinary", model: "gemini-3-pro", ordinary: true},
		{name: "argon", model: "gemini-4-argon", argon: true},
		{name: "provider and reasoning suffix", model: " GOOGLE/GEMINI-4-ARGON(high) ", argon: true},
		{name: "underscore variant", model: "gemini_4_argon_preview", argon: true},
		{name: "bare argon identifier", model: "argon", argon: true},
		{name: "argon substring", model: "gemini-argonpreview", argon: true},
		{name: "ordinary alias billed as argon", model: "gemini-3-pro", billing: "gemini-4-argon", argon: true},
		{name: "argon alias billed as ordinary", model: "gemini-4-argon", billing: "gemini-3-pro", ordinary: true},
		{name: "unknown billed model does not fall back", model: "gemini-4-argon", billing: "router-unknown", unknown: true},
		{name: "unresolved alias", model: "router-unknown", unknown: true},
		{name: "external", model: "claude-sonnet"},
		{name: "empty", unknown: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			row := store.AccountWindowModelStat{Model: test.model, BillingModel: test.billing}
			for key, want := range map[string]bool{
				"gemini": test.argon || test.ordinary, "gemini_argon": test.argon, "gemini_non_argon": test.ordinary,
			} {
				matched, unknown := accountWindowStatMatchesScope(row, AccountWindowModelScope{Kind: "family", Key: key, Complete: true})
				if matched != want || unknown != test.unknown {
					t.Errorf("%s: matched=%v unknown=%v, want %v %v", key, matched, unknown, want, test.unknown)
				}
			}
		})
	}
	// A broad explicit model list must not undo a split account's pool boundary.
	for key, model := range map[string]string{"gemini_argon": "gemini-3-pro", "gemini_non_argon": "gemini-4-argon"} {
		matched, _ := accountWindowStatMatchesScope(store.AccountWindowModelStat{Model: model}, AccountWindowModelScope{
			Kind: "family", Key: key, Complete: true, Models: []string{"gemini-3-pro", "gemini-4-argon"},
		})
		if matched {
			t.Fatalf("%s admitted %s from an overlapping model list", key, model)
		}
	}
}

func TestAntigravityWindowUsageSeparatesArgonCostsAndTokens(t *testing.T) {
	db := newMonitoringTestStore(t)
	ctx := context.Background()
	const nowMS int64 = 1_800_000_000_000
	const hourMS int64 = 60 * 60 * 1000
	if err := db.SaveModelPrices(ctx, map[string]store.ModelPrice{
		"gemini-3-pro": {Prompt: 1}, "gemini-4-argon": {Prompt: 1},
	}); err != nil {
		t.Fatal(err)
	}
	events := []usage.Event{
		monitoringEvent("ordinary-old", nowMS-6*hourMS, "gemini-3-pro", "auth-1", "source-a", false, 6_000_000, 0, 0, 0, 6_000_000, nil),
		monitoringEvent("ordinary-recent", nowMS-hourMS, "gemini-4-argon", "auth-1", "source-a", false, 4_000_000, 0, 0, 0, 4_000_000, nil),
		monitoringEvent("argon-old", nowMS-6*hourMS, "gemini-4-argon", "auth-1", "source-a", false, 2_000_000, 0, 0, 0, 2_000_000, nil),
		monitoringEvent("argon-recent", nowMS-hourMS, "gemini-3-pro", "auth-1", "source-a", false, 1_000_000, 0, 0, 0, 1_000_000, nil),
	}
	events[1].ResolvedModel = "gemini-3-pro"
	events[3].ResolvedModel = "gemini-4-argon"
	for index := range events {
		events[index].AccountSnapshot = "quota@example.com"
		events[index].AuthFileSnapshot = "antigravity.json"
		events[index].AuthProviderSnapshot = "antigravity"
	}
	if _, err := db.InsertEvents(ctx, events); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		id, scope    string
		hours, calls int64
		cost         float64
	}{
		{"gemini-5h", "gemini_non_argon", 5, 1, 4},
		{"gemini-weekly", "gemini_non_argon", 168, 2, 10},
		{"argon-weekly", "gemini_argon", 168, 2, 3},
		{"shared-gemini-5h", "gemini", 5, 2, 5},
		{"shared-gemini-weekly", "gemini", 168, 4, 13},
	}
	windows := make([]AccountWindowUsageTarget, 0, len(tests))
	for _, test := range tests {
		windows = append(windows, AccountWindowUsageTarget{
			RequestKey: test.id, RowKey: "row-1", ProviderWindowID: test.id,
			Period: "current", FromMS: nowMS - test.hours*hourMS, ToMS: nowMS,
			ModelScope:      AccountWindowModelScope{Kind: "family", Key: test.scope, Complete: true},
			AccountSnapshot: "quota@example.com", AuthFileSnapshot: "antigravity.json",
			AuthProviderSnapshot: "antigravity", AuthIndex: "auth-1", Source: "antigravity.json",
		})
	}
	resp, err := New(db).AccountWindowUsage(ctx, AccountWindowUsageRequest{Windows: windows})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Items) != len(tests) {
		t.Fatalf("items: %#v", resp.Items)
	}
	for index, test := range tests {
		item := resp.Items[index]
		if item.RequestKey != test.id || item.TotalRequests != test.calls || item.TotalTokens != int64(test.cost*1_000_000) || math.Abs(item.TotalCost-test.cost) > 1e-9 || item.ScopeMatchStatus != "complete" {
			t.Errorf("%s: got %#v, want %d calls, $%v and %v tokens", test.id, item, test.calls, test.cost, test.cost*1_000_000)
		}
	}
}
