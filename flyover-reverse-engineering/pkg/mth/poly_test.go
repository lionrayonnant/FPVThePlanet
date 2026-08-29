package mth

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"testing"
)

// polyCase is one case from ../../testdata/poly-cases.json, generated from the
// JS port of the same geometry (sim/tools/gen-poly-fixture.mjs). This test
// conforms the Go side to that port: both name the cache directory, and a
// divergence would cost a full re-download, silently.
type polyCase struct {
	Name   string    `json:"name"`
	Ring   []float64 `json:"ring"`
	Zoom   int       `json:"zoom"`
	Bounds struct {
		South float64 `json:"south"`
		West  float64 `json:"west"`
		North float64 `json:"north"`
		East  float64 `json:"east"`
	} `json:"bounds"`
	Grid struct {
		XMin int `json:"xMin"`
		XMax int `json:"xMax"`
		YMin int `json:"yMin"`
		YMax int `json:"yMax"`
	} `json:"grid"`
	Columns   int      `json:"columns"`
	Masked    int      `json:"masked"`
	Keys      []string `json:"keys"`
	Canonical string   `json:"canonical"`
	Hash      string   `json:"hash"`
}

func loadCases(t *testing.T) []polyCase {
	t.Helper()
	b, err := os.ReadFile("../../testdata/poly-cases.json")
	if err != nil {
		t.Fatalf("fixture unreadable: %v", err)
	}
	var cases []polyCase
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatalf("fixture invalid: %v", err)
	}
	if len(cases) == 0 {
		t.Fatal("fixture is empty")
	}
	return cases
}

func TestRingBounds(t *testing.T) {
	for _, c := range loadCases(t) {
		s, w, n, e := Ring(c.Ring).Bounds()
		if s != c.Bounds.South || w != c.Bounds.West || n != c.Bounds.North || e != c.Bounds.East {
			t.Errorf("%s: bounds = %v,%v,%v,%v, want %v,%v,%v,%v",
				c.Name, s, w, n, e, c.Bounds.South, c.Bounds.West, c.Bounds.North, c.Bounds.East)
		}
	}
}

func TestRingTileMask(t *testing.T) {
	for _, c := range loadCases(t) {
		r := Ring(c.Ring)
		keys := []string{}
		for y := c.Grid.YMin; y <= c.Grid.YMax; y++ {
			for x := c.Grid.XMin; x <= c.Grid.XMax; x++ {
				if r.TileKept(c.Zoom, x, y) {
					keys = append(keys, fmt.Sprintf("%d/%d", x, y))
				}
			}
		}
		sort.Strings(keys)
		if len(keys) != c.Columns {
			t.Errorf("%s: %d columns, want %d", c.Name, len(keys), c.Columns)
			continue
		}
		want := append([]string(nil), c.Keys...)
		sort.Strings(want)
		for i := range keys {
			if keys[i] != want[i] {
				t.Errorf("%s: tile %d = %s, want %s", c.Name, i, keys[i], want[i])
				break
			}
		}
	}
}

func TestRingCanonicalAndHash(t *testing.T) {
	for _, c := range loadCases(t) {
		r := Ring(c.Ring)
		if got := r.Canonical(); got != c.Canonical {
			t.Errorf("%s: canonical = %q, want %q", c.Name, got, c.Canonical)
		}
		// The hash names the cache directory: a divergence here costs a full
		// re-download, and nothing would say so.
		if got := r.Hash(); got != c.Hash {
			t.Errorf("%s: hash = %q, want %q", c.Name, got, c.Hash)
		}
	}
}

func TestRingContainsPoint(t *testing.T) {
	// An L whose bounding-box centre falls in the notch.
	l := Ring{0, 0, 0, 10, 4, 10, 4, 4, 10, 4, 10, 0}
	for _, tc := range []struct {
		lat, lon float64
		want     bool
	}{
		{2, 2, true}, {8, 2, true}, {5, 5, false}, {-1, 5, false}, {2, 12, false},
	} {
		if got := l.ContainsPoint(tc.lat, tc.lon); got != tc.want {
			t.Errorf("ContainsPoint(%v, %v) = %v, want %v", tc.lat, tc.lon, got, tc.want)
		}
	}
}

func TestRingIntersectsBox(t *testing.T) {
	for _, tc := range []struct {
		name string
		ring Ring
		want bool
	}{
		{"tile inside the ring", Ring{-5, -5, -5, 5, 5, 5, 5, -5}, true},
		{"ring inside the tile", Ring{.2, .2, .2, .8, .8, .8, .8, .2}, true},
		{"crossing", Ring{.4, -5, .6, -5, .6, 5, .4, 5}, true},
		{"one corner", Ring{.9, .9, .9, 5, 5, 5, 5, .9}, true},
		{"beside", Ring{2, 2, 2, 3, 3, 3, 3, 2}, false},
	} {
		if got := tc.ring.IntersectsBox(0, 0, 1, 1); got != tc.want {
			t.Errorf("%s: IntersectsBox = %v, want %v", tc.name, got, tc.want)
		}
	}
}
