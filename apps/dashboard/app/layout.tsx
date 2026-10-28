import { loadConfig } from '@scb/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AutoRefresh } from '../components/AutoRefresh';
import { ModeBanner } from '../components/ModeBanner';
import { ModeSwitcher } from '../components/ModeSwitcher';
import { liveGate } from '../lib/control';
import { paths } from '../lib/paths';
import { liveStats, readHeartbeat } from '../lib/trading';
import { engineState, getView } from '../lib/view';
import './globals.css';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  if (engineState().state.active === 'LIVE') {
    return { title: '🔴 LIVE — Copy Bot', icons: '/favicon-live.svg' };
  }
  return { title: `Copy Bot (${await getView()})`, icons: '/favicon.svg' };
}

const dailyLossLimit = () => {
  try {
    return loadConfig(paths.rules).live.daily_loss_limit_usd;
  } catch {
    return 0; // fail closed: an unreadable rules.yaml shows no loss budget left
  }
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const view = await getView();
  const { state, error } = engineState();
  const heartbeat = readHeartbeat(paths.view(state.active));
  const live = state.active === 'LIVE' ? liveStats(paths.view('LIVE'), dailyLossLimit()) : null;
  return (
    <html lang="en">
      <body>
        <ModeBanner engine={state} error={error} heartbeat={heartbeat} live={live} view={view} />
        <header>
          <nav>
            <Link href="/">Overview</Link>
            <Link href="/history">Mode history</Link>
            <Link href="/settings">Settings</Link>
          </nav>
          <ModeSwitcher view={view} engine={state} gate={liveGate()} />
        </header>
        <main>{children}</main>
        <AutoRefresh />
      </body>
    </html>
  );
}
