package main

import (
	"testing"
	"time"
)

func TestAvailMarkAndRoll(t *testing.T) {
	av := newAvail(t.TempDir())
	t0 := time.Unix(1_800_000_000, 0).Truncate(availSlot)
	last := func(id string) byte { return av.rows[id][availSlots-1] }

	if !av.mark(map[string]byte{"a": availOK, "b": availDown}, nil, t0) {
		t.Fatal("первая отметка должна считаться изменением")
	}
	// в делении остаётся худшее: «внимание» перекрывает «в норме», но не наоборот
	av.mark(map[string]byte{"a": availWarn, "b": availOK}, nil, t0.Add(time.Minute))
	av.mark(map[string]byte{"a": availOK, "b": availOK}, nil, t0.Add(2*time.Minute))
	if last("a") != availWarn || last("b") != availDown {
		t.Fatalf("худшее состояние не сохранилось: a=%c b=%c", last("a"), last("b"))
	}

	// через полтора часа: три новых деления, старое уехало на три позиции влево
	av.mark(map[string]byte{"a": availOK, "b": availOK}, nil, t0.Add(90*time.Minute))
	row := string(av.rows["a"])
	if row[availSlots-4] != availWarn || row[availSlots-3] != availNone || row[availSlots-2] != availNone || row[availSlots-1] != availOK {
		t.Fatalf("сдвиг неверный: %q", row[availSlots-5:])
	}

	// сервер, которого больше нет, забывается; сервер из keep остаётся
	av.mark(map[string]byte{"a": availOK}, map[string]bool{"c": true}, t0.Add(91*time.Minute))
	if _, ok := av.rows["b"]; ok {
		t.Fatal("строка удалённого сервера осталась")
	}

	// больше суток простоя панели — вся строка «нет данных», кроме текущего деления
	av.mark(map[string]byte{"a": availOK}, nil, t0.Add(40*time.Hour))
	row = string(av.rows["a"])
	for i := 0; i < availSlots-1; i++ {
		if row[i] != availNone {
			t.Fatalf("после долгого простоя деление %d = %c", i, row[i])
		}
	}

	// сохранение и чтение
	av.flush()
	av2 := newAvail(filepathDir(av.path))
	if string(av2.rows["a"]) != row || av2.start != av.start {
		t.Fatal("после перезапуска данные не совпали")
	}
}

func filepathDir(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' || p[i] == '\\' {
			return p[:i]
		}
	}
	return "."
}
