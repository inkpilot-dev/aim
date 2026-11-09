import { IconMinus, IconSquare, IconX } from './Icons';

/**
 * Window chrome. The top strip is a drag region; on Windows the native overlay buttons live in the
 * top-right corner (reserved by padding in the top bar), elsewhere we draw our own.
 */
export function TitleBar() {
  const isWin = (window.aim?.platform ?? 'win32') === 'win32';
  return (
    <div className="drag-strip" aria-hidden="true">
      {isWin ? null : (
        <div className="win-controls">
          <button className="win-btn" onClick={() => window.aim.minimize()} aria-label="Minimize" tabIndex={-1}>
            <IconMinus size={14} />
          </button>
          <button className="win-btn" onClick={() => window.aim.maximize()} aria-label="Maximize" tabIndex={-1}>
            <IconSquare size={11} />
          </button>
          <button className="win-btn close" onClick={() => window.aim.close()} aria-label="Close" tabIndex={-1}>
            <IconX size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
