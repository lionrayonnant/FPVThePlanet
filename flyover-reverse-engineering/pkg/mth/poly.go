package mth

import (
	"crypto/sha256"
	"encoding/hex"
	"math"
	"strconv"
	"strings"
)

// Ring is a lat/lon polygon as a flat [lat, lon, lat, lon, ...] slice, closed
// implicitly: the last vertex connects back to the first.
//
// This file is the twin of the polygon block at the end of
// sim/tools/lib/tiles.mjs. The two are held in agreement by
// testdata/poly-cases.json, checked from both sides (poly_test.go and
// sim/tools/map-poly-selftest.mjs): a drift would otherwise only surface as a
// diverging cache directory name, i.e. as several gigabytes downloaded twice.
type Ring []float64

// Bounds is the ring's lat/lon extent - the rectangle of tiles the scan sweeps
// before masking.
func (r Ring) Bounds() (south, west, north, east float64) {
	south, west = math.Inf(1), math.Inf(1)
	north, east = math.Inf(-1), math.Inf(-1)
	for i := 0; i < len(r); i += 2 {
		south, north = math.Min(south, r[i]), math.Max(north, r[i])
		west, east = math.Min(west, r[i+1]), math.Max(east, r[i+1])
	}
	return
}

// ContainsPoint is ray casting. A point exactly on an edge has no stable answer
// here, which is harmless: IntersectsBox also tests edge crossings, so a tile
// whose corner sits on the outline is kept by that test instead.
func (r Ring) ContainsPoint(lat, lon float64) bool {
	n := len(r) / 2
	inside := false
	for i, j := 0, n-1; i < n; j, i = i, i+1 {
		yi, xi := r[2*i], r[2*i+1]
		yj, xj := r[2*j], r[2*j+1]
		if (yi > lat) != (yj > lat) && lon < ((xj-xi)*(lat-yi))/(yj-yi)+xi {
			inside = !inside
		}
	}
	return inside
}

func cross(ax, ay, bx, by, cx, cy float64) float64 {
	return (bx-ax)*(cy-ay) - (by-ay)*(cx-ax)
}

func onSegment(ax, ay, bx, by, px, py float64) bool {
	return math.Min(ax, bx) <= px && px <= math.Max(ax, bx) &&
		math.Min(ay, by) <= py && py <= math.Max(ay, by)
}

// segmentsIntersect treats collinear touching as an intersection: two segments
// meeting end to end do touch, and that is what keeps a tile merely grazed by
// an edge rather than dropping it.
func segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy float64) bool {
	d1 := cross(cx, cy, dx, dy, ax, ay)
	d2 := cross(cx, cy, dx, dy, bx, by)
	d3 := cross(ax, ay, bx, by, cx, cy)
	d4 := cross(ax, ay, bx, by, dx, dy)
	if ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)) {
		return true
	}
	return (d1 == 0 && onSegment(cx, cy, dx, dy, ax, ay)) ||
		(d2 == 0 && onSegment(cx, cy, dx, dy, bx, by)) ||
		(d3 == 0 && onSegment(ax, ay, bx, by, cx, cy)) ||
		(d4 == 0 && onSegment(ax, ay, bx, by, dx, dy))
}

// IntersectsBox reports whether the ring touches the lat/lon rectangle at all.
// All three tests are needed: a ring vertex inside the box (ring contained in
// the tile), a box corner inside the ring (tile contained in the ring), or an
// edge crossing (the common case).
func (r Ring) IntersectsBox(south, west, north, east float64) bool {
	for i := 0; i < len(r); i += 2 {
		if r[i] >= south && r[i] <= north && r[i+1] >= west && r[i+1] <= east {
			return true
		}
	}
	if r.ContainsPoint(south, west) {
		return true
	}
	corners := [4][2]float64{{west, south}, {east, south}, {east, north}, {west, north}}
	n := len(r) / 2
	for i, j := 0, n-1; i < n; j, i = i, i+1 {
		ay, ax := r[2*j], r[2*j+1]
		by, bx := r[2*i], r[2*i+1]
		for k := 0; k < 4; k++ {
			c, d := corners[k], corners[(k+1)%4]
			if segmentsIntersect(ax, ay, bx, by, c[0], c[1], d[0], d[1]) {
				return true
			}
		}
	}
	return false
}

// TileKept reports whether the TMS tile (x, y) at this zoom is swept for this
// ring. The rule is intersection, not centre-in-polygon: the extracted area is
// always a superset of what was drawn, exactly as the drawn rectangle is
// already rounded outwards onto the tile lattice. A corridor narrower than one
// tile therefore still yields columns.
func (r Ring) TileKept(zoom, x, y int) bool {
	south, west := TileTMSToLatLon(zoom, x, y)
	north, east := TileTMSToLatLon(zoom, x+1, y+1)
	return r.IntersectsBox(south, west, north, east)
}

// Canonical is the ring as six-decimal fields joined by commas - the same
// precision as the %f used elsewhere for export directory names.
func (r Ring) Canonical() string {
	parts := make([]string, len(r))
	for i, v := range r {
		parts[i] = strconv.FormatFloat(v, 'f', 6, 64)
	}
	return strings.Join(parts, ",")
}

// Hash names the export directory for a polygon scan. Twelve hex characters is
// plenty to keep two hand-drawn shapes apart, and short enough to read in a path.
func (r Ring) Hash() string {
	sum := sha256.Sum256([]byte(r.Canonical()))
	return hex.EncodeToString(sum[:])[:12]
}
