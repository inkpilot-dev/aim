import { useState } from 'react';
import type { PendingQuestion } from '../state/reducer';
import { IconQuestion } from './Icons';

export function AskUserCard({ q, onAnswer }: { q: PendingQuestion; onAnswer: (answer: string) => void }) {
  const [text, setText] = useState('');
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onAnswer(t);
    setText('');
  };
  return (
    <div className="ask-card">
      <div className="ask-head">
        <IconQuestion size={14} />
        A.I.M. needs your input
      </div>
      <div className="ask-q">{q.question}</div>
      {q.options?.length ? (
        <div className="ask-options">
          {q.options.map((o) => (
            <button key={o} className="btn" onClick={() => onAnswer(o)}>
              {o}
            </button>
          ))}
        </div>
      ) : null}
      <div className="ask-answer">
        <input
          className="input selectable"
          placeholder="Type an answer"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
        <button className="btn primary" onClick={submit} disabled={!text.trim()}>
          Answer
        </button>
      </div>
    </div>
  );
}
