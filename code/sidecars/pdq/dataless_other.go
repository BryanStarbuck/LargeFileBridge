//go:build !darwin

package main

import "os"

// Only macOS marks cloud placeholders with SF_DATALESS; elsewhere every file is treated as present.
func isDataless(os.FileInfo) bool { return false }
