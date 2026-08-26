// Simple single-line icons (not the official brand assets — replace
// with official SVGs if needed). SOCIAL_LINKS below contains placeholder
// URLs — swap in the DAO's real accounts.

export const SOCIAL_LINKS = [
  { key: "x", label: "X (Twitter)", url: "https://x.com/hrpdao", Icon: IconX },
  { key: "telegram", label: "Telegram", url: "https://t.me/hrpdao", Icon: IconTelegram },
  { key: "whatsapp", label: "WhatsApp", url: "https://wa.me/000000000000", Icon: IconWhatsApp },
  { key: "instagram", label: "Instagram", url: "https://instagram.com/hrpdao", Icon: IconInstagram },
  { key: "facebook", label: "Facebook", url: "https://facebook.com/hrpdao", Icon: IconFacebook },
  { key: "threads", label: "Threads", url: "https://threads.net/@hrpdao", Icon: IconThreads },
  { key: "discord", label: "Discord", url: "https://discord.gg/hrpdao", Icon: IconDiscord },
];

function IconX({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.9 2H22l-7.6 8.7L23.3 22h-6.9l-5.4-6.6L4.8 22H1.7l8.1-9.3L1 2h7l4.9 6.1L18.9 2Zm-1.2 18.2h1.9L7.4 3.7H5.4l12.3 16.5Z" />
    </svg>
  );
}
function IconTelegram({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M21.8 3.5 2.9 10.9c-1.2.5-1.2 1.2-.2 1.5l4.8 1.5 1.8 5.6c.2.6.4.8.9.8s.7-.2 1-.5l2.3-2.2 4.7 3.5c.9.5 1.5.2 1.7-.8l3.1-14.6c.3-1.3-.4-1.8-1.2-1.2ZM8.3 13.5l9.5-6c.4-.3.8-.1.5.2l-8 7.4-.3 3.2-1.7-4.8Z" />
    </svg>
  );
}
function IconWhatsApp({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M17 14.2c-.3-.1-1.6-.8-1.9-.9-.3-.1-.4-.1-.6.1-.2.3-.7.9-.8 1-.2.2-.3.2-.5.1-.3-.1-1.2-.4-2.2-1.4-.8-.7-1.4-1.6-1.5-1.9-.2-.3 0-.5.1-.6.1-.1.3-.3.4-.5.1-.1.2-.3.2-.4.1-.2 0-.3 0-.5-.1-.1-.6-1.5-.8-2-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.5.1-.7.3-.3.3-1 1-1 2.4s1 2.8 1.2 3c.1.2 2 3 4.8 4.3.7.3 1.2.5 1.6.6.7.2 1.3.2 1.8.1.6-.1 1.6-.7 1.9-1.3.2-.6.2-1.1.2-1.3-.1-.1-.3-.2-.6-.3ZM12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2c-1.6 0-3.1-.4-4.4-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Z" />
    </svg>
  );
}
function IconInstagram({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.2" cy="6.8" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}
function IconFacebook({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M13.5 22v-8.5h2.9l.4-3.4h-3.3V7.9c0-1 .3-1.6 1.7-1.6h1.8V3.3c-.3 0-1.4-.1-2.6-.1-2.6 0-4.4 1.6-4.4 4.5v2.4H7v3.4h2.9V22h3.6Z" />
    </svg>
  );
}
function IconThreads({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M12 21c-4.5 0-7.5-2.7-7.5-8.5S7.3 3 12 3c3.6 0 6 1.7 6.7 4.5" strokeLinecap="round" />
      <path d="M9.5 12c0-2 1.3-3.3 3.3-3.3 2.3 0 3.7 1.6 3.7 4 0 3.2-2 5.3-5 5.3-2.2 0-3.5-1.1-3.5-2.6 0-1.7 1.7-2.6 4.2-2.6 1.6 0 2.9.3 3.8.8" strokeLinecap="round" />
    </svg>
  );
}
function IconDiscord({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M20 6.5a17 17 0 0 0-4.2-1.3l-.2.4c1.5.4 2.4.9 3.3 1.6-1.4-.7-2.8-1.2-4.9-1.2s-3.5.5-4.9 1.2c.9-.7 2-1.3 3.3-1.6l-.2-.4A17 17 0 0 0 8 6.5C5.9 9.5 5.3 12.4 5.5 15.3c1.6 1.2 3.2 1.9 4.7 2.3l.6-1c-.8-.3-1.6-.7-2.3-1.2l.4-.3c1.5.7 3.2 1.1 5.1 1.1s3.6-.4 5.1-1.1l.4.3c-.7.5-1.5.9-2.3 1.2l.6 1c1.5-.4 3.1-1.1 4.7-2.3.3-3.4-.6-6.3-2.5-8.8ZM10 13.9c-.7 0-1.3-.7-1.3-1.5s.6-1.5 1.3-1.5 1.3.7 1.3 1.5-.6 1.5-1.3 1.5Zm4.9 0c-.7 0-1.3-.7-1.3-1.5s.6-1.5 1.3-1.5 1.3.7 1.3 1.5-.6 1.5-1.3 1.5Z" />
    </svg>
  );
}

export function SocialLinksRow({ size = 16, className = "" }) {
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      {SOCIAL_LINKS.map(({ key, label, url, Icon }) => (
        <a
          key={key}
          href={url}
          target="_blank"
          rel="noreferrer"
          aria-label={label}
          title={label}
          className="text-parchmentDim hover:text-verdigrisBright transition-colors"
        >
          <Icon size={size} />
        </a>
      ))}
    </div>
  );
}
