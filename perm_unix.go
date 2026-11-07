//go:build !windows

package main

import (
	"os"
	"syscall"
)

// useControlMaster — мультиплексирование SSH-соединений (ControlMaster).
// В Windows-сборке OpenSSH оно не поддерживается.
const useControlMaster = true

func ownedByMe(st os.FileInfo) bool {
	if sys, ok := st.Sys().(*syscall.Stat_t); ok {
		return int(sys.Uid) == os.Getuid()
	}
	return true
}
