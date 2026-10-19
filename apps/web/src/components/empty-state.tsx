import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './ui/empty.tsx';
import { cn } from '../lib/utils.ts';

/** Shared application composition of the shadcn Empty primitive. */
export function EmptyState({ icon: Icon, title, children, action, compact = false, className }: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return <Empty className={cn('app-empty', compact ? 'app-empty-compact' : 'border border-solid bg-card text-card-foreground shadow-sm', className)}>
    <EmptyHeader>
      <EmptyMedia variant="icon"><Icon aria-hidden="true" /></EmptyMedia>
      <EmptyTitle><h2>{title}</h2></EmptyTitle>
      <EmptyDescription>{children}</EmptyDescription>
    </EmptyHeader>
    {action && <EmptyContent>{action}</EmptyContent>}
  </Empty>;
}
