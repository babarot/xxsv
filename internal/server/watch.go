package server

import (
	"context"
	"os"
	"time"
)

// fileState is what the watcher compares between polls.
type fileState struct {
	exists bool
	size   int64
	mtime  time.Time
}

func stat(path string) fileState {
	fi, err := os.Stat(path)
	if err != nil {
		return fileState{}
	}
	return fileState{exists: true, size: fi.Size(), mtime: fi.ModTime()}
}

// watch polls the file and reloads it when it changed.
//
// Polling rather than fsnotify: editors that save by writing a new file and
// renaming it over the old one replace the inode, and a watch on the file
// would stop seeing changes. A change is acted on only once two polls in a
// row agree, so a file being written is not read half way. Reloads are at
// least MinReloadInterval apart, for files that are appended to all the
// time, such as a running Claude Code session.
func (s *Server) watch(ctx context.Context) {
	tick := time.NewTicker(s.opts.PollInterval)
	defer tick.Stop()
	tried := s.cur.Load().file // the last state a load was attempted for
	prev := tried
	var lastReload time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		cur := stat(s.path)
		settled := cur == prev
		prev = cur
		if !settled || cur == tried || time.Since(lastReload) < s.opts.MinReloadInterval {
			continue
		}
		lastReload = time.Now()
		tried = cur
		if !cur.exists {
			s.fail("file not found: " + s.path)
			continue
		}
		if err := s.reload(); err != nil {
			s.events.publish(event{"error", errData(err.Error())})
			continue
		}
		s.events.publish(event{"reload", genData(s.cur.Load().gen)})
	}
}

func (s *Server) fail(msg string) {
	s.errMu.Lock()
	s.loadErr = msg
	s.errMu.Unlock()
	s.events.publish(event{"error", errData(msg)})
}

func errData(msg string) any {
	return struct {
		Message string `json:"message"`
	}{msg}
}
