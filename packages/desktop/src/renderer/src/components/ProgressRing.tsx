import type { ChatProgress, ChatStatus } from '@aim/shared';
import { IconCheck } from './Icons';

interface Props {
  progress?: ChatProgress;
  status?: ChatStatus;
  size?: number;
  stroke?: number;
  /** Show done/total in the centre (only sensible at >= 32px). */
  showLabel?: boolean;
  className?: string;
}

export function ProgressRing({ progress, status, size = 36, stroke = 3, showLabel = true, className = '' }: Props) {
  const total = progress?.total ?? 0;
  const ratio = total === 0 ? 0 : Math.max(0, Math.min(1, progress?.ratio ?? 0));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const complete = total > 0 && progress!.done + progress!.failed === total;
  const failed = complete && (progress?.failed ?? 0) > 0;
  const active = !complete && (status === 'working' || status === 'thinking');
  const classes = ['ring', complete ? 'complete' : '', failed ? 'failed' : '', active ? 'active' : '', className].filter(Boolean).join(' ');
  const label = total === 0 ? '' : `${progress!.done}/${total}`;

  return (
    <div className={classes} style={{ width: size, height: size }} role="img" aria-label={progress?.label || 'No tasks'}>
      <svg width={size} height={size}>
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} />
        <circle
          className="ring-fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - (complete && !failed ? 1 : ratio))}
        />
      </svg>
      {showLabel && size >= 28 ? (
        <div className="ring-label">{complete && !failed ? <IconCheck size={Math.round(size * 0.42)} /> : label}</div>
      ) : null}
    </div>
  );
}
