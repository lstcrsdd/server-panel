package main

import (
	"bytes"
	"os"
	"syscall"
	"unsafe"
)

// openPTY открывает пару псевдотерминалов (macOS): /dev/ptmx + grantpt/unlockpt/ptsname.
func openPTY() (master, slave *os.File, err error) {
	fd, err := syscall.Open("/dev/ptmx", syscall.O_RDWR|syscall.O_NOCTTY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, nil, err
	}
	master = os.NewFile(uintptr(fd), "/dev/ptmx")
	if err := ioctl(fd, syscall.TIOCPTYGRANT, 0); err != nil {
		master.Close()
		return nil, nil, err
	}
	if err := ioctl(fd, syscall.TIOCPTYUNLK, 0); err != nil {
		master.Close()
		return nil, nil, err
	}
	var name [128]byte
	if err := ioctl(fd, syscall.TIOCPTYGNAME, uintptr(unsafe.Pointer(&name[0]))); err != nil {
		master.Close()
		return nil, nil, err
	}
	n := bytes.IndexByte(name[:], 0)
	if n < 0 {
		n = len(name)
	}
	slave, err = os.OpenFile(string(name[:n]), os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		master.Close()
		return nil, nil, err
	}
	return master, slave, nil
}
