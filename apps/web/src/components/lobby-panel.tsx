import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './ui/card.tsx';
import { cn } from '../lib/utils.ts';

/** Shared panel anatomy for parties, trainer discovery and invitations. */
export function LobbyPanel({ title, description, icon: Icon, status, headingLevel = 2, className, children, footer }: {
  title: string;
  description?: ReactNode;
  icon: LucideIcon;
  status?: ReactNode;
  headingLevel?: 2 | 3;
  className?: string;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  return <Card className={cn('lobby-panel gap-5', className)}>
    <CardHeader>
      <CardTitle className="lobby-panel-title"><Icon aria-hidden="true" /><Heading>{title}</Heading></CardTitle>
      {description && <CardDescription>{description}</CardDescription>}
      {status && <CardAction>{status}</CardAction>}
    </CardHeader>
    {children && <CardContent>{children}</CardContent>}
    {footer && <CardFooter className="lobby-panel-footer">{footer}</CardFooter>}
  </Card>;
}
