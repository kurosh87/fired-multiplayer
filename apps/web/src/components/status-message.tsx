import { CircleAlert, Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { Alert, AlertDescription } from './ui/alert.tsx';
import { cn } from '../lib/utils.ts';

/** Application feedback shares one shadcn surface and live-region policy. */
export function StatusMessage({ children, destructive = false, className }: {
  children: ReactNode;
  destructive?: boolean;
  className?: string;
}) {
  const Icon = destructive ? CircleAlert : Info;
  return <Alert variant={destructive ? 'destructive' : 'default'} role={destructive ? 'alert' : 'status'} className={cn('status-message', className)}>
    <Icon aria-hidden="true" />
    <AlertDescription>{children}</AlertDescription>
  </Alert>;
}
