package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// event is one server sent event.
type event struct {
	name string
	data any
}

// broker fans events out to the connected /api/events clients. A client
// that falls behind loses events rather than blocking the others; the UI
// re-reads the meta on any event, so only the latest one matters.
type broker struct {
	mu      sync.Mutex
	clients map[chan event]struct{}
	closed  bool
}

func newBroker() *broker { return &broker{clients: map[chan event]struct{}{}} }

func (b *broker) subscribe() (chan event, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return nil, false
	}
	ch := make(chan event, 8)
	b.clients[ch] = struct{}{}
	return ch, true
}

func (b *broker) unsubscribe(ch chan event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.clients[ch]; ok {
		delete(b.clients, ch)
		close(ch)
	}
}

func (b *broker) publish(e event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.clients {
		select {
		case ch <- e:
		default:
		}
	}
}

// close ends every client's stream, for shutdown.
func (b *broker) close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	for ch := range b.clients {
		delete(b.clients, ch)
		close(ch)
	}
}

// heartbeat keeps idle connections from being dropped by the browser.
const heartbeat = 15 * time.Second

// handleEvents streams events:
//
//	hello  {"generation": n}   on connect
//	reload {"generation": n}   after the file was loaded again
//	error  {"message": "..."}  when loading failed; the old table stays
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	ch, ok := s.events.subscribe()
	if !ok {
		http.Error(w, "shutting down", http.StatusServiceUnavailable)
		return
	}
	defer s.events.unsubscribe(ch)

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	write := func(e event) bool {
		data, _ := json.Marshal(e.data)
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", e.name, data); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	if !write(event{"hello", genData(s.cur.Load().gen)}) {
		return
	}
	tick := time.NewTicker(heartbeat)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case e, ok := <-ch:
			if !ok || !write(e) {
				return
			}
		case <-tick.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func genData(gen uint64) any {
	return struct {
		Generation uint64 `json:"generation"`
	}{gen}
}
