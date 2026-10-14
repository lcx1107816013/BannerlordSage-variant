package sandbox

import (
	"strings"
	"testing"
)

func TestValidateAndResolve(t *testing.T) {
	base := `D:\repo\dist\games\bannerlord\assets`
	s := New(`D:\repo`, base)

	ok := []struct{ in, wantPrefix string }{
		{"", base},
		{".", base},
		{"Xmls/SkinData.xml", base + `\Xmls\SkinData.xml`},
		{`Xmls\..\Xmls\a.xml`, base + `\Xmls\a.xml`},
	}
	for _, c := range ok {
		got, err := s.ValidateAndResolve(c.in)
		if err != nil {
			t.Fatalf("ValidateAndResolve(%q) unexpected error: %v", c.in, err)
		}
		if got != c.wantPrefix {
			t.Fatalf("ValidateAndResolve(%q) = %q, want %q", c.in, got, c.wantPrefix)
		}
	}

	bad := []string{
		`C:\Windows\win.ini`,      // cross-drive absolute
		`\\server\share\x`,        // UNC
		`..\..\..\Windows\win.ini`, // parent traversal
		"..",
	}
	for _, in := range bad {
		_, err := s.ValidateAndResolve(in)
		if err == nil {
			t.Fatalf("ValidateAndResolve(%q) = nil error, want rejection", in)
		}
		want := `Path escapes the sandbox root: "` + in + `"`
		if err.Error() != want {
			t.Fatalf("error = %q, want %q", err.Error(), want)
		}
	}
}

func TestEmptyRelativePathStaysInsideBase(t *testing.T) {
	s := New(`D:\repo`, `D:\repo\assets`)
	got, err := s.ValidateAndResolve("")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.EqualFold(got, `D:\repo\assets`) {
		t.Fatalf("got %q", got)
	}
}
