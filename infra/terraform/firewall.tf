# Egress-only by default. Inbound is least-privilege:
#   - SSH (22) only from the CI/operator CIDR.
#   - Phase 1 (transport = direct): the two client-facing apex ports, restricted to the
#     demo client CIDR — BTP 3000 (pay-to-write) and Nostr relay WS 7100 (free reads).
#   - Phase 2 (transport = hs / anyone proxy): NO protocol inbound — the apex is reached
#     via its .anon hidden service over the onion network.
# Loopback-only services (connector admin 9401, townhouse-api 28090, BLS health) are
# never exposed; reach them with an SSH tunnel.

resource "linode_firewall" "hub" {
  label           = "${var.label}-fw"
  inbound_policy  = "DROP"
  outbound_policy = "ACCEPT"
  linodes         = [linode_instance.hub.id]
  tags            = ["toon", "hub"]

  inbound {
    label    = "allow-ssh"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = "22"
    ipv4     = [var.allowed_ssh_cidr]
  }

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
