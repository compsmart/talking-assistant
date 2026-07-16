import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function IconButton({ active, label, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; label: string; children: ReactNode }) {
  return <button className={`icon-button ${active ? 'active' : ''}`} aria-label={label} title={label} {...props}>{children}</button>;
}
