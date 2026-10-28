import type { Mode } from '@scb/shared';
import type { ReactNode } from 'react';

export const ModeTag = ({ view }: { view: Mode }) => (
  <span className={`tag tag-${view}`}>{view}</span>
);

export function Card({
  title,
  view,
  children,
}: {
  title: string;
  view: Mode;
  children: ReactNode;
}) {
  return (
    <section className="card">
      <h2>
        {title} <ModeTag view={view} />
      </h2>
      {children}
    </section>
  );
}
