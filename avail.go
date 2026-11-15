package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Доступность за сутки — полоска на главном экране. По каждому серверу
// хранится 48 получасовых делений, в каждом — худшее состояние за эти полчаса.
// Пока панель выключена, данных нет: такие деления остаются «нет данных».
const (
	availSlot  = 30 * time.Minute
	availSlots = 48
	// столько сервер должен быть без связи, чтобы деление стало красным
	availDownAfter = time.Minute

	availNone = '0' // нет данных: панель не работала или сервер не под наблюдением
	availOK   = '1' // на связи, оповещений нет
	availWarn = '2' // на связи, но есть активное оповещение
	availDown = '3' // нет связи
)

type availFile struct {
	Start int64             `json:"start"` // unix-время начала самого нового деления
	Rows  map[string]string `json:"rows"`  // сервер → 48 символов '0'..'3', новые в конце
}

type Avail struct {
	mu    sync.Mutex
	path  string
	start int64
	rows  map[string][]byte
	saved time.Time
	dirty bool
}

func newAvail(dataDir string) *Avail {
	av := &Avail{path: filepath.Join(dataDir, "availability.json"), rows: map[string][]byte{}}
	var f availFile
	if b, err := os.ReadFile(av.path); err == nil && json.Unmarshal(b, &f) == nil {
		av.start = f.Start
		for id, r := range f.Rows {
			if len(r) != availSlots {
				continue
			}
			row := []byte(r)
			for i, c := range row {
				if c < availNone || c > availDown {
					row[i] = availNone
				}
			}
			av.rows[id] = row
		}
	}
	return av
}

func availSlotStart(t time.Time) int64 {
	step := int64(availSlot / time.Second)
	return t.Unix() / step * step
}

// roll сдвигает все строки так, чтобы последнее деление было текущим.
func (av *Avail) roll(now time.Time) bool {
	cur := availSlotStart(now)
	if av.start == 0 {
		av.start = cur
		return true
	}
	if cur <= av.start { // часы перевели назад — ничего не трогаем
		return false
	}
	n := int((cur - av.start) / int64(availSlot/time.Second))
	for id, row := range av.rows {
		if n >= availSlots {
			for i := range row {
				row[i] = availNone
			}
		} else {
			copy(row, row[n:])
			for i := availSlots - n; i < availSlots; i++ {
				row[i] = availNone
			}
		}
		av.rows[id] = row
	}
	av.start = cur
	av.dirty = true
	return true
}

// mark записывает состояния серверов на момент now. В делении остаётся худшее
// из увиденного. Серверы, которых нет в levels и keep, забываются.
// Возвращает true, если что-то изменилось.
func (av *Avail) mark(levels map[string]byte, keep map[string]bool, now time.Time) bool {
	av.mu.Lock()
	defer av.mu.Unlock()
	changed := av.roll(now)
	for id, lv := range levels {
		row := av.rows[id]
		if row == nil {
			row = make([]byte, availSlots)
			for i := range row {
				row[i] = availNone
			}
			av.rows[id] = row
			changed = true
		}
		if lv > row[availSlots-1] {
			row[availSlots-1] = lv
			changed = true
		}
	}
	for id := range av.rows {
		if _, ok := levels[id]; !ok && !keep[id] {
			delete(av.rows, id)
			changed = true
		}
	}
	if changed {
		av.dirty = true
	}
	if av.dirty && now.Sub(av.saved) >= time.Minute {
		av.saveLocked(now)
	}
	return changed
}

func (av *Avail) saveLocked(now time.Time) {
	f := availFile{Start: av.start, Rows: make(map[string]string, len(av.rows))}
	for id, r := range av.rows {
		f.Rows[id] = string(r)
	}
	if b, err := json.Marshal(f); err == nil && writeFileAtomic(av.path, b) == nil {
		av.dirty = false
		av.saved = now
	}
}

func (av *Avail) flush() {
	av.mu.Lock()
	defer av.mu.Unlock()
	if av.dirty {
		av.saveLocked(time.Now())
	}
}

// view — данные для интерфейса.
func (av *Avail) view(now time.Time) map[string]any {
	av.mu.Lock()
	defer av.mu.Unlock()
	av.roll(now)
	rows := make(map[string]string, len(av.rows))
	for id, r := range av.rows {
		rows[id] = string(r)
	}
	return map[string]any{"start": av.start, "slot": int64(availSlot / time.Second), "rows": rows}
}
