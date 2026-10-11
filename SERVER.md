# Optional server features

Panbeh shows these only when the homeserver supports them. For calls, see [CALLS.md](CALLS.md).

## Scheduled messages

Long-press (or right-click) the send button and pick «ارسال زمان‌بندی‌شده». The homeserver holds the message and sends it at that time, so the phone doesn't need to be on. This uses MSC4140 delayed events, which Synapse supports once the admin sets a maximum delay in `homeserver.yaml`:

```yaml
max_event_delay_duration: 30d   # how far ahead people can schedule
```

Restart Synapse after the change. Conduit, Tuwunel and Continuwuity don't support delayed events yet, so the option doesn't appear on them.

- **Encrypted chats:** Panbeh encrypts the message when it's scheduled. Someone who joins the chat before it goes out can't read it.
- **Media:** photos and files upload right away; only the message waits.
- **Managing them:** a clock icon in the message field lists the chat's scheduled messages. From there you can send one now, change its text or time, or delete it.
- **Threads:** scheduling isn't offered inside a thread.
