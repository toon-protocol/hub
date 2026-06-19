# Persistent Block Storage volume — the durable root of the hub's identity.
# Attaching it here makes it available to cloud-init, which formats it on first boot
# (only if unformatted) and mounts it at /mnt/townhouse. Detaching/recreating the
# instance and re-attaching this volume preserves wallet.enc + config + .anon.
#
# IMPORTANT: this volume is the single source of truth for the treasury wallet and the
# hidden-service identity. Snapshot it before destroying anything.

resource "linode_volume" "hub_data" {
  label     = local.volume_label
  region    = var.region
  size      = var.volume_size
  linode_id = linode_instance.hub.id
  tags      = ["toon", "hub"]
}
