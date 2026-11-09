import { useCallback, useEffect, useRef, useState } from 'react';
import type { Attachment, ChatStatus } from '@aim/shared';
import { IconArrowUp, IconCamera, IconChevronDown, IconImage, IconPlus, IconStop, IconX } from './Icons';

interface Props {
  status: ChatStatus;
  variant?: 'home' | 'docked';
  disabled?: boolean;
  modelLabel?: string;
  onModelClick?: () => void;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  onError: (msg: string) => void;
  autoFocus?: boolean;
  draftKey?: string;
}

export function Composer({ status, variant = 'docked', disabled, modelLabel, onModelClick, onSend, onStop, onError, autoFocus, draftKey }: Props) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [capturing, setCapturing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const busy = status === 'thinking' || status === 'working';

  const resize = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(260, el.scrollHeight)}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [text, resize]);

  useEffect(() => {
    setText('');
    setAttachments([]);
    if (autoFocus) taRef.current?.focus();
  }, [draftKey, autoFocus]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const submit = () => {
    const t = text.trim();
    if (!t && attachments.length === 0) return;
    if (busy || disabled) return;
    onSend(t || 'See attached.', attachments);
    setText('');
    setAttachments([]);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const captureScreenshot = async () => {
    setMenuOpen(false);
    setCapturing(true);
    try {
      const shot = await window.aim.captureScreenshot();
      setAttachments((a) => [...a, shot]);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Screenshot failed');
    } finally {
      setCapturing(false);
      taRef.current?.focus();
    }
  };

  const onFiles = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach((f) => {
      if (!f.type.startsWith('image/')) {
        onError(`${f.name}: only images can be attached here.`);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? '');
        const base64 = result.split(',')[1] ?? '';
        setAttachments((a) => [...a, { kind: 'image', name: f.name, mediaType: f.type, dataBase64: base64 }]);
      };
      reader.readAsDataURL(f);
    });
    if (fileRef.current) fileRef.current.value = '';
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items).filter((i) => i.type.startsWith('image/'));
    if (!items.length) return;
    const dt = new DataTransfer();
    items.forEach((i) => {
      const f = i.getAsFile();
      if (f) dt.items.add(f);
    });
    onFiles(dt.files);
  };

  const placeholder = variant === 'home' ? 'How can I help you today?' : busy ? 'A.I.M. is working — type to queue a follow-up' : 'Reply to A.I.M.…';
  const canSend = !disabled && (text.trim().length > 0 || attachments.length > 0);

  return (
    <div className={`composer-wrap is-${variant}`}>
      <div className="composer">
        {attachments.length ? (
          <div className="attachments">
            {attachments.map((a, i) => (
              <span key={i} className="att-chip">
                {a.dataBase64 ? <img src={`data:${a.mediaType};base64,${a.dataBase64}`} alt="" /> : null}
                <span className="att-name truncate">{a.kind === 'screenshot' ? 'Screenshot' : a.name}</span>
                <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => setAttachments((l) => l.filter((_, j) => j !== i))} aria-label="Remove attachment">
                  <IconX size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && busy) {
              e.preventDefault();
              onStop();
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={disabled}
          aria-label="Message"
        />
        <div className="cp-bar">
          <div style={{ position: 'relative' }} ref={menuRef}>
            <button className="cp-btn round" onClick={() => setMenuOpen((o) => !o)} disabled={disabled || capturing} aria-label="Attach" aria-haspopup="menu" aria-expanded={menuOpen}>
              {capturing ? <span className="spinner" /> : <IconPlus size={16} />}
            </button>
            {menuOpen ? (
              <div className="popover cp-menu" role="menu" style={{ position: 'absolute' }}>
                <button onClick={() => void captureScreenshot()}>
                  <IconCamera size={15} /> Take a screenshot
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    fileRef.current?.click();
                  }}
                >
                  <IconImage size={15} /> Upload an image
                </button>
              </div>
            ) : null}
          </div>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => onFiles(e.target.files)} />
          <div className="cp-right">
            {modelLabel ? (
              <button className="cp-model" onClick={onModelClick} title="Model settings">
                {modelLabel}
                <IconChevronDown size={13} />
              </button>
            ) : null}
            {busy ? (
              <button className="cp-send stop" onClick={onStop} aria-label="Stop" data-tip="Stop (Esc)">
                <IconStop size={13} />
              </button>
            ) : (
              <button className="cp-send" onClick={submit} disabled={!canSend} aria-label="Send">
                <IconArrowUp size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
      {variant === 'docked' ? <div className="composer-foot">A.I.M. can act on your screen and browser. It never performs payments.</div> : null}
    </div>
  );
}
