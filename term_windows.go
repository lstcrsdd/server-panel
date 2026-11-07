//go:build windows

package main

// Терминал в Windows: ssh.exe запускается в псевдоконсоли ConPTY
// (Windows 10 1809+), чтобы работали цвета, полноэкранные программы и смена
// размера окна. Только стандартная библиотека — вызовы kernel32 напрямую.

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

var (
	kernel32                              = syscall.NewLazyDLL("kernel32.dll")
	procCreatePseudoConsole               = kernel32.NewProc("CreatePseudoConsole")
	procResizePseudoConsole               = kernel32.NewProc("ResizePseudoConsole")
	procClosePseudoConsole                = kernel32.NewProc("ClosePseudoConsole")
	procInitializeProcThreadAttributeList = kernel32.NewProc("InitializeProcThreadAttributeList")
	procUpdateProcThreadAttribute         = kernel32.NewProc("UpdateProcThreadAttribute")
	procDeleteProcThreadAttributeList     = kernel32.NewProc("DeleteProcThreadAttributeList")
)

const (
	procThreadAttributePseudoconsole = 0x00020016
	extendedStartupinfoPresent       = 0x00080000
	createUnicodeEnvironment         = 0x00000400
	startfUseStdHandles              = 0x00000100
)

// startupInfoEx повторяет STARTUPINFOEXW: STARTUPINFOW + список атрибутов.
type startupInfoEx struct {
	syscall.StartupInfo
	attrList uintptr
}

type winPTY struct {
	hpc       uintptr
	in, out   *os.File
	proc      syscall.Handle
	attr      []byte
	closeOnce sync.Once
	done      chan struct{}
	code      int
}

func conCoord(cols, rows int) uintptr {
	return uintptr(uint32(uint16(cols)) | uint32(uint16(rows))<<16)
}

func startPTY(argv, env []string, cols, rows int) (ptyProc, error) {
	if err := procCreatePseudoConsole.Find(); err != nil {
		return nil, errors.New("терминал требует Windows 10 версии 1809 или новее")
	}
	exe, err := exec.LookPath(argv[0])
	if err != nil {
		return nil, fmt.Errorf("не найден %s — установите клиент OpenSSH", argv[0])
	}

	var ptyIn, inW, outR, ptyOut syscall.Handle
	if err := syscall.CreatePipe(&ptyIn, &inW, nil, 0); err != nil {
		return nil, err
	}
	if err := syscall.CreatePipe(&outR, &ptyOut, nil, 0); err != nil {
		syscall.CloseHandle(ptyIn)
		syscall.CloseHandle(inW)
		return nil, err
	}
	var hpc uintptr
	hr, _, _ := procCreatePseudoConsole.Call(conCoord(cols, rows), uintptr(ptyIn), uintptr(ptyOut), 0, uintptr(unsafe.Pointer(&hpc)))
	// псевдоконсоль держит свои копии этих концов
	syscall.CloseHandle(ptyIn)
	syscall.CloseHandle(ptyOut)
	if hr != 0 {
		syscall.CloseHandle(inW)
		syscall.CloseHandle(outR)
		return nil, fmt.Errorf("CreatePseudoConsole: 0x%x", hr)
	}
	p := &winPTY{hpc: hpc, in: os.NewFile(uintptr(inW), "conpty-in"), out: os.NewFile(uintptr(outR), "conpty-out"), done: make(chan struct{})}
	fail := func(err error) (ptyProc, error) {
		p.closeConsole()
		p.in.Close()
		p.out.Close()
		return nil, err
	}

	var size uintptr
	procInitializeProcThreadAttributeList.Call(0, 1, 0, uintptr(unsafe.Pointer(&size)))
	if size == 0 {
		return fail(errors.New("InitializeProcThreadAttributeList: нулевой размер"))
	}
	p.attr = make([]byte, size)
	if r, _, e := procInitializeProcThreadAttributeList.Call(uintptr(unsafe.Pointer(&p.attr[0])), 1, 0, uintptr(unsafe.Pointer(&size))); r == 0 {
		return fail(fmt.Errorf("InitializeProcThreadAttributeList: %v", e))
	}
	if r, _, e := procUpdateProcThreadAttribute.Call(uintptr(unsafe.Pointer(&p.attr[0])), 0, procThreadAttributePseudoconsole, hpc, unsafe.Sizeof(hpc), 0, 0); r == 0 {
		procDeleteProcThreadAttributeList.Call(uintptr(unsafe.Pointer(&p.attr[0])))
		return fail(fmt.Errorf("UpdateProcThreadAttribute: %v", e))
	}

	var si startupInfoEx
	si.Cb = uint32(unsafe.Sizeof(si))
	// пустые стандартные дескрипторы: иначе ssh унаследует консоль панели
	si.Flags = startfUseStdHandles
	si.attrList = uintptr(unsafe.Pointer(&p.attr[0]))

	parts := make([]string, len(argv))
	parts[0] = syscall.EscapeArg(exe)
	for i := 1; i < len(argv); i++ {
		parts[i] = syscall.EscapeArg(argv[i])
	}
	cmdline, err := syscall.UTF16PtrFromString(strings.Join(parts, " "))
	if err != nil {
		return fail(err)
	}
	app, err := syscall.UTF16PtrFromString(exe)
	if err != nil {
		return fail(err)
	}
	envBlock := makeEnvBlock(env)
	var pi syscall.ProcessInformation
	err = syscall.CreateProcess(app, cmdline, nil, nil, false, extendedStartupinfoPresent|createUnicodeEnvironment,
		&envBlock[0], nil, &si.StartupInfo, &pi)
	if err != nil {
		procDeleteProcThreadAttributeList.Call(uintptr(unsafe.Pointer(&p.attr[0])))
		return fail(fmt.Errorf("CreateProcess: %v", err))
	}
	syscall.CloseHandle(pi.Thread)
	p.proc = pi.Process

	// ConPTY не закрывает вывод сам, когда процесс завершился: ждём выхода и
	// закрываем псевдоконсоль — тогда чтение получит EOF.
	go func() {
		syscall.WaitForSingleObject(p.proc, syscall.INFINITE)
		var c uint32
		if syscall.GetExitCodeProcess(p.proc, &c) == nil {
			p.code = int(c)
		} else {
			p.code = -1
		}
		close(p.done)
		p.closeConsole()
	}()
	return p, nil
}

