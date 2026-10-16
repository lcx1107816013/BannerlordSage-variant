package tools

import "os"

// osStat reports whether path exists and is a directory.
func osStat(path string) (bool, error) {
	info, err := os.Stat(path)
	if err != nil {
		return false, err
	}
	return info.IsDir(), nil
}
