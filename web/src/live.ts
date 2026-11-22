// Live reload: the server sends an event when the file was loaded again
// ("reload", and "hello" with the current generation on connecting) or
// failed to load ("error").

export interface LiveHandlers {
  generation(): number | undefined; // the generation the page shows
  reload(): void; // the server has another generation
  error(message: string): void; // the file failed to load
}

export function connect(h: LiveHandlers) {
  const es = new EventSource("/api/events");
  const onGen = (e: MessageEvent) => {
    const { generation } = JSON.parse(e.data);
    if (generation !== h.generation()) h.reload();
  };
  es.addEventListener("hello", onGen);
  es.addEventListener("reload", onGen);
  es.addEventListener("error", (e) => {
    // A server "error" event carries data; a dropped connection does not,
    // and EventSource reconnects by itself.
    const data = (e as MessageEvent).data;
    if (data) h.error(JSON.parse(data).message);
  });
}