// makeEnvBlock — блок окружения для CreateProcessW: «ключ=значение\0…\0\0»,
// без повторов (побеждает последнее значение), отсортированный по ключу.
func makeEnvBlock(env []string) []uint16 {
	byKey := map[string]string{}
	for _, kv := range env {
		k := kv
		if i := strings.Index(kv[min(1, len(kv)):], "="); i >= 0 {
			k = kv[:i+1]
		}
		byKey[strings.ToUpper(k)] = kv
	}
	keys := make([]string, 0, len(byKey))
	for k := range byKey {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b []uint16
	for _, k := range keys {
		u, err := syscall.UTF16FromString(byKey[k])
		if err != nil {
			continue
		}
		b = append(b, u...)
	}
	if len(b) == 0 {
		b = append(b, 0)
	}
	return append(b, 0)
}

func (p *winPTY) closeConsole() {
	p.closeOnce.Do(func() { procClosePseudoConsole.Call(p.hpc) })
}

func (p *winPTY) Read(b []byte) (int, error)  { return p.out.Read(b) }
func (p *winPTY) Write(b []byte) (int, error) { return p.in.Write(b) }

func (p *winPTY) Resize(cols, rows int) error {
	select {
	case <-p.done:
		return nil
	default:
	}
	if hr, _, _ := procResizePseudoConsole.Call(p.hpc, conCoord(cols, rows)); hr != 0 {
		return fmt.Errorf("ResizePseudoConsole: 0x%x", hr)
	}
	return nil
}

// Hangup закрывает псевдоконсоль: ssh получает событие закрытия и выходит.
func (p *winPTY) Hangup() { p.closeConsole() }

func (p *winPTY) Kill() {
	if p.proc != 0 {
		syscall.TerminateProcess(p.proc, 1)
	}
}

func (p *winPTY) Wait() (int, error) {
	<-p.done
	return p.code, nil
}

func (p *winPTY) Close() error {
	p.closeConsole()
	p.in.Close()
	p.out.Close()
	if p.attr != nil {
		procDeleteProcThreadAttributeList.Call(uintptr(unsafe.Pointer(&p.attr[0])))
		p.attr = nil
	}
	if p.proc != 0 {
		syscall.CloseHandle(p.proc)
		p.proc = 0
	}
	return nil
}
