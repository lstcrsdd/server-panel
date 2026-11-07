//go:build darwin || linux

package main

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

type unixPTY struct {
	ptm *os.File
	cmd *exec.Cmd
}

func startPTY(argv, env []string, cols, rows int) (ptyProc, error) {
	ptm, pts, err := openPTY()
	if err != nil {
		return nil, err
	}
	_ = setWinsize(ptm, cols, rows)
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = pts, pts, pts
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	cmd.Env = env
	if err := cmd.Start(); err != nil {
		ptm.Close()
		pts.Close()
		return nil, err
	}
	pts.Close()
	return &unixPTY{ptm: ptm, cmd: cmd}, nil
}

func (u *unixPTY) Read(p []byte) (int, error)  { return u.ptm.Read(p) }
func (u *unixPTY) Write(p []byte) (int, error) { return u.ptm.Write(p) }
func (u *unixPTY) Resize(c, r int) error       { return setWinsize(u.ptm, c, r) }
func (u *unixPTY) Close() error                { return u.ptm.Close() }

func (u *unixPTY) Hangup() {
	if u.cmd.Process != nil {
		_ = u.cmd.Process.Signal(syscall.SIGHUP)
	}
}

func (u *unixPTY) Kill() {
	if u.cmd.Process != nil {
		_ = u.cmd.Process.Kill()
	}
}

func (u *unixPTY) Wait() (int, error) {
	err := u.cmd.Wait()
	if err == nil {
		return 0, nil
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), nil
	}
	return -1, err
}
