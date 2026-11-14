export function Cover({ url, title, className = '' }: { url: string | null; title: string; className?: string }) {
  return url ? (
    <img src={url} alt={`Cover of ${title}`} className={`block aspect-square bg-ink-3 object-cover ${className}`} loading="lazy" />
  ) : (
    <div className={`aspect-square bg-ink-3 ${className}`} />
  );
}
