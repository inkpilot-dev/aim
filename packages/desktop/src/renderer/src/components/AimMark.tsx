/** The A.I.M. brand mark: the teal pointer from the app icon. */
export function AimMark({ size = 20, className = '' }: { size?: number; className?: string }) {
  return (
    <span className={`aim-mark ${className}`} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 24 24">
        <path d="M5 3.2 19.4 13.1l-6.1 1.1 3.3 6.3-2.6 1.3-3.3-6.3L5.9 19.9Z" fill="currentColor" stroke="rgba(255,255,255,0.85)" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
