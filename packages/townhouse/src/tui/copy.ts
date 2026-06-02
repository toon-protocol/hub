export const COPY = {
  heroEarly: `you're early`,
  heroEarlyRotation: [
    `you're early`,
    `warming up`,
    `first packet en route`,
  ] as const,
  loading: `Fetching earnings…`,
  qualifierPrefix: `MONTH $0.00`,
  qualifierEventsWords: `events relayed`,
  qualifierEvents: (n: number) => `${n} events relayed`,
  banners: {
    connectorUnavailable: `Connector not reachable — showing last known values. Retrying in 2s.`,
    fetchFailed: `Last refresh failed — retrying.`,
    // Shown only before the first successful fetch — a fresh node whose API is
    // still warming up should read as "starting", not "failed".
    startingUp: `Starting up — connecting to your node…`,
  },
  apex: {
    routingPrefix: `↳ apex routing: `,
    routingEmpty: `(enable mill to route)`,
  },
  peerTable: {
    empty: `no peers yet — in a new terminal: townhouse node add town`,
  },
  activityTicker: {
    prefix: `recent: `,
    empty: `no settlements yet — press [a] when activity arrives`,
    keybind: ` [a] activity`,
  },
  activityOverlay: {
    titlePrefix: `Activity — last `,
    emptyHint: `(no activity yet)`,
    scrollHint: `j/k to scroll · q to close`,
    scrollHintEmpty: `q to close`,
    directionInbound: `in`,
    directionOutbound: `out`,
    directionUnknown: `?`,
  },
} as const;
