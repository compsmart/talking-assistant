import { type FormEvent, useEffect, useRef, useState } from 'react';

interface Props { open: boolean; caption: string; disabled: boolean; onClose: () => void; onSend: (text: string) => void }

export function ChatTray({ open, caption, disabled, onClose, onSend }: Props) {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 180);
    const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [onClose, open]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || disabled) return;
    onSend(value); setText('');
  };
  return (
    <aside className={`chat-tray ${open ? 'open' : ''}`} aria-hidden={!open}>
      <div className="chat-caption">{caption || 'Ask the live agent to inspect or change the workspace.'}</div>
      <form onSubmit={submit}>
        <input ref={input} value={text} onChange={(e) => setText(e.target.value)} disabled={disabled} maxLength={1000} placeholder={disabled ? 'Coding agent is working…' : 'Message the live agent…'} />
        <button disabled={disabled || !text.trim()} type="submit">Send</button>
        <button className="ghost" type="button" onClick={onClose}>Hide</button>
      </form>
    </aside>
  );
}
