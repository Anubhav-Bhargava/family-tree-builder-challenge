import { useState, useRef, useEffect } from "react";
import { fetchSessionHistory, sendChatMessage } from "../api";

// One session per browser tab. It survives a refresh, so the chat can be restored.
function tabSessionId() {
  let id = sessionStorage.getItem("sessionId");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("sessionId", id);
  }
  return id;
}

export default function ChatPanel({ onGraphMightHaveChanged }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);
  const sessionId = useRef(tabSessionId()).current;
  const failed = useRef(null); // { messageId, text } of the last message that errored

  // The server owns the conversation: restore it after a refresh.
  useEffect(() => {
    fetchSessionHistory(sessionId)
      .then(({ messages: history }) =>
        setMessages(
          history.flatMap((m) => [
            { role: "user", content: m.userText },
            { role: "assistant", content: m.replyText },
          ]),
        ),
      )
      .catch((err) => console.error(err));
  }, [sessionId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  async function handleSubmit(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || isSending) return;

    // Resending the text that just failed reuses its messageId, so the server can't run it twice.
    const messageId = failed.current?.text === text ? failed.current.messageId : crypto.randomUUID();
    const nextMessages = [...messages, { role: "user", content: text }];
    setMessages(nextMessages);
    setInput("");
    setIsSending(true);
    setError(null);

    try {
      const { reply } = await sendChatMessage({ sessionId, messageId, text });
      failed.current = null;
      setMessages([...nextMessages, { role: "assistant", content: reply }]);
      // The graph endpoint is polled independently, but nudging a refresh
      // right after a turn keeps the visualization feeling responsive once
      // the candidate's tool calls start actually mutating state.
      onGraphMightHaveChanged?.();
    } catch (err) {
      console.error(err);
      failed.current = { messageId, text };
      setMessages(messages);
      setInput(text);
      setError("Something went wrong talking to the model. Press Send to try again.");
    } finally {
      setIsSending(false);
    }
  }

  return (
    <div className="chat-panel">
      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            Describe your family — e.g. "My name is Alex. My parents are Sam
            and Jordan. I have a brother named John."
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-message chat-message--${m.role}`}>
            <span className="chat-message__role">
              {m.role === "user" ? "You" : "Assistant"}
            </span>
            <p>{m.content}</p>
          </div>
        ))}
        {isSending && (
          <div className="chat-message chat-message--assistant chat-message--pending">
            <span className="chat-message__role">Assistant</span>
            <p>…</p>
          </div>
        )}
      </div>

      {error && <div className="chat-error">{error}</div>}

      <form className="chat-input" onSubmit={handleSubmit}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Tell it about your family..."
          disabled={isSending}
        />
        <button type="submit" disabled={isSending || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
