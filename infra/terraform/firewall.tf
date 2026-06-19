# Egress-only by default. There is NO inbound SSH — the box is provisioned and brought
# up entirely by cloud-init (API-token driven), and logs/status are pushed out to Object
# Storage rather than read over a shell. Break-glass access, if ever needed, is via the
# Linode LISH console (no open port).
#
# Inbound is therefore only the protocol ports clients dial, and only in direct mode:
#   - Phase 1 (transport = direct): BTP 3000 (pay-to-write) + Nostr relay WS 7100 (reads),
#     restricted to the demo client CIDR.
#   - Phase 2 (transport = hs / anyone proxy): NO inbound at all — reached via .anon.
# Loopback-only services (connector admin 9401, townhouse-api 28090, BLS health) are
# never exposed.

resource "linode_firewall" "hub" {
  label           = "${var.label}-fw"
  inbound_policy  = "DROP"
  outbound_policy = "ACCEPT"
  linodes         = [linode_instance.hub.id]
  tags            = ["toon", "hub"]

  # Direct-mode client-facing ports — only created when transport = "direct".
  dynamic "inbound" {
    for_each = var.transport == "direct" ? [1] : []
    content {
      label    = "allow-btp"
      action   = "ACCEPT"
      protocol = "TCP"
      ports    = "3000"
      ipv4     = [var.allowed_client_cidr]
    }
  }

  dynamic "inbound" {
    for_each = var.transport == "direct" ? [1] : []
    content {
      label    = "allow-relay-ws"
      action   = "ACCEPT"
      protocol = "TCP"
      ports    = "7100"
      ipv4     = [var.allowed_client_cidr]
    }
  }
}
