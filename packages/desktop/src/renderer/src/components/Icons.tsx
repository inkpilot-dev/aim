import type { ReactNode, SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function make(children: ReactNode, displayName: string) {
  const C = ({ size = 16, ...rest }: P) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
  C.displayName = displayName;
  return C;
}

export const IconPlus = make(<path d="M12 5v14M5 12h14" />, 'IconPlus');
export const IconSearch = make(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </>,
  'IconSearch',
);
export const IconChat = make(<path d="M21 12a8 8 0 0 1-8 8H6l-3 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z" />, 'IconChat');
export const IconTarget = make(
  <>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" />
    <circle cx="12" cy="12" r="1" />
  </>,
  'IconTarget',
);
export const IconBrain = make(
  <>
    <path d="M9.5 3a3 3 0 0 0-3 3v.3A3.5 3.5 0 0 0 4 9.5c0 .7.2 1.3.5 1.9A3.5 3.5 0 0 0 5 17a3 3 0 0 0 4.5 2.6V3Z" />
    <path d="M14.5 3a3 3 0 0 1 3 3v.3A3.5 3.5 0 0 1 20 9.5c0 .7-.2 1.3-.5 1.9A3.5 3.5 0 0 1 19 17a3 3 0 0 1-4.5 2.6V3Z" />
  </>,
  'IconBrain',
);
export const IconSettings = make(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </>,
  'IconSettings',
);
export const IconPin = make(<path d="M12 17v5M9 3h6l-1 7 3 2v2H7v-2l3-2-1-7Z" />, 'IconPin');
export const IconArchive = make(
  <>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
  </>,
  'IconArchive',
);
export const IconTrash = make(<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />, 'IconTrash');
export const IconEdit = make(<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />, 'IconEdit');
export const IconCheck = make(<path d="m5 12 5 5L20 7" />, 'IconCheck');
export const IconX = make(<path d="M18 6 6 18M6 6l12 12" />, 'IconX');
export const IconChevronRight = make(<path d="m9 6 6 6-6 6" />, 'IconChevronRight');
export const IconChevronDown = make(<path d="m6 9 6 6 6-6" />, 'IconChevronDown');
export const IconCopy = make(
  <>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </>,
  'IconCopy',
);
export const IconCamera = make(
  <>
    <path d="M4 8h3l2-3h6l2 3h3v12H4Z" />
    <circle cx="12" cy="13" r="3.5" />
  </>,
  'IconCamera',
);
export const IconImage = make(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="10" r="1.5" />
    <path d="m21 16-5-5-9 9" />
  </>,
  'IconImage',
);
export const IconSend = make(<path d="M12 19V5M5 12l7-7 7 7" />, 'IconSend');
export const IconStop = make(<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />, 'IconStop');
export const IconArrowDown = make(<path d="M12 5v14M5 12l7 7 7-7" />, 'IconArrowDown');
export const IconMonitor = make(
  <>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </>,
  'IconMonitor',
);
export const IconGlobe = make(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  </>,
  'IconGlobe',
);
export const IconMouse = make(
  <>
    <rect x="6" y="3" width="12" height="18" rx="6" />
    <path d="M12 7v4" />
  </>,
  'IconMouse',
);
export const IconTerminal = make(<path d="m5 7 5 5-5 5M12 17h7" />, 'IconTerminal');
export const IconFile = make(
  <>
    <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Z" />
    <path d="M14 3v5h5" />
  </>,
  'IconFile',
);
export const IconUsers = make(
  <>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6" />
  </>,
  'IconUsers',
);
export const IconWrench = make(
  <>
    <path d="M14.7 6.3a4 4 0 0 0 5 5L13 18a2.5 2.5 0 0 1-3.5-3.5l6.7-6.7Z" />
    <path d="m3 21 6-6" />
  </>,
  'IconWrench',
);
export const IconMinus = make(<path d="M5 12h14" />, 'IconMinus');
export const IconSquare = make(<rect x="5" y="5" width="14" height="14" rx="1" />, 'IconSquare');
export const IconAlert = make(
  <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />,
  'IconAlert',
);
export const IconInfo = make(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 16v-4M12 8h.01" />
  </>,
  'IconInfo',
);
export const IconClock = make(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </>,
  'IconClock',
);
export const IconPlay = make(<path d="M7 4.5v15l12-7.5Z" />, 'IconPlay');
export const IconRefresh = make(<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M3 21v-5h5" />, 'IconRefresh');
export const IconEye = make(
  <>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
  </>,
  'IconEye',
);
export const IconCpu = make(
  <>
    <rect x="5" y="5" width="14" height="14" rx="2" />
    <rect x="9" y="9" width="6" height="6" />
    <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
  </>,
  'IconCpu',
);
export const IconWindow = make(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18" />
  </>,
  'IconWindow',
);
export const IconMemory = make(
  <>
    <path d="M4 7a8 3 0 0 1 16 0v10a8 3 0 0 1-16 0Z" />
    <path d="M4 7a8 3 0 0 0 16 0M4 12a8 3 0 0 0 16 0" />
  </>,
  'IconMemory',
);
export const IconList = make(<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />, 'IconList');
export const IconPanelLeft = make(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </>,
  'IconPanelLeft',
);
export const IconMore = make(
  <>
    <circle cx="5" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="19" cy="12" r="1.2" fill="currentColor" />
  </>,
  'IconMore',
);
export const IconQuestion = make(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01" />
  </>,
  'IconQuestion',
);
export const IconExternal = make(<path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />, 'IconExternal');
export const IconSparkle = make(<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.8 2.8M14.9 14.9l2.8 2.8M6.3 17.7l2.8-2.8M14.9 9.1l2.8-2.8" />, 'IconSparkle');
export const IconFolder = make(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />, 'IconFolder');
export const IconArrowUp = make(<path d="M12 19V5M5 12l7-7 7 7" />, 'IconArrowUp');
export const IconBook = make(<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5V5a2 2 0 0 1 2-2h14v14H6.5A2.5 2.5 0 0 0 4 19.5Z" />, 'IconBook');
export const IconDownload = make(<path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />, 'IconDownload');
