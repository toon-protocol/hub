import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useEarnings } from './use-earnings.js';
import { useActivityBuffer, MAX_BUFFER_SIZE } from './use-activity-buffer.js';
import { HeroBand } from './components/HeroBand.js';
import { Banner } from './components/Banner.js';
import { ApexStripSlot } from './components/ApexStripSlot.js';
import { PeerTableSlot } from './components/PeerTableSlot.js';
import { FooterSlot } from './components/FooterSlot.js';
import { Badge } from './components/Badge.js';
import { ActivityOverlay } from './components/ActivityOverlay.js';
import { COPY } from './copy.js';

export interface AppProps {
  apiUrl?: string;
  refreshIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

export default function App(props: AppProps): React.ReactElement {
  const state = useEarnings(props);
  const recentClaims = state.phase !== 'loading' ? state.data.recentClaims : undefined;
  const buffer = useActivityBuffer(recentClaims);
  const [overlayOpen, setOverlayOpen] = useState(false);

  useInput(
    (input, key) => {
      if (key.ctrl || key.meta) return;
      if (input === 'a' || input === 'A') setOverlayOpen(true);
    },
    { isActive: !overlayOpen && state.phase !== 'loading' },
  );

  if (state.phase === 'loading') {
    return <Text>{COPY.loading}</Text>;
  }

  if (overlayOpen) {
    return <ActivityOverlay claims={buffer} onClose={() => setOverlayOpen(false)} maxBufferSize={MAX_BUFFER_SIZE} />;
  }

  const { data } = state;
  const bannerKey = state.phase === 'stale' ? state.bannerKey : null;

  return (
    <Box flexDirection="column">
      <HeroBand apex={data.apex} peers={data.peers} eventsRelayed={data.eventsRelayed} />
      <Badge apex={data.apex} peers={data.peers} uptimeSeconds={data.uptimeSeconds} />
      <Banner bannerKey={bannerKey} />
      <ApexStripSlot apex={data.apex} peers={data.peers} />
      <PeerTableSlot peers={data.peers} />
      <FooterSlot recentClaims={data.recentClaims} />
    </Box>
  );
}
