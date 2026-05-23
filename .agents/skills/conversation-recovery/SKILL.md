---
name: conversation-recovery
description: >
  Recover context from a previous conversation that ended abruptly (max_iterations, crash, etc).
  Summarizes the last N events from the old conversation for continuity and optionally
  saves important context to durable memory.
metadata:
  tags: memory, continuity, recovery, conversation
  triggers:
    - max_iterations
    - conversation ended
    - pick up where we left off
    - continue from
    - what were we doing
---

# Conversation Recovery

Use this skill when a new conversation starts after the previous one ended abruptly — typically from `max_iterations_exceeded`, a crash, or a forced restart. The goal is to reconstruct enough context to continue seamlessly.

## When to trigger

- The agent server started a new conversation after the old one hit `max_iterations`
- Engel says something like "pick up where we left off" or "what were we doing?"
- You notice from meta/state that the previous conversation on this scope ended abnormally

## How to recover

### 1. Find the old conversation

Conversations live at `~/.openhands/conversations/<conversation-id>/`. Each has:
- `events.jsonl` — full event log (can be thousands of lines)
- `meta.json` — scope, ingress, and task metadata
- `state.json` — final agent state
- `turns.json` — turn boundaries

If you know the conversation ID (e.g. from a WhatsApp message or scope context), go directly. Otherwise, find the most recent conversation for this scope:

```bash
# Find recent conversations by modification time
ls -lt ~/.openhands/conversations/ | head -10

# Or search by scope in meta.json
grep -rl '"scope_id": "main"' ~/.openhands/conversations/*/meta.json | head -5
```

### 2. Extract the last N events

The events file can be huge. Only read what you need — typically the last 50-100 meaningful events. Most events are `ConversationStateUpdateEvent` noise; filter for substance.

```bash
tail -200 ~/.openhands/conversations/<id>/events.jsonl | python3 -c "
import sys, json, re

for line in sys.stdin:
    ev = json.loads(line.strip())
    kind = ev.get('kind', '')
    ts = ev.get('timestamp', '')

    # Skip state update noise
    if kind == 'ConversationStateUpdateEvent':
        status = ev.get('agent_status')
        if status in ('IDLE', 'RUNNING'):
            print(f'[{ts}] STATE → {status}')
        continue

    if kind == 'MessageEvent':
        llm = ev.get('llm_message', {})
        role = llm.get('role', '?')
        content = llm.get('content', '')
        if isinstance(content, list):
            texts = [c.get('text','')[:400] for c in content if isinstance(c, dict) and c.get('type') == 'text']
            content = ' | '.join(texts)
        elif not isinstance(content, str):
            content = str(content)

        tool_calls = llm.get('tool_calls', [])
        if tool_calls:
            for tc in tool_calls:
                fn = tc.get('function', {})
                name = fn.get('name', '?')
                args = fn.get('arguments', '')
                if isinstance(args, str):
                    try: args = json.loads(args)
                    except (json.JSONDecodeError, TypeError): pass
                if name == 'finish':
                    msg = args.get('message', '') if isinstance(args, dict) else ''
                    print(f'[{ts}] FINISH: {msg[:300]}')
                elif name == 'send_message':
                    print(f'[{ts}] SEND: {(args.get(\"text\",\"\") if isinstance(args,dict) else \"\")[:300]}')
                elif name == 'think':
                    print(f'[{ts}] THINK: {(args.get(\"thought\",\"\") if isinstance(args,dict) else \"\")[:300]}')
                else:
                    print(f'[{ts}] {role} CALL {name}: {str(args)[:300]}')
            continue

        if role == 'user':
            m = re.search(r'<message[^>]*>(.*?)</message>', content, re.DOTALL)
            if m:
                print(f'[{ts}] USER: {m.group(1).strip()[:400]}')
            else:
                print(f'[{ts}] USER: {content[:400]}')
        elif role == 'assistant':
            print(f'[{ts}] ASSISTANT: {content[:300]}')
        elif role == 'tool':
            print(f'[{ts}] TOOL: {content[:200]}')
        continue

    if kind == 'ConversationErrorEvent':
        print(f'[{ts}] ERROR: {ev.get(\"code\",\"?\")} — {ev.get(\"detail\",\"\")}')
"
```

### 3. Build a summary

From the extracted events, produce a summary with these sections:

- **What we were doing**: the main task/topic in progress
- **Last user request**: the final thing Engel asked for
- **What the agent was doing when it stopped**: last tool calls and their results
- **Unfinished work**: anything that was started but not completed
- **Key decisions made**: important choices that should carry forward

### 4. Emergency memory save

If the old conversation contained important context that might be lost, save it:

```bash
# Append to today's daily memory
DATE=$(date +%Y-%m-%d)
MEMORY_DIR="${SMOLPAWS_HOME_DIR:-$HOME/.smolpaws}/memory"
cat >> "$MEMORY_DIR/$DATE.md" << 'EOF'

## Recovery from conversation <id>

- [key facts extracted from the old conversation]
- [unfinished work items]
- [decisions that need to persist]
EOF
```

For truly durable facts (stable across days), also update `~/.smolpaws/memory/MEMORY.md`.

### 5. Present to the user

Send a concise summary via `send_message` so Engel knows what was recovered. Format:

```text
*Recovered from <conversation-id>*

*Last topic:* [what we were doing]
*Last request:* [Engel's final ask]
*Status when it died:* [what the agent was mid-doing]

*Unfinished:*
• item 1
• item 2

Ready to continue 🐾
```

Then proceed with the unfinished work if appropriate.

## Event format reference

Events in `events.jsonl` are JSON objects with these common `kind` values:

| Kind | What it is |
|------|-----------|
| `MessageEvent` | LLM message (user/assistant/tool role in `.llm_message`) |
| `ConversationStateUpdateEvent` | Agent status change (mostly noise) |
| `ConversationTurnEvent` | Turn boundary marker |
| `ConversationResumeEvent` | Conversation was resumed |
| `ConversationErrorEvent` | Error (check `.code` — e.g. `max_iterations_exceeded`) |
| `ActionEvent` | Agent action dispatched |
| `ObservationEvent` | Environment observation returned |

The `MessageEvent.llm_message` follows the standard chat format:
- `.role`: `user`, `assistant`, or `tool`
- `.content`: string or array of `{type: "text", text: "..."}` objects
- `.tool_calls`: array of `{function: {name, arguments}}` (assistant messages only)

## Tips

- **Don't read the whole file.** 8000+ events is normal for a long conversation. `tail -200` and filter is almost always enough.
- **User messages have XML wrapping.** Look for `<message sender="smol"...>` inside user content.
- **State events are ~60% of all events.** Always filter them out first.
- **The error event is usually the last or second-to-last event.** Check `tail -5` first to confirm the conversation actually died from max_iterations vs something else.
