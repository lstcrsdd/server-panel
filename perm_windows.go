//go:build windows

package main

import "os"

// В Windows-сборке OpenSSH нет ControlMaster: каждая команда открывает своё
// SSH-подключение (поток метрик всё равно держит одно постоянное).
const useControlMaster = false

func ownedByMe(os.FileInfo) bool { return true }
