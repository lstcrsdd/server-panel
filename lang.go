package main

import (
	"fmt"
	"sync/atomic"
)

// Язык сообщений панели: ошибки API, тексты оповещений и уведомлений.
// Ключ перевода — русская строка: L("нет связи"). Перевода нет — остаётся
// русская. Язык один на всю панель (настройка lang), его задаёт интерфейс.
// Словарь — lang_en.go.
var curLang atomic.Value

func setLang(l string) {
	if l != "en" {
		l = "ru"
	}
	curLang.Store(l)
}

func lang() string {
	if v, _ := curLang.Load().(string); v != "" {
		return v
	}
	return "ru"
}

// L переводит строку на язык панели. Для строк формата: fmt.Sprintf(L("…%s"), x).
func L(s string) string {
	if lang() == "en" {
		if e, ok := enDict[s]; ok {
			return e
		}
	}
	return s
}

// Lf — fmt.Sprintf с переводом формата.
func Lf(format string, args ...any) string { return fmt.Sprintf(L(format), args...) }

// pluralForm выбирает форму слова по числу: в русском три формы, в английском две
// (в словаре ключ "день|дня|дней" → "day|days").
func pluralForm(n int, one, few, many string) string {
	if lang() == "en" {
		if e, ok := enDict[one+"|"+few+"|"+many]; ok {
			for i := 0; i < len(e); i++ {
				if e[i] == '|' {
					if n == 1 || n == -1 {
						return e[:i]
					}
					return e[i+1:]
				}
			}
			return e
		}
	}
	if n < 0 {
		n = -n
	}
	a, b := n%100, n%10
	switch {
	case a > 10 && a < 20:
		return many
	case b == 1:
		return one
	case b >= 2 && b <= 4:
		return few
	}
	return many
}
