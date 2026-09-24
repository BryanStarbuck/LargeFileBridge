package main

import (
	"os"
	"syscall"
)

// sfDataless is SF_DATALESS from <sys/stat.h>: the file is a cloud placeholder (Dropbox / iCloud
// "online-only") whose bytes are not on this disk. Opening it makes the File Provider download it.
const sfDataless = 0x40000000

func isDataless(info os.FileInfo) bool {
	st, ok := info.Sys().(*syscall.Stat_t)
	return ok && st.Flags&sfDataless != 0
}
