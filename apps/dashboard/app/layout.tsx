import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AutoRefresh } from '../components/AutoRefresh';
import { ModeBanner } from '../components/ModeBanner';
import { ViewSwitcher } from '../components/ViewSwitcher';
import { liveGate } from '../lib/control';
import { paths } from '../lib/paths';
import { readRules } from '../lib/rules';
import { liveStats, readEngineHealth, readHeartbeat } from '../lib/trading';
import { engineState, getTheme, getView } from '../lib/view';
import './globals.css';

export const dynamic = 'force-dynamic';

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export async function generateMetadata(): Promise<Metadata> {
  if (engineState().state.active === 'LIVE') {
    return { title: '🔴 LIVE — Copy Bot', icons: '/favicon-live.svg' };
  }
  return { title: `Copy Bot (${await getView()})`, icons: '/favicon.svg' };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [view, theme] = await Promise.all([getView(), getTheme()]);
  const { state, error } = engineState();
  const rules = readRules();
  const active = paths.view(state.active);
  // Fail closed: an unreadable rules.yaml shows no loss budget left.
  const live =
    state.active === 'LIVE'
      ? liveStats(paths.view('LIVE'), rules?.live.daily_loss_limit_usd ?? 0)
      : null;
  const limits = rules && {
    heartbeatMs: rules.scout.heartbeat_interval_ms,
    livenessS: rules.scout.liveness_timeout_s,
  };
  return (
    <html lang="en" data-theme={theme}>
      <body className={state.active === 'LIVE' ? 'engine-live' : undefined}>
        <ModeBanner
          engine={state}
          error={error}
          heartbeat={readHeartbeat(active)}
          health={readEngineHealth(active)}
          limits={limits}
          live={live}
          view={view}
          gate={liveGate()}
        />
        <header className="bar">
          <span className="brand">smart-copy-bot</span>
          <nav>
            <Link href="/">Overview</Link>
            <Link href="/history">Mode history</Link>
            <Link href="/settings">Rules</Link>
          </nav>
          <ViewSwitcher view={view} theme={theme} />
        </header>
        <main>{children}</main>
        <AutoRefresh />
      </body>
    </html>
  );
}
