package main

import (
	"regexp"
	"strings"
	"testing"
)

// Перевод не должен менять набор и порядок подстановок fmt, иначе Sprintf соберёт мусор.
func TestEnDictKeepsFormatVerbs(t *testing.T) {
	verb := regexp.MustCompile(`%%|%(?:\[\d+\])?[-+#0]*\d*(?:\.\d+)?[a-zA-Z]`)
	for ru, en := range enDict {
		a, b := verb.FindAllString(ru, -1), verb.FindAllString(en, -1)
		if strings.Join(a, " ") != strings.Join(b, " ") {
			t.Errorf("подстановки разошлись:\n  %q\n  %q", ru, en)
		}
		if strings.Count(ru, "|") == 2 && !strings.Contains(ru, " ") && strings.Count(en, "|") != 1 {
			t.Errorf("формы числа: у %q должно быть две английские формы, а не %q", ru, en)
		}
	}
}

func TestLangSwitch(t *testing.T) {
	defer setLang("ru")
	setLang("ru")
	if got := L("нет связи"); got != "нет связи" {
		t.Fatalf("ru: %q", got)
	}
	if got := plural(2, "день", "дня", "дней"); got != "дня" {
		t.Fatalf("ru plural: %q", got)
	}
	setLang("en")
	if got := L("строка, которой нет в словаре"); got != "строка, которой нет в словаре" {
		t.Fatalf("без перевода должна остаться исходная строка, а не %q", got)
	}
	if _, ok := enDict["день|дня|дней"]; ok {
		if one, many := plural(1, "день", "дня", "дней"), plural(5, "день", "дня", "дней"); one == many {
			t.Fatalf("en plural: %q и %q", one, many)
		}
	}
}
