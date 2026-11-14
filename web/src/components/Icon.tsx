const PATHS: Record<string, string> = {
  home: 'M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  search: 'M11 4a7 7 0 1 0 4.4 12.4l4.1 4.1 1.4-1.4-4.1-4.1A7 7 0 0 0 11 4zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10z',
  play: 'M8 5.1v13.8a.6.6 0 0 0 .9.5l11-6.9a.6.6 0 0 0 0-1L8.9 4.6a.6.6 0 0 0-.9.5z',
  pause: 'M7 5h3.5v14H7zm6.5 0H17v14h-3.5z',
  next: 'M6 5.3v13.4a.5.5 0 0 0 .8.4L16 13v6h2V5h-2v6L6.8 4.9a.5.5 0 0 0-.8.4z',
  prev: 'M18 5.3v13.4a.5.5 0 0 1-.8.4L8 13v6H6V5h2v6l9.2-6.1a.5.5 0 0 1 .8.4z',
  shuffle: 'M16 4l4 3.5L16 11V8.5h-1.6a3 3 0 0 0-2.4 1.2l-5 6.7A5 5 0 0 1 3 18H2v-2h1a3 3 0 0 0 2.4-1.2l5-6.7a5 5 0 0 1 4-2.1H16zM2 6h1a5 5 0 0 1 4 2l1.1 1.5-1.2 1.7L5.4 9.2A3 3 0 0 0 3 8H2zm14 7l4 3.5-4 3.5v-2.5h-1.6a5 5 0 0 1-4-2l-.9-1.2 1.2-1.7 1.3 1.7a3 3 0 0 0 2.4 1.2H16z',
  repeat: 'M17 2l4 4-4 4V7H7a2 2 0 0 0-2 2v2H3V9a4 4 0 0 1 4-4h10zM7 22l-4-4 4-4v3h10a2 2 0 0 0 2-2v-2h2v2a4 4 0 0 1-4 4H7z',
  volume: 'M4 9.5v5h3.5L12 19V5L7.5 9.5zM14.5 8.3v7.4a4.5 4.5 0 0 0 0-7.4zm0-4.2v2.1a7 7 0 0 1 0 11.6v2.1a9 9 0 0 0 0-15.8z',
  bug: 'M12 3a4 4 0 0 0-4 4v.3A5 5 0 0 0 6.3 9L4 7.6 3 9.3l2.6 1.5a6 6 0 0 0-.1 1.2H3v2h2.5c.1.6.2 1.1.4 1.6L3 17.3 4 19l2.8-1.6A6.5 6.5 0 0 0 12 20a6.5 6.5 0 0 0 5.2-2.6L20 19l1-1.7-2.9-1.7c.2-.5.3-1 .4-1.6H21v-2h-2.5a6 6 0 0 0-.1-1.2L21 9.3l-1-1.7L17.7 9A5 5 0 0 0 16 7.3V7a4 4 0 0 0-4-4zm0 2a2 2 0 0 1 2 2H10a2 2 0 0 1 2-2zm-1 5h2v8h-2z',
  chevron: 'M6.4 8.6 12 14.2l5.6-5.6L19 10l-7 7-7-7z',
  close: 'M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z',
  share: 'M18 3a3 3 0 1 1-2.2 5l-6.9 3.5a3 3 0 0 1 0 1l6.9 3.5A3 3 0 1 1 15 18v-.4L8.1 14A3 3 0 1 1 8 10l7-3.6V6a3 3 0 0 1 3-3z',
  monitor: 'M3 4h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-7v2h3v2H7v-2h3v-2H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v10h16V6zm2 7 3-3 2 2 4-4 2 2-6 6-2-2-2 2z',
  headphones: 'M12 3a9 9 0 0 0-9 9v7a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2H5v-1a7 7 0 0 1 14 0v1h-1a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-7a9 9 0 0 0-9-9z',
  lab: 'M4 4h7v7H4zm9 0h7v7h-7zM4 13h7v7H4zm9 0h7v7h-7z',
  user: 'M12 3a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zm0 2a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM4 21a8 8 0 0 1 16 0h-2a6 6 0 0 0-12 0z',
  earnings: 'M4 20h16v2H4zM5 12h3v6H5zm5.5-4h3v10h-3zM16 4h3v14h-3z',
  phone: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm0 3v14h8V5zm3 15h2v1h-2z',
  card: 'M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1 2v2h16V7zm0 5v5h16v-5zm2 2h5v1.5H6z',
  heart: 'M12 21s-7.5-4.7-10-9.2C.5 8.8 2 5 5.6 4.5 8 4.2 10.4 5.3 12 7.4c1.6-2.1 4-3.2 6.4-2.9C22 5 23.5 8.8 22 11.8 19.5 16.3 12 21 12 21z',
  'heart-outline': 'M12 21s-7.5-4.7-10-9.2C.5 8.8 2 5 5.6 4.5 8 4.2 10.4 5.3 12 7.4c1.6-2.1 4-3.2 6.4-2.9C22 5 23.5 8.8 22 11.8 19.5 16.3 12 21 12 21zm0-2.4c2.4-1.6 6.5-4.8 8.2-7.8.9-1.8.1-4.1-2-4.3-1.9-.2-3.7 1-4.8 2.8L12 11.4l-1.4-2.1C9.5 7.5 7.7 6.3 5.8 6.5c-2.1.2-2.9 2.5-2 4.3 1.7 3 5.8 6.2 8.2 7.8z',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z',
  library: 'M4 4h2v16H4zm4 0h2v16H8zm5.2.4 1.9-.6 5 15.3-1.9.6z',
  catalog: 'M4 3h13l3 3v15H4zm2 2v14h12V7h-3V5zm6 2h2v5.5a2.5 2.5 0 1 1-2-2.4z',
  check: 'M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.5 8l-1.4-1.4z',
  logout: 'M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5v-2H6V6h4zm5.6 3.4L14.2 8.8l2.2 2.2H9v2h7.4l-2.2 2.2 1.4 1.4L20.2 12z',
};

export function Icon({ name, size = 20, className = '' }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" className={className} aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

export function Equalizer({ animate = true }: { animate?: boolean }) {
  return (
    <span className="flex h-3.5 items-end gap-[2px]" aria-hidden="true">
      {[0, 0.2, 0.4].map((delay) => (
        <span
          key={delay}
          className={`w-[3px] rounded-sm bg-accent ${animate ? 'eq-bar' : ''}`}
          style={{ height: animate ? '100%' : '40%', animationDelay: `${delay}s` }}
        />
      ))}
    </span>
  );
}
