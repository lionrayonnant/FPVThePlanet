package exp

import (
	"errors"
	"fmt"
	"io/ioutil"
	"os"
	"os/exec"
	"path"
	"sync"
)

// Recently captured Flyover regions ship their textures as HEIC (HEVC stills)
// rather than JPEG. Nothing downstream of the OBJ export speaks HEVC -- not
// sharp in sim/tools/prep.mjs, whose bundled libheif is AV1-only, and not any
// ordinary OBJ viewer -- and Go has no usable HEVC decoder, so the export
// transcodes to JPEG here and the on-disk contract stays "OBJ + MTL + JPEG".
//
// Quality is deliberately high: prep.mjs re-encodes these into texture sheets
// at its own quality setting, and stacking two lossy passes at that setting
// would show. At 95 the transcode is not the weak link.
const heicJPEGQuality = "95"

// One 512x512 tile costs ~15 ms wall-clock through any of these, spawn
// included, which disappears into the exporter's 16-way tile parallelism.
var heicDecoders = []struct {
	bin  string
	args func(in, out string) []string
}{
	{"heif-convert", func(in, out string) []string {
		return []string{"-q", heicJPEGQuality, "--quiet", in, out}
	}},
	{"magick", func(in, out string) []string {
		return []string{in, "-quality", heicJPEGQuality, out}
	}},
	{"ffmpeg", func(in, out string) []string {
		return []string{"-y", "-loglevel", "error", "-i", in, "-q:v", "2", out}
	}},
}

var (
	heicOnce sync.Once
	heicPath string
	heicIdx  int
	heicErr  error
)

func findHEICDecoder() (string, int, error) {
	heicOnce.Do(func() {
		for i, d := range heicDecoders {
			if p, err := exec.LookPath(d.bin); err == nil {
				heicPath, heicIdx = p, i
				return
			}
		}
		names := make([]string, len(heicDecoders))
		for i, d := range heicDecoders {
			names[i] = d.bin
		}
		heicErr = fmt.Errorf("cette zone est livrée en textures HEIC et aucun décodeur n'est installé — "+
			"il en faut un parmi %v (paquet libheif, imagemagick ou ffmpeg)", names)
	})
	return heicPath, heicIdx, heicErr
}

// heicToJPEG transcodes a HEIF/HEVC still to JPEG bytes.
func heicToJPEG(data []byte) ([]byte, error) {
	bin, idx, err := findHEICDecoder()
	if err != nil {
		return nil, err
	}

	dir, err := ioutil.TempDir("", "flyover-heic")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)

	in, out := path.Join(dir, "in.heic"), path.Join(dir, "out.jpg")
	if err = ioutil.WriteFile(in, data, 0644); err != nil {
		return nil, err
	}

	cmd := exec.Command(bin, heicDecoders[idx].args(in, out)...)
	if combined, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("%s: %v: %s", path.Base(bin), err, combined)
	}

	jpg, err := ioutil.ReadFile(out)
	if err != nil {
		return nil, err
	}
	if len(jpg) == 0 {
		return nil, errors.New(path.Base(bin) + " a produit un JPEG vide")
	}
	return jpg, nil
}
