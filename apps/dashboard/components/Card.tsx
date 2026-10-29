import type { Mode } from '@scb/shared';
import type { CSSProperties, ReactNode } from 'react';

export const ModeTag = ({ view }: { view: Mode }) => (
  <span className={`tag tag-${view}`} title={`${view} data`}>
    {view}
  </span>
);

/** A panel. Every panel carries the data-view stamp so no number is shown without its view. */
export function Card({
  title,
  view,
  aside,
  order,
  children,
}: {
  title: string;
  view: Mode;
  aside?: ReactNode;
  order?: number;
  children: ReactNode;
}) {
  const style: CSSProperties | undefined = order === undefined ? undefined : { order };
  return (
    <section className={`card v-${view}`} style={style}>
      <h2>
        <span>{title}</span>
        {aside && <small>{aside}</small>}
        <ModeTag view={view} />
      </h2>
      {children}
    </section>
  );
}
