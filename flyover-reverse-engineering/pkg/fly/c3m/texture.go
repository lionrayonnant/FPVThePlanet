package c3m

import "fmt"

// TextureFormat is the encoding of a material's texture, as named by the byte
// at offset 3 of a C3M v3 material record.
type TextureFormat uint8

const (
	// TextureJPEG is what every region captured before ~2021 serves.
	TextureJPEG TextureFormat = 0
	// TextureHEIC is what recently captured regions serve instead: a HEIF
	// container around an HEVC-coded still. Same 512x512 tile, better ratio.
	TextureHEIC TextureFormat = 13
)

// Ext is the file extension matching the format, without the leading dot.
func (f TextureFormat) Ext() string {
	switch f {
	case TextureJPEG:
		return "jpg"
	case TextureHEIC:
		return "heic"
	}
	return "bin"
}

func (f TextureFormat) String() string {
	switch f {
	case TextureJPEG:
		return "JPEG"
	case TextureHEIC:
		return "HEIC"
	}
	return fmt.Sprintf("unknown(%d)", uint8(f))
}
