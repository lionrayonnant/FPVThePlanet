package fly

import (
	"encoding/xml"
	"io/ioutil"
	"math"
	"os"
	"path"
	"regexp"
	"strconv"
	"strings"

	"github.com/retroplasma/flyover-reverse-engineering/pkg/mps"
	"github.com/retroplasma/flyover-reverse-engineering/pkg/web"
)

type AltitudeManifest struct {
	XMLName  xml.Name  `xml:"manifest"`
	Triggers []Trigger `xml:"triggers>trigger"`
}

type Trigger struct {
	XMLName xml.Name `xml:"trigger"`
	Name    string   `xml:"name,attr"`
	LatRad  float64  `xml:"latitude,attr"`
	LonRad  float64  `xml:"longitude,attr"`
	Radius  float64  `xml:"radius,attr"`
	Region  int      `xml:"region,attr"`
	Version int      `xml:"version,attr"`

	// MetaRegion is "<z> <y> <x> <w> <h>": the bounding box, in z-level
	// tile coordinates, that this trigger's octree actually covers. Present
	// on auto-generated grid triggers (Reg_z9_*); empty on legacy triggers.
	MetaRegion string `xml:"meta_region,attr"`

	Lat float64 // converted from LatRad
	Lon float64 // converted from LonRad
}

// RegionBox is the parsed form of MetaRegion: at zoom Z, the tiles
// [X, X+W) x [Y, Y+H) are the only ones this trigger can possibly serve.
type RegionBox struct {
	Z, Y, X, W, H int
	Ok            bool
}

// Box parses MetaRegion, if present.
func (t Trigger) Box() RegionBox {
	fields := strings.Fields(t.MetaRegion)
	if len(fields) != 5 {
		return RegionBox{}
	}
	n := make([]int, 5)
	for i, f := range fields {
		v, err := strconv.Atoi(f)
		if err != nil {
			return RegionBox{}
		}
		n[i] = v
	}
	return RegionBox{Z: n[0], Y: n[1], X: n[2], W: n[3], H: n[4], Ok: true}
}

// Contains reports whether tile (z,y,x) can possibly be served by this box,
// by scaling the box up/down to z and checking containment. Zooming out
// loses precision (a box aligned at a finer level can span a fraction of a
// coarser tile), so when z is coarser than the box's Z the check is widened
// by one tile on each side to stay conservative - false positives just mean
// an extra HTTP probe, false negatives would silently drop real tiles.
func (b RegionBox) Contains(z, y, x int) bool {
	if !b.Ok {
		return true // no box known: don't prune
	}
	if z >= b.Z {
		shift := uint(z - b.Z)
		minX, minY := b.X<<shift, b.Y<<shift
		maxX, maxY := (b.X+b.W)<<shift, (b.Y+b.H)<<shift
		return x >= minX && x < maxX && y >= minY && y < maxY
	}
	shift := uint(b.Z - z)
	minX, minY := (b.X>>shift)-1, (b.Y>>shift)-1
	maxX, maxY := ((b.X+b.W)>>shift)+1, ((b.Y+b.H)>>shift)+1
	return x >= minX && x < maxX && y >= minY && y < maxY
}

var regexAltitudeFile = regexp.MustCompile(`^altitude[a-zA-Z0-9-]*\.xml$`)

// GetAltitudeManifest finds altitude manifest reference in resource manifest
// and fetches its contents from cache or web and decodes it
func GetAltitudeManifest(cache mps.Cache, rm mps.ResourceManifest) (am AltitudeManifest, err error) {
	// find altitude file name
	altitudeFile, err := rm.CacheFileNameFromRegexp(regexAltitudeFile)
	if err != nil {
		return
	}

	// get altitude manifest
	rawAmCachePath := path.Join(cache.Directory, altitudeFile)
	var rawAm []byte
	if cache.Enabled {
		_, err = os.Stat(rawAmCachePath)
	}
	if !cache.Enabled || os.IsNotExist(err) {
		// from url
		// hotfix: proto field CacheBaseUrl is empty/outdated, use literal base url instead
		if rawAm, err = web.Get("https://gspe21-ssl.ls.apple.com/xml/" + altitudeFile); err != nil {
			return
		}
		if cache.Enabled {
			// to cache
			if err = ioutil.WriteFile(rawAmCachePath, rawAm, 0644); err != nil {
				return
			}
		}
	} else if err == nil {
		// from cache
		if rawAm, err = ioutil.ReadFile(rawAmCachePath); err != nil {
			return
		}
	} else {
		return
	}

	// decode altitude manifest
	am = AltitudeManifest{}
	if err = xml.Unmarshal(rawAm, &am); err != nil {
		return
	}

	// lat lon deg for convenience
	for i := range am.Triggers {
		t := &am.Triggers[i]
		t.Lat = t.LatRad / math.Pi * 180
		t.Lon = t.LonRad / math.Pi * 180
	}

	return
}
