interface RegistryIconProps {
  size?: number;
  className?: string;
}

export default function RegistryIcon({ size = 32, className }: RegistryIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      fill="none"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
    >
      {/* Background — square (zero radius) and white to sit in the light header.
          Kept byte-identical to app/icon.svg, which is the favicon. */}
      <rect width="32" height="32" rx="0" fill="#ffffff" />

      {/* Spoke lines from center to outer nodes */}
      <line x1="16" y1="16" x2="16" y2="5"  stroke="#000000" strokeWidth="1.5" strokeLinecap="round" opacity="0.75" />
      <line x1="16" y1="16" x2="27" y2="16" stroke="#000000" strokeWidth="1.5" strokeLinecap="round" opacity="0.75" />
      <line x1="16" y1="16" x2="16" y2="27" stroke="#000000" strokeWidth="1.5" strokeLinecap="round" opacity="0.75" />
      <line x1="16" y1="16" x2="5"  y2="16" stroke="#000000" strokeWidth="1.5" strokeLinecap="round" opacity="0.75" />
      <line x1="16" y1="16" x2="24" y2="8"  stroke="#000000" strokeWidth="1.2" strokeLinecap="round" opacity="0.55" />
      <line x1="16" y1="16" x2="8"  y2="24" stroke="#000000" strokeWidth="1.2" strokeLinecap="round" opacity="0.55" />

      {/* Outer nodes */}
      <circle cx="16" cy="5"  r="2.2" fill="#000000" />
      <circle cx="27" cy="16" r="2.2" fill="#000000" />
      <circle cx="16" cy="27" r="2.2" fill="#000000" />
      <circle cx="5"  cy="16" r="2.2" fill="#000000" />
      <circle cx="24" cy="8"  r="1.8" fill="#000000" opacity="0.75" />
      <circle cx="8"  cy="24" r="1.8" fill="#000000" opacity="0.75" />

      {/* Central hub ring */}
      <circle cx="16" cy="16" r="5.5" fill="#000000" />
      {/* Inner cut-out — must match the background fill */}
      <circle cx="16" cy="16" r="2.8" fill="#ffffff" />
      {/* Center dot */}
      <circle cx="16" cy="16" r="1.4" fill="#000000" />
    </svg>
  );
}
