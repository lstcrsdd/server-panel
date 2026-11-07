//go:build darwin || linux

package main

import (
	"os"
	"syscall"
	"unsafe"
)

func ioctl(fd int, req, arg uintptr) error {
	_, _, e := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), req, arg)
	if e != 0 {
		return e
	}
	return nil
}

// setWinsize меняет размер терминала; ssh получает SIGWINCH и передаёт размер на сервер.
func setWinsize(f *os.File, cols, rows int) error {
	ws := struct{ Row, Col, X, Y uint16 }{uint16(rows), uint16(cols), 0, 0}
	return ioctl(int(f.Fd()), syscall.TIOCSWINSZ, uintptr(unsafe.Pointer(&ws)))
}
